import { and, eq, inArray, isNotNull, isNull, lt, ne } from 'drizzle-orm';
import { agendaItems, agendaNotifications, pushSubscriptions, user, workspaceMembers } from '../../db/schema';
import type { Db } from '../auth/hooks';
import { formatDate } from '../date-format';
import { t } from '../../i18n/messages';
import { DEFAULT_LOCALE, isSupportedLocale } from '../locale';
import { sendPush, type VapidConfig } from '../push/webpush';
import { formatMinor } from '../money-format';
import { WRITE_ROLES } from '../http';
import { addDays } from '../spending/statement';
import { suggestedCardPayments } from './card-payments';
import { projectRecurring } from './compute';
import { sendReminder } from './kapso';
import { anchorDays, idsWithChild } from './repo';
import { signItemToken, type WhatsappConfig } from './whatsapp';

type Offset = '7d' | '2d';

/** Día de calendario (`YYYY-MM-DD`) en Ciudad de México. */
export function mexicoCityToday(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(now);
}

/** Aviso que toca hoy para un pago con esa fecha: a 7 o a 2 días; cualquier otra distancia, ninguno. */
export function reminderOffset(todayISO: string, dueDate: string): Offset | null {
  if (dueDate === addDays(todayISO, 7)) return '7d';
  if (dueDate === addDays(todayISO, 2)) return '2d';
  return null;
}

interface Target {
  itemKey: string;
  description: string;
  amountMinor: number;
  currency: string;
  dueDate: string;
  offset: Offset;
}

/**
 * Pagos pendientes de un espacio que vencen en hoy+7 u hoy+2: los guardados, los de tarjeta aún no materializados y
 * las ocurrencias proyectadas de series pendientes (clave `proj:<id>:<fecha>`, igual que en la página).
 */
async function targetsFor(db: Db, workspaceId: string, today: string): Promise<Target[]> {
  const dates = [addDays(today, 7), addDays(today, 2)];
  const months = [...new Set(dates.map((date) => date.slice(0, 7)))];
  const [items, suggestions, series] = await Promise.all([
    db.select().from(agendaItems).where(and(eq(agendaItems.workspaceId, workspaceId), eq(agendaItems.kind, 'payable'), inArray(agendaItems.dueDate, dates))),
    Promise.all(months.map((month) => suggestedCardPayments(db, workspaceId, month, today))),
    // Solo una serie que vence antes de hoy+7 puede tener una ocurrencia proyectada en las fechas del aviso.
    db.select().from(agendaItems).where(and(eq(agendaItems.workspaceId, workspaceId), eq(agendaItems.kind, 'payable'), eq(agendaItems.status, 'pending'), ne(agendaItems.recurrence, 'none'), lt(agendaItems.dueDate, dates[0]!))),
  ]);
  const [anchors, withChild] = await Promise.all([anchorDays(db, workspaceId, series), idsWithChild(db, workspaceId, series.map((item) => item.id))]);
  const projected = projectRecurring(
    series.filter((item) => !withChild.has(item.id)).map((item) => ({ ...item, key: item.id, anchorDay: anchors.get(item.id)! })),
    dates[0]!,
  ).map((entry) => ({ ...entry, itemKey: entry.key }));
  // Un sugerido ya guardado (cualquier estado) lo reemplaza su registro, como en la página.
  const materialized = new Set(items.filter((item) => item.cardId).map((item) => `${item.cardId}:${item.dueDate}`));
  const stored = items.filter((item) => item.status === 'pending').map((item) => ({ ...item, itemKey: item.id }));
  const suggested = suggestions.flat().filter((s) => !materialized.has(`${s.cardId}:${s.dueDate}`)).map((s) => ({ ...s, itemKey: s.key }));
  return [...stored, ...suggested, ...projected].flatMap((t) => {
    const offset = reminderOffset(today, t.dueDate);
    return offset ? [{ itemKey: t.itemKey, description: t.description, amountMinor: t.amountMinor, currency: t.currency, dueDate: t.dueDate, offset }] : [];
  });
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

type Counts = { sent: number; failed: number; skipped: number; errors: number };
type Channel = 'whatsapp' | 'push';
type SendResult = { ok: true; messageId?: string | null } | { ok: false; error: string };
interface Recipient {
  workspaceId: string;
  userId: string;
  locale: string;
}

/**
 * Corrida diaria de un canal: un aviso por pago, destinatario, anticipación y canal; nunca se repite uno ya enviado.
 * Un error en un espacio o en un aviso se cuenta en `errors` y no detiene lo demás.
 */
async function deliver<R extends Recipient>(db: Db, channel: Channel, recipients: R[], now: Date, send: (target: Target, recipient: R) => Promise<SendResult>): Promise<Counts> {
  const counts = { sent: 0, failed: 0, skipped: 0, errors: 0 };
  const today = mexicoCityToday(now);
  for (const workspaceId of new Set(recipients.map((r) => r.workspaceId))) {
    try {
      const members = recipients.filter((r) => r.workspaceId === workspaceId);
      for (const target of await targetsFor(db, workspaceId, today)) {
        for (const recipient of members) {
          try {
            await remind(db, channel, counts, workspaceId, target, recipient.userId, () => send(target, recipient));
          } catch (error) {
            counts.errors++;
            console.error(`recordatorios (${channel}): aviso falló`, workspaceId, target.itemKey, target.offset, message(error));
          }
        }
      }
    } catch (error) {
      counts.errors++;
      console.error(`recordatorios (${channel}): espacio falló`, workspaceId, message(error));
    }
  }
  return counts;
}

/** Avisos por WhatsApp, con el botón "Ya lo pagué". */
export async function runReminders(db: Db, cfg: WhatsappConfig, now: Date, fetchFn: typeof fetch = fetch): Promise<Counts> {
  const recipients = await db
    .select({ workspaceId: workspaceMembers.workspaceId, userId: user.id, phone: user.whatsappPhone, locale: user.locale })
    .from(workspaceMembers)
    .innerJoin(user, eq(user.id, workspaceMembers.userId))
    // Solo quien puede registrar el pago: un lector no podría usar el botón "Ya lo pagué".
    .where(and(isNull(user.deletedAt), isNotNull(user.whatsappVerifiedAt), eq(user.whatsappOptIn, true), isNotNull(user.whatsappPhone), inArray(workspaceMembers.role, WRITE_ROLES)));
  if (recipients.length === 0) return { sent: 0, failed: 0, skipped: 0, errors: 0 };
  return deliver(db, 'whatsapp', recipients, now, async (target, recipient) =>
    sendReminder(cfg, recipient.phone!, {
      description: target.description,
      amount: formatMinor(target.amountMinor, target.currency, recipient.locale),
      date: formatDate(target.dueDate, recipient.locale),
      buttonPayload: await signItemToken(cfg.webhookSecret, target.itemKey),
    }, fetchFn),
  );
}

/**
 * Notificaciones push a cada navegador suscrito del usuario. Cuenta como enviado si llegó a alguno; las suscripciones
 * que el servicio da por muertas (404/410) se borran.
 */
export async function runPushReminders(db: Db, cfg: VapidConfig, now: Date, fetchFn: typeof fetch = fetch): Promise<Counts> {
  const subscriptions = await db.select().from(pushSubscriptions);
  if (subscriptions.length === 0) return { sent: 0, failed: 0, skipped: 0, errors: 0 };
  const recipients = await db
    .select({ workspaceId: workspaceMembers.workspaceId, userId: user.id, locale: user.locale })
    .from(workspaceMembers)
    .innerJoin(user, eq(user.id, workspaceMembers.userId))
    // Los mismos destinatarios que WhatsApp: quien puede registrar el pago.
    .where(and(inArray(user.id, [...new Set(subscriptions.map((s) => s.userId))]), inArray(workspaceMembers.role, WRITE_ROLES)));
  return deliver(db, 'push', recipients, now, async (target, recipient) => {
    const locale = isSupportedLocale(recipient.locale) ? recipient.locale : DEFAULT_LOCALE;
    const push = {
      title: t(locale, target.offset === '7d' ? 'push.reminder.title7d' : 'push.reminder.title2d', { description: target.description }),
      body: t(locale, 'push.reminder.body', { amount: formatMinor(target.amountMinor, target.currency, locale), date: formatDate(target.dueDate, locale) }),
      url: `/app/agenda?mes=${target.dueDate.slice(0, 7)}`,
      tag: `${target.itemKey}:${target.offset}`,
    };
    const errors: string[] = [];
    for (const sub of subscriptions.filter((s) => s.userId === recipient.userId)) {
      const result = await sendPush(cfg, sub, push, now, fetchFn);
      if (result.ok) return { ok: true };
      errors.push(result.error);
      if (result.gone) await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id));
    }
    return { ok: false, error: errors.join(' | ') || 'sin suscripciones' };
  });
}

async function remind(db: Db, channel: Channel, counts: Omit<Counts, 'errors'>, workspaceId: string, target: Target, userId: string, send: () => Promise<SendResult>): Promise<void> {
  const where = and(
    eq(agendaNotifications.workspaceId, workspaceId),
    eq(agendaNotifications.itemKey, target.itemKey),
    eq(agendaNotifications.userId, userId),
    eq(agendaNotifications.offset, target.offset),
    eq(agendaNotifications.channel, channel),
  );
  // Primero la fila (idempotencia). Si ya existía, solo se reintenta la que falló y nunca se envió; el UPDATE
  // condicional la "reclama" para que dos corridas simultáneas no la manden las dos. El offset se recalcula con "hoy",
  // así que un aviso de 7 días solo se reintenta el mismo día. Sin envío ni error (corrida en curso o que murió a
  // medias) se salta para no mandar dos veces.
  const inserted = await db
    .insert(agendaNotifications)
    .values({ workspaceId, itemKey: target.itemKey, userId, offset: target.offset, channel })
    .onConflictDoNothing()
    .returning({ id: agendaNotifications.id });
  if (inserted.length === 0) {
    const claimed = await db
      .update(agendaNotifications)
      .set({ error: null })
      .where(and(where, isNotNull(agendaNotifications.error), isNull(agendaNotifications.sentAt)))
      .returning({ id: agendaNotifications.id });
    if (claimed.length === 0) {
      counts.skipped++;
      return;
    }
  }

  const result = await send();
  if (result.ok) {
    await db.update(agendaNotifications).set({ sentAt: new Date(), kapsoMessageId: result.messageId ?? null, error: null }).where(where);
    counts.sent++;
  } else {
    await db.update(agendaNotifications).set({ error: result.error.slice(0, 500) }).where(where);
    counts.failed++;
  }
}
