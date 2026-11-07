import { and, eq, inArray, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm';
import { agendaItems, agendaNotifications, importBatches, pushSubscriptions, user, workspaceMembers } from '../../db/schema';
import type { AccountWithCards } from '../accounts/repo';
import type { Db } from '../auth/hooks';
import { DEFAULT_TIME_ZONE, formatDate, isTimeZone, todayISO } from '../date-format';
import { lastCutoffDate } from '../cutoff';
import { t, tn } from '../../i18n/messages';
import { DEFAULT_LOCALE, isSupportedLocale } from '../locale';
import { sendPush, type VapidConfig } from '../push/webpush';
import { formatMinor } from '../money-format';
import { WRITE_ROLES } from '../http';
import { addDays } from '../spending/statement';
import { suggestedCardPayments } from './card-payments';
import { projectRecurring } from './compute';
import { duePayables, loadAgendaMonth } from './month';
import { sendReminder } from './kapso';
import { anchorDays, idsWithChild } from './repo';
import { signItemToken, type WhatsappConfig } from './whatsapp';

/** Pago a 7 o 2 días o el mismo día; `overdue` = resumen diario de vencidos; `cutoff` = cargar el CSV tras el corte. */
type Offset = '7d' | '2d' | '0d' | 'overdue' | 'cutoff';

/** Hora local a la que salen los avisos. El cron corre cada hora y a cada persona le toca cuando en su zona son las 9. */
export const SEND_HOUR = 9;

/** Hora (0-23) en esa zona. */
export function localHour(now: Date, timeZone: string): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(now));
}

const zoneOf = (timeZone: string | null | undefined) => (isTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE);

/** Aviso que toca hoy para un pago con esa fecha: a 7 o a 2 días, o el mismo día; cualquier otra distancia, ninguno. */
export function reminderOffset(todayISO: string, dueDate: string): '7d' | '2d' | '0d' | null {
  if (dueDate === addDays(todayISO, 7)) return '7d';
  if (dueDate === addDays(todayISO, 2)) return '2d';
  if (dueDate === todayISO) return '0d';
  return null;
}

interface Target {
  itemKey: string;
  description: string;
  amountMinor: number;
  currency: string;
  dueDate: string;
  offset: Offset;
  /** Solo en `overdue`: cuántos pagos vencidos hay. */
  count?: number;
}

/**
 * Pagos pendientes de un espacio que vencen en hoy+7, hoy+2 u hoy: los guardados, los de tarjeta aún no materializados y
 * las ocurrencias proyectadas de series pendientes (clave `proj:<id>:<fecha>`, igual que en la página).
 */
async function targetsFor(db: Db, workspaceId: string, today: string): Promise<Target[]> {
  const dates = [addDays(today, 7), addDays(today, 2), today];
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

/**
 * Cuentas con tarjeta de crédito cuyo corte (según el día de corte de la tarjeta) fue ayer y que aún no tienen un CSV
 * cargado hasta esa fecha: el estado de cuenta ya está disponible para descargarlo.
 */
async function cutoffTargets(db: Db, workspaceId: string, today: string, accounts: AccountWithCards[]): Promise<Target[]> {
  const yesterday = addDays(today, -1);
  const due = accounts.flatMap((account) => {
    const cutoffs = new Set(account.cards.filter((c) => c.kind === 'credit' && !c.archivedAt && c.cutoffDay).map((c) => lastCutoffDate(c.cutoffDay!, yesterday)));
    return cutoffs.has(yesterday) ? [account] : [];
  });
  if (due.length === 0) return [];
  // Hasta qué día cubre la última carga de cada cuenta (su fecha de corte o, si no la capturó, el día de la carga).
  const loaded = await db
    .select({ accountId: importBatches.accountId, upTo: sql<string>`max(coalesce(${importBatches.cutoffDate}, date(${importBatches.createdAt} / 1000, 'unixepoch')))` })
    .from(importBatches)
    .where(and(eq(importBatches.workspaceId, workspaceId), inArray(importBatches.accountId, due.map((a) => a.id)), eq(importBatches.status, 'applied'), eq(importBatches.source, 'csv')))
    .groupBy(importBatches.accountId);
  const upTo = new Map(loaded.map((row) => [row.accountId, row.upTo]));
  return due
    .filter((account) => !(upTo.get(account.id) && upTo.get(account.id)! >= yesterday))
    .map((account) => ({ itemKey: `cutoff:${account.id}:${yesterday}`, description: account.name, amountMinor: 0, currency: '', dueDate: yesterday, offset: 'cutoff' as const }));
}

/** Todo lo que puede avisarse por push hoy: pagos (7, 2 y 0 días), el resumen de vencidos y los cortes por cargar. */
async function pushTargetsFor(db: Db, workspaceId: string, today: string): Promise<Target[]> {
  const [payments, agenda] = await Promise.all([targetsFor(db, workspaceId, today), loadAgendaMonth(db, workspaceId, today.slice(0, 7), today)]);
  // Mismo criterio que la banda de la app; un solo aviso al día por persona, no uno por pago.
  const overdue = duePayables(agenda.entries, today).overdue.length;
  const summary: Target[] = overdue > 0 ? [{ itemKey: `overdue:${today}`, description: '', amountMinor: 0, currency: '', dueDate: today, offset: 'overdue', count: overdue }] : [];
  return [...payments, ...summary, ...(await cutoffTargets(db, workspaceId, today, agenda.accounts))];
}

/** Título, texto y destino de cada tipo de aviso push. */
function pushMessage(target: Target, locale: Parameters<typeof t>[0]) {
  const tag = `${target.itemKey}:${target.offset}`;
  if (target.offset === 'overdue') return { title: t(locale, 'push.overdue.title'), body: tn(locale, 'push.overdue.body', target.count ?? 0), url: '/app/agenda', tag };
  if (target.offset === 'cutoff') {
    const accountId = target.itemKey.split(':')[1];
    return { title: t(locale, 'push.cutoff.title', { account: target.description }), body: t(locale, 'push.cutoff.body', { date: formatDate(target.dueDate, locale) }), url: `/app/importar?cuenta=${accountId}`, tag };
  }
  const titleKey = target.offset === '7d' ? 'push.reminder.title7d' : target.offset === '2d' ? 'push.reminder.title2d' : 'push.reminder.title0d';
  return {
    title: t(locale, titleKey, { description: target.description }),
    body: t(locale, 'push.reminder.body', { amount: formatMinor(target.amountMinor, target.currency, locale), date: formatDate(target.dueDate, locale) }),
    url: `/app/agenda?mes=${target.dueDate.slice(0, 7)}`,
    tag,
  };
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

type Counts = { sent: number; failed: number; skipped: number; errors: number };
type Channel = 'whatsapp' | 'push';
type SendResult = { ok: true; messageId?: string | null } | { ok: false; error: string };
interface Recipient {
  workspaceId: string;
  userId: string;
  locale: string;
  timeZone: string | null;
}

/**
 * Corrida de un canal (cada hora): solo para quien en su zona son las `SEND_HOUR`, con el "hoy" de su zona. Un aviso
 * por pago, destinatario, tipo y canal; nunca se repite uno ya enviado. Un error en un espacio o en un aviso se cuenta
 * en `errors` y no detiene lo demás.
 */
async function deliver<R extends Recipient>(
  db: Db,
  channel: Channel,
  recipients: R[],
  now: Date,
  targets: (workspaceId: string, today: string) => Promise<Target[]>,
  send: (target: Target, recipient: R) => Promise<SendResult>,
): Promise<Counts> {
  const counts = { sent: 0, failed: 0, skipped: 0, errors: 0 };
  // Espacio + día local: dos miembros en zonas distintas pueden estar en días distintos.
  const groups = new Map<string, { workspaceId: string; today: string; members: R[] }>();
  for (const recipient of recipients) {
    const zone = zoneOf(recipient.timeZone);
    if (localHour(now, zone) !== SEND_HOUR) continue;
    const today = todayISO(zone, now);
    const key = `${recipient.workspaceId}|${today}`;
    if (!groups.has(key)) groups.set(key, { workspaceId: recipient.workspaceId, today, members: [] });
    groups.get(key)!.members.push(recipient);
  }
  for (const { workspaceId, today, members } of groups.values()) {
    try {
      for (const target of await targets(workspaceId, today)) {
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
    .select({ workspaceId: workspaceMembers.workspaceId, userId: user.id, phone: user.whatsappPhone, locale: user.locale, timeZone: user.timeZone })
    .from(workspaceMembers)
    .innerJoin(user, eq(user.id, workspaceMembers.userId))
    // Solo quien puede registrar el pago: un lector no podría usar el botón "Ya lo pagué".
    .where(and(isNull(user.deletedAt), isNotNull(user.whatsappVerifiedAt), eq(user.whatsappOptIn, true), isNotNull(user.whatsappPhone), inArray(workspaceMembers.role, WRITE_ROLES)));
  if (recipients.length === 0) return { sent: 0, failed: 0, skipped: 0, errors: 0 };
  // La plantilla de WhatsApp es de pago próximo: solo los avisos a 7 y 2 días.
  const upcoming = async (workspaceId: string, today: string) => (await targetsFor(db, workspaceId, today)).filter((target) => target.offset !== '0d');
  return deliver(db, 'whatsapp', recipients, now, upcoming, async (target, recipient) =>
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
    .select({ workspaceId: workspaceMembers.workspaceId, userId: user.id, locale: user.locale, timeZone: user.timeZone })
    .from(workspaceMembers)
    .innerJoin(user, eq(user.id, workspaceMembers.userId))
    // Los mismos destinatarios que WhatsApp: quien puede registrar el pago y no borró su cuenta.
    .where(and(isNull(user.deletedAt), inArray(user.id, [...new Set(subscriptions.map((s) => s.userId))]), inArray(workspaceMembers.role, WRITE_ROLES)));
  return deliver(db, 'push', recipients, now, (workspaceId, today) => pushTargetsFor(db, workspaceId, today), async (target, recipient) => {
    const locale = isSupportedLocale(recipient.locale) ? recipient.locale : DEFAULT_LOCALE;
    const push = pushMessage(target, locale);
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
