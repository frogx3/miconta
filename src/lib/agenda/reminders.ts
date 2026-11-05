import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
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

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Corrida diaria: un aviso por pago, destinatario y anticipación; nunca se repite uno ya enviado. Un error en un
 * espacio o en un aviso se cuenta en `errors` y no detiene lo demás.
 */
export async function runReminders(db: Db, cfg: WhatsappConfig, now: Date, fetchFn: typeof fetch = fetch): Promise<{ sent: number; failed: number; skipped: number; errors: number }> {
  const counts = { sent: 0, failed: 0, skipped: 0, errors: 0 };
  const recipients = await db
    .select({ workspaceId: workspaceMembers.workspaceId, userId: user.id, phone: user.whatsappPhone, locale: user.locale })
    .from(workspaceMembers)
    .innerJoin(user, eq(user.id, workspaceMembers.userId))
    .where(and(isNotNull(user.whatsappVerifiedAt), eq(user.whatsappOptIn, true), isNotNull(user.whatsappPhone)));
  if (recipients.length === 0) return counts;

  const today = mexicoCityToday(now);
  for (const workspaceId of new Set(recipients.map((r) => r.workspaceId))) {
    try {
      const members = recipients.filter((r) => r.workspaceId === workspaceId);
      for (const target of await targetsFor(db, workspaceId, today)) {
        const buttonPayload = await signItemToken(cfg.webhookSecret, target.itemKey);
        for (const recipient of members) {
          try {
            await remind(db, cfg, fetchFn, counts, workspaceId, target, recipient, buttonPayload);
          } catch (error) {
            counts.errors++;
            console.error('recordatorios: aviso falló', workspaceId, target.itemKey, target.offset, message(error));
          }
        }
      }
    } catch (error) {
      counts.errors++;
      console.error('recordatorios: espacio falló', workspaceId, message(error));
    }
  }
  return counts;
}

async function remind(
  db: Db,
  cfg: WhatsappConfig,
  fetchFn: typeof fetch,
  counts: { sent: number; failed: number; skipped: number },
  workspaceId: string,
  target: Target,
  recipient: { userId: string; phone: string | null; locale: string },
  buttonPayload: string,
): Promise<void> {
  const where = and(eq(agendaNotifications.workspaceId, workspaceId), eq(agendaNotifications.itemKey, target.itemKey), eq(agendaNotifications.userId, recipient.userId), eq(agendaNotifications.offset, target.offset));
  // Primero la fila (idempotencia). Si ya existía, solo se reintenta la que falló y nunca se envió; el UPDATE
  // condicional la "reclama" para que dos corridas simultáneas no la manden las dos. El offset se recalcula con "hoy",
  // así que un aviso de 7 días solo se reintenta el mismo día. Sin envío ni error (corrida en curso o que murió a
  // medias) se salta para no mandar dos veces.
  const inserted = await db
    .insert(agendaNotifications)
    .values({ workspaceId, itemKey: target.itemKey, userId: recipient.userId, offset: target.offset })
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
