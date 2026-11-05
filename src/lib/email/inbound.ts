import { and, desc, eq, gte, isNull, like, lte } from 'drizzle-orm';
import { cards, categoryRules, emailInboxes, emailMessages, movements } from '../../db/schema';
import type { Db } from '../auth/hooks';
import { addDays } from '../spending/statement';
import { normalizeDescription } from '../import/text';
import { parseMoney } from '../import/money';
import { currencyDigits } from '../money-format';
import { matchCategory } from '../spending/categorize';
import { ownBatchId } from '../spending/manual';
import { classifyEmail, isTrusted, normalizeReference, trustableDomain, type EmailNotice } from './notice';

export type Inbox = typeof emailInboxes.$inferSelect;
export type EmailStatus = (typeof emailMessages.$inferSelect)['status'];

/** Un aviso y un movimiento ya guardado son el mismo cargo si coinciden tarjeta, monto y referencia en ±5 días. */
const MATCH_DAYS = 5;

/** 26 caracteres en base32 minúscula (130 bits): la dirección es el secreto, así que no debe adivinarse. */
export function newToken(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  const bytes = crypto.getRandomValues(new Uint8Array(26));
  return Array.from(bytes, (b) => alphabet[b & 31]).join('');
}

export const inboxAddress = (token: string, domain: string) => `${token}@${domain}`;

export async function getInbox(db: Db, workspaceId: string, accountId: string): Promise<Inbox | null> {
  const [row] = await db.select().from(emailInboxes).where(and(eq(emailInboxes.workspaceId, workspaceId), eq(emailInboxes.accountId, accountId))).limit(1);
  return row ?? null;
}

/** Activa la dirección de una cuenta, o le da una nueva (la anterior deja de recibir). */
export async function enableInbox(db: Db, workspaceId: string, accountId: string, userId: string, regenerate: boolean): Promise<Inbox> {
  const existing = await getInbox(db, workspaceId, accountId);
  if (!existing) {
    const [row] = await db.insert(emailInboxes).values({ workspaceId, accountId, token: newToken(), createdBy: userId }).returning();
    return row!;
  }
  const [row] = await db
    .update(emailInboxes)
    .set({ disabledAt: null, ...(regenerate ? { token: newToken() } : {}) })
    .where(eq(emailInboxes.id, existing.id))
    .returning();
  return row!;
}

export async function disableInbox(db: Db, workspaceId: string, accountId: string): Promise<void> {
  await db.update(emailInboxes).set({ disabledAt: new Date() }).where(and(eq(emailInboxes.workspaceId, workspaceId), eq(emailInboxes.accountId, accountId)));
}

export async function listMessages(db: Db, inboxId: string, limit = 30) {
  return db.select().from(emailMessages).where(eq(emailMessages.inboxId, inboxId)).orderBy(desc(emailMessages.receivedAt)).limit(limit);
}

export interface IncomingEmail {
  /** Parte local de la dirección destino: el token del buzón. */
  token: string;
  messageKey: string;
  fromAddress: string;
  subject: string;
  text: string;
  dkimDomains: string[];
  raw: ArrayBuffer;
}

/**
 * Procesa un correo recibido. Devuelve `rejected` si la dirección no existe o está desactivada (el servidor
 * de correo lo rebota); en otro caso queda en la bitácora con lo que se hizo.
 */
export async function receiveEmail(db: Db, bucket: R2Bucket, email: IncomingEmail): Promise<EmailStatus | 'rejected' | 'repeated'> {
  const [inbox] = await db.select().from(emailInboxes).where(eq(emailInboxes.token, email.token)).limit(1);
  if (!inbox || inbox.disabledAt) return 'rejected';

  const [seen] = await db.select({ id: emailMessages.id }).from(emailMessages).where(and(eq(emailMessages.inboxId, inbox.id), eq(emailMessages.messageKey, email.messageKey))).limit(1);
  if (seen) return 'repeated';

  const classified = classifyEmail(email);
  const id = crypto.randomUUID();
  let status: EmailStatus;
  let data: unknown = null;
  let movementId: string | null = null;
  let rawKey: string | null = null;

  if (classified.kind === 'confirmation') {
    status = 'confirmation';
    data = { code: classified.code };
  } else if (classified.kind === 'unparsed') {
    status = 'unparsed';
    // Se guarda solo lo que no se pudo leer, para afinar el lector; se borra al descartarlo.
    rawKey = `email/unparsed/${inbox.workspaceId}/${id}.eml`;
    await bucket.put(rawKey, email.raw, { httpMetadata: { contentType: 'message/rfc822' } });
  } else {
    data = classified.notice;
    if (!isTrusted(email.fromAddress, email.dkimDomains, inbox.trustedDomains)) status = 'review';
    else ({ status, movementId } = await applyNotice(db, inbox, classified.notice));
  }

  await db.batch([
    db.insert(emailMessages).values({
      id,
      workspaceId: inbox.workspaceId,
      inboxId: inbox.id,
      messageKey: email.messageKey,
      fromAddress: email.fromAddress.slice(0, 200),
      subject: email.subject.slice(0, 300),
      dkimDomains: email.dkimDomains,
      status,
      data,
      movementId,
      rawKey,
    }),
    db.update(emailInboxes).set({ lastReceivedAt: new Date() }).where(eq(emailInboxes.id, inbox.id)),
  ]);
  return status;
}

/**
 * Registra el movimiento de un aviso: busca la tarjeta por terminación, descarta duplicados (mismo cargo ya
 * recibido o importado del CSV) y aplica las reglas de categoría.
 */
export async function applyNotice(db: Db, inbox: Inbox, notice: EmailNotice): Promise<{ status: 'applied' | 'duplicate' | 'unknown_card'; movementId: string | null }> {
  const [card] = await db
    .select()
    .from(cards)
    .where(and(eq(cards.accountId, inbox.accountId), eq(cards.last4, notice.last4), isNull(cards.archivedAt)))
    .limit(1);
  if (!card) return { status: 'unknown_card', movementId: null };

  const amountMinor = parseMoney(notice.amount, { decimalSeparator: '.', thousandsSeparator: '', minorDigits: currencyDigits(card.currency) ?? 2 });
  if (!amountMinor || amountMinor <= 0) return { status: 'unknown_card', movementId: null };
  const chargeMinor = notice.kind === 'charge' ? amountMinor : 0;
  const creditMinor = notice.kind === 'credit' ? amountMinor : 0;
  const reference = normalizeReference(notice.reference);

  if (reference) {
    const candidates = await db
      .select({ id: movements.id, reference: movements.reference })
      .from(movements)
      .where(
        and(
          eq(movements.accountId, inbox.accountId),
          eq(movements.chargeMinor, chargeMinor),
          eq(movements.creditMinor, creditMinor),
          gte(movements.date, addDays(notice.date, -MATCH_DAYS)),
          lte(movements.date, addDays(notice.date, MATCH_DAYS)),
        ),
      );
    const same = candidates.find((m) => normalizeReference(m.reference) === reference);
    if (same) return { status: 'duplicate', movementId: same.id };
  }

  const descriptionNorm = normalizeDescription(notice.merchant);
  const rules = notice.kind === 'charge' ? await db.select({ categoryId: categoryRules.categoryId, pattern: categoryRules.pattern }).from(categoryRules).where(eq(categoryRules.workspaceId, inbox.workspaceId)) : [];
  const batchId = await ownBatchId(db, inbox.workspaceId, inbox.accountId, inbox.createdBy, 'email');
  const uniqueKey = reference ? `email:${card.id}:${reference}:${chargeMinor}:${creditMinor}` : `email:${crypto.randomUUID()}`;

  const [row] = await db
    .insert(movements)
    .values({
      workspaceId: inbox.workspaceId,
      accountId: inbox.accountId,
      cardId: card.id,
      batchId,
      uniqueKey,
      date: notice.date,
      description: notice.merchant,
      descriptionNorm,
      reference: notice.reference,
      chargeMinor,
      creditMinor,
      currency: card.currency,
      categoryId: matchCategory(descriptionNorm, rules),
    })
    .onConflictDoNothing()
    .returning({ id: movements.id });
  if (row) return { status: 'applied', movementId: row.id };
  const [existing] = await db.select({ id: movements.id }).from(movements).where(and(eq(movements.accountId, inbox.accountId), eq(movements.uniqueKey, uniqueKey))).limit(1);
  return { status: 'duplicate', movementId: existing?.id ?? null };
}

export type ReviewResult = { ok: true; status: EmailStatus } | { ok: false; code: 'NOT_FOUND' | 'NOT_PENDING' };

/**
 * Decisión del usuario sobre un correo pendiente: aplicarlo (opcionalmente confiando en su dominio para los
 * siguientes) o descartarlo. Un aviso con tarjeta desconocida se puede volver a aplicar tras dar de alta la tarjeta.
 */
export async function reviewMessage(db: Db, bucket: R2Bucket, workspaceId: string, messageId: string, action: 'apply' | 'dismiss', trustDomain: boolean): Promise<ReviewResult> {
  const [message] = await db.select().from(emailMessages).where(and(eq(emailMessages.id, messageId), eq(emailMessages.workspaceId, workspaceId))).limit(1);
  if (!message) return { ok: false, code: 'NOT_FOUND' };
  const pending = message.status === 'review' || message.status === 'unknown_card' || message.status === 'unparsed';
  if (!pending) return { ok: false, code: 'NOT_PENDING' };

  if (action === 'dismiss') {
    if (message.rawKey) await bucket.delete(message.rawKey);
    await db.update(emailMessages).set({ status: 'dismissed', rawKey: null }).where(eq(emailMessages.id, message.id));
    return { ok: true, status: 'dismissed' };
  }
  if (message.status === 'unparsed' || !message.data) return { ok: false, code: 'NOT_PENDING' };

  let [inbox] = await db.select().from(emailInboxes).where(eq(emailInboxes.id, message.inboxId)).limit(1);
  const domain = trustDomain ? trustableDomain(message.fromAddress, message.dkimDomains) : null;
  if (inbox && domain && !inbox.trustedDomains.includes(domain)) {
    [inbox] = await db.update(emailInboxes).set({ trustedDomains: [...inbox.trustedDomains, domain] }).where(eq(emailInboxes.id, inbox.id)).returning();
  }
  if (!inbox) return { ok: false, code: 'NOT_FOUND' };

  const result = await applyNotice(db, inbox, message.data as EmailNotice);
  await db.update(emailMessages).set({ status: result.status, movementId: result.movementId }).where(eq(emailMessages.id, message.id));
  return { ok: true, status: result.status };
}

/**
 * Referencias de avisos por correo ya registrados en una cuenta, para que el importador de CSV no duplique
 * esos cargos. Llave: `${referencia normalizada}|${cargo}|${abono}`.
 */
export async function emailReferenceKeys(db: Db, accountId: string, from: string, to: string): Promise<Set<string>> {
  const rows = await db
    .select({ reference: movements.reference, chargeMinor: movements.chargeMinor, creditMinor: movements.creditMinor })
    .from(movements)
    .where(and(eq(movements.accountId, accountId), like(movements.uniqueKey, 'email:%'), gte(movements.date, addDays(from, -MATCH_DAYS)), lte(movements.date, addDays(to, MATCH_DAYS))));
  const keys = new Set<string>();
  for (const row of rows) {
    const reference = normalizeReference(row.reference);
    if (reference) keys.add(`${reference}|${row.chargeMinor}|${row.creditMinor}`);
  }
  return keys;
}
