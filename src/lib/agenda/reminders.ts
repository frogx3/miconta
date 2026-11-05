import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { agendaItems, agendaNotifications, user, workspaceMembers } from '../../db/schema';
import type { Db } from '../auth/hooks';
import { formatDate } from '../date-format';
import { formatMinor } from '../money-format';
import { addDays } from '../spending/statement';
import { suggestedCardPayments } from './card-payments';
import { sendReminder } from './kapso';
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

/**
 * Qué hacer con un aviso que ya tenía fila: enviado → nunca otra vez; con error → reintentar (el offset se recalcula
 * con "hoy", así que solo se reintenta mientras la fecha objetivo siga vigente). Sin envío ni error es otra corrida en
 * curso (o una que murió a medias): se salta para no mandar dos veces.
 */
export function existingAction(row: { sentAt: Date | null; error: string | null }): 'skip' | 'retry' {
  return !row.sentAt && row.error ? 'retry' : 'skip';
}

interface Target {
  itemKey: string;
  description: string;
  amountMinor: number;
  currency: string;
  dueDate: string;
  offset: Offset;
}

/** Pagos pendientes de un espacio que vencen en hoy+7 u hoy+2: los guardados y los de tarjeta aún no materializados. */
async function targetsFor(db: Db, workspaceId: string, today: string): Promise<Target[]> {
  const dates = [addDays(today, 7), addDays(today, 2)];
  const months = [...new Set(dates.map((date) => date.slice(0, 7)))];
  const [items, suggestions] = await Promise.all([
    db.select().from(agendaItems).where(and(eq(agendaItems.workspaceId, workspaceId), eq(agendaItems.kind, 'payable'), inArray(agendaItems.dueDate, dates))),
    Promise.all(months.map((month) => suggestedCardPayments(db, workspaceId, month, today))),
  ]);
  // Un sugerido ya guardado (cualquier estado) lo reemplaza su registro, como en la página.
  const materialized = new Set(items.filter((item) => item.cardId).map((item) => `${item.cardId}:${item.dueDate}`));
  const stored = items.filter((item) => item.status === 'pending').map((item) => ({ ...item, itemKey: item.id }));
  const suggested = suggestions.flat().filter((s) => !materialized.has(`${s.cardId}:${s.dueDate}`)).map((s) => ({ ...s, itemKey: s.key }));
  return [...stored, ...suggested].flatMap((t) => {
    const offset = reminderOffset(today, t.dueDate);
    return offset ? [{ itemKey: t.itemKey, description: t.description, amountMinor: t.amountMinor, currency: t.currency, dueDate: t.dueDate, offset }] : [];
  });
}

/** Corrida diaria: un aviso por pago, destinatario y anticipación; nunca se repite uno ya enviado. */
export async function runReminders(db: Db, cfg: WhatsappConfig, now: Date, fetchFn: typeof fetch = fetch): Promise<{ sent: number; failed: number; skipped: number }> {
  const counts = { sent: 0, failed: 0, skipped: 0 };
  const recipients = await db
    .select({ workspaceId: workspaceMembers.workspaceId, userId: user.id, phone: user.whatsappPhone, locale: user.locale })
    .from(workspaceMembers)
    .innerJoin(user, eq(user.id, workspaceMembers.userId))
    .where(and(isNotNull(user.whatsappVerifiedAt), eq(user.whatsappOptIn, true), isNotNull(user.whatsappPhone)));
  if (recipients.length === 0) return counts;

  const today = mexicoCityToday(now);
  for (const workspaceId of new Set(recipients.map((r) => r.workspaceId))) {
    const targets = await targetsFor(db, workspaceId, today);
    for (const target of targets) {
      const buttonPayload = await signItemToken(cfg.webhookSecret, target.itemKey);
      for (const recipient of recipients.filter((r) => r.workspaceId === workspaceId)) {
        const where = and(eq(agendaNotifications.workspaceId, workspaceId), eq(agendaNotifications.itemKey, target.itemKey), eq(agendaNotifications.userId, recipient.userId), eq(agendaNotifications.offset, target.offset));
        // Primero la fila (idempotencia): si ya existía, se decide con lo que tiene.
        const inserted = await db
          .insert(agendaNotifications)
          .values({ workspaceId, itemKey: target.itemKey, userId: recipient.userId, offset: target.offset })
          .onConflictDoNothing()
          .returning({ id: agendaNotifications.id });
        if (inserted.length === 0) {
          const [existing] = await db.select({ sentAt: agendaNotifications.sentAt, error: agendaNotifications.error }).from(agendaNotifications).where(where).limit(1);
          if (!existing || existingAction(existing) === 'skip') {
            counts.skipped++;
            continue;
          }
        }

        const result = await sendReminder(cfg, recipient.phone!, {
          description: target.description,
          amount: formatMinor(target.amountMinor, target.currency, recipient.locale),
          date: formatDate(target.dueDate, recipient.locale),
          buttonPayload,
        }, fetchFn);
        if (result.ok) {
          await db.update(agendaNotifications).set({ sentAt: new Date(), kapsoMessageId: result.messageId, error: null }).where(where);
          counts.sent++;
        } else {
          await db.update(agendaNotifications).set({ error: result.error.slice(0, 500) }).where(where);
          counts.failed++;
        }
      }
    }
  }
  return counts;
}
