import { and, asc, eq, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { agendaItems, cards, cashBalances, type AgendaItem, type CashBalance } from '../../db/schema';
import type { Db } from '../auth/hooks';
import { todayISO } from '../date-format';
import { suggestedCardPayments } from './card-payments';
import { nextDueDate } from './compute';
import type { BalanceValues, ItemValues } from './validation';

/** Todas las funciones reciben el `workspaceId` y lo aplican en cada consulta. */

export interface DoneBy {
  userId: string;
  via: 'web' | 'whatsapp';
}

/** Registros con fecha en [from, to] (de cualquier estado) más los pendientes vencidos antes de `from`. */
export async function listAgenda(db: Db, workspaceId: string, range: { from: string; to: string }): Promise<AgendaItem[]> {
  return db
    .select()
    .from(agendaItems)
    .where(
      and(
        eq(agendaItems.workspaceId, workspaceId),
        or(and(gte(agendaItems.dueDate, range.from), lte(agendaItems.dueDate, range.to)), and(eq(agendaItems.status, 'pending'), lt(agendaItems.dueDate, range.from))),
      ),
    )
    .orderBy(asc(agendaItems.dueDate), asc(agendaItems.createdAt));
}

export async function getItem(db: Db, workspaceId: string, id: string): Promise<AgendaItem | null> {
  const [row] = await db.select().from(agendaItems).where(and(eq(agendaItems.id, id), eq(agendaItems.workspaceId, workspaceId))).limit(1);
  return row ?? null;
}

export async function createItem(db: Db, workspaceId: string, currency: string, value: ItemValues): Promise<string> {
  const [row] = await db.insert(agendaItems).values({ workspaceId, currency, ...value }).returning({ id: agendaItems.id });
  return row!.id;
}

/** Un pago de tarjeta guardado conserva su fecha, tipo y repetición: solo cambian descripción y monto. */
export async function updateItem(db: Db, workspaceId: string, id: string, value: ItemValues): Promise<boolean> {
  const item = await getItem(db, workspaceId, id);
  if (!item) return false;
  const set = item.cardId ? { description: value.description, amountMinor: value.amountMinor } : value;
  await db.update(agendaItems).set(set).where(and(eq(agendaItems.id, id), eq(agendaItems.workspaceId, workspaceId)));
  return true;
}

/** Cancela solo esta ocurrencia (no genera la siguiente). Solo aplica a pendientes. */
export async function cancelItem(db: Db, workspaceId: string, id: string): Promise<boolean> {
  const rows = await db
    .update(agendaItems)
    .set({ status: 'cancelled' })
    .where(and(eq(agendaItems.id, id), eq(agendaItems.workspaceId, workspaceId), eq(agendaItems.status, 'pending')))
    .returning({ id: agendaItems.id });
  return rows.length > 0;
}

/** Día ancla de una serie: el del primer registro (se sigue `previous_id` hacia atrás). */
async function anchorDay(db: Db, workspaceId: string, item: AgendaItem): Promise<number> {
  const root = await db.get<{ due_date: string }>(sql`
    WITH RECURSIVE chain(id, previous_id, due_date) AS (
      SELECT id, previous_id, due_date FROM agenda_items WHERE id = ${item.id} AND workspace_id = ${workspaceId}
      UNION ALL
      SELECT a.id, a.previous_id, a.due_date FROM agenda_items a JOIN chain c ON a.id = c.previous_id WHERE a.workspace_id = ${workspaceId}
    )
    SELECT due_date FROM chain WHERE previous_id IS NULL LIMIT 1`);
  return Number((root?.due_date ?? item.dueDate).slice(8));
}

/**
 * Día ancla de varias series a la vez (misma regla que `anchorDay`): id → día del primer registro de su serie.
 * shortcut: un solo IN (...) con todos los ids; si alguna vez pasan de ~90 (límite de parámetros de D1), partirlo.
 */
export async function anchorDays(db: Db, workspaceId: string, items: Pick<AgendaItem, 'id' | 'dueDate'>[]): Promise<Map<string, number>> {
  const days = new Map(items.map((item) => [item.id, Number(item.dueDate.slice(8))]));
  if (items.length === 0) return days;
  const ids = sql.join(items.map((item) => sql`${item.id}`), sql`, `);
  const roots = await db.all<{ origin: string; due_date: string }>(sql`
    WITH RECURSIVE chain(origin, id, previous_id, due_date) AS (
      SELECT id, id, previous_id, due_date FROM agenda_items WHERE workspace_id = ${workspaceId} AND id IN (${ids})
      UNION ALL
      SELECT c.origin, a.id, a.previous_id, a.due_date FROM agenda_items a JOIN chain c ON a.id = c.previous_id WHERE a.workspace_id = ${workspaceId}
    )
    SELECT origin, due_date FROM chain WHERE previous_id IS NULL`);
  for (const root of roots) days.set(root.origin, Number(root.due_date.slice(8)));
  return days;
}

/** Ids (de los dados) que ya generaron su siguiente ocurrencia: no son la última de su serie. */
export async function idsWithChild(db: Db, workspaceId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ previousId: agendaItems.previousId })
    .from(agendaItems)
    .where(and(eq(agendaItems.workspaceId, workspaceId), inArray(agendaItems.previousId, ids)));
  return new Set(rows.map((row) => row.previousId!));
}

/**
 * Marca un pendiente como hecho. El UPDATE condicional (status='pending') decide quién gana si dos personas lo marcan
 * a la vez; solo el ganador crea la siguiente ocurrencia, y el INSERT … WHERE NOT EXISTS evita un segundo hijo si se
 * deshizo (el hijo editado se conserva) y se volvió a marcar.
 */
export async function markDone(db: Db, workspaceId: string, id: string, by: DoneBy): Promise<'done' | 'already' | 'not_found'> {
  const [item] = await db
    .update(agendaItems)
    .set({ status: 'done', doneAt: new Date(), doneByUserId: by.userId, doneVia: by.via })
    .where(and(eq(agendaItems.id, id), eq(agendaItems.workspaceId, workspaceId), eq(agendaItems.status, 'pending')))
    .returning();
  if (!item) {
    const current = await getItem(db, workspaceId, id);
    return current?.status === 'done' ? 'already' : 'not_found';
  }
  if (item.recurrence !== 'none') {
    const dueDate = nextDueDate(item.dueDate, item.recurrence, await anchorDay(db, workspaceId, item));
    // created_at = updated_at: así `undoDone` sabe que el hijo no se ha tocado.
    const now = Date.now();
    await db.run(sql`
      INSERT INTO agenda_items (id, workspace_id, kind, description, amount_minor, currency, due_date, recurrence, status, previous_id, created_at, updated_at)
      SELECT ${crypto.randomUUID()}, ${workspaceId}, ${item.kind}, ${item.description}, ${item.amountMinor}, ${item.currency}, ${dueDate}, ${item.recurrence}, 'pending', ${item.id}, ${now}, ${now}
      WHERE NOT EXISTS (SELECT 1 FROM agenda_items WHERE previous_id = ${item.id})`);
  }
  return 'done';
}

/** Reabre un hecho y borra la ocurrencia que generó, solo si sigue pendiente y sin cambios. */
export async function undoDone(db: Db, workspaceId: string, id: string): Promise<'reopened' | 'not_done' | 'not_found'> {
  const rows = await db
    .update(agendaItems)
    .set({ status: 'pending', doneAt: null, doneByUserId: null, doneVia: null })
    .where(and(eq(agendaItems.id, id), eq(agendaItems.workspaceId, workspaceId), eq(agendaItems.status, 'done')))
    .returning({ id: agendaItems.id });
  if (rows.length === 0) return (await getItem(db, workspaceId, id)) ? 'not_done' : 'not_found';
  await db
    .delete(agendaItems)
    .where(
      and(
        eq(agendaItems.previousId, id),
        eq(agendaItems.workspaceId, workspaceId),
        eq(agendaItems.status, 'pending'),
        sql`${agendaItems.updatedAt} = ${agendaItems.createdAt}`,
      ),
    );
  return 'reopened';
}

/**
 * Guarda un pago de tarjeta sugerido (o actúa sobre el ya guardado) y aplica la acción. Si aún no existe la fila,
 * `dueDate` debe ser la de un sugerido vigente de esa tarjeta en su mes (eso ya implica tarjeta de crédito del espacio).
 * Devuelve null si no hay tal pago o la acción no aplica.
 */
export async function materializeCardPayment(
  db: Db,
  workspaceId: string,
  input: { cardId: string; dueDate: string; amountMinor?: number; action: 'adjust' | 'done' | 'cancel'; by?: DoneBy },
): Promise<{ id: string; result: 'done' | 'already' | 'saved' } | null> {
  const { cardId, dueDate, amountMinor, action, by } = input;
  if (amountMinor !== undefined && !(Number.isInteger(amountMinor) && amountMinor > 0)) return null;
  if (action === 'adjust' && amountMinor === undefined) return null;
  if (action === 'done' && !by) return null;

  const find = async () =>
    (await db.select().from(agendaItems).where(and(eq(agendaItems.workspaceId, workspaceId), eq(agendaItems.cardId, cardId), eq(agendaItems.dueDate, dueDate))).limit(1))[0];
  let row = await find();
  if (!row) {
    const suggestion = (await suggestedCardPayments(db, workspaceId, dueDate.slice(0, 7), todayISO())).find((s) => s.cardId === cardId && s.dueDate === dueDate);
    if (!suggestion) return null;
    await db
      .insert(agendaItems)
      .values({ workspaceId, kind: 'payable', description: suggestion.description, amountMinor: amountMinor ?? suggestion.amountMinor, currency: suggestion.currency, dueDate, recurrence: 'none', cardId })
      .onConflictDoNothing();
    row = await find();
    if (!row) return null;
  }

  const where = and(eq(agendaItems.id, row.id), eq(agendaItems.workspaceId, workspaceId));
  if (amountMinor !== undefined && amountMinor !== row.amountMinor) await db.update(agendaItems).set({ amountMinor }).where(where);
  if (action === 'done') return { id: row.id, result: (await markDone(db, workspaceId, row.id, by!)) === 'done' ? 'done' : 'already' };
  if (action === 'cancel') await db.update(agendaItems).set({ status: 'cancelled' }).where(and(where, eq(agendaItems.status, 'pending')));
  return { id: row.id, result: 'saved' };
}

/** Tarjeta del espacio (para saber su tipo y moneda antes de leer montos). */
export async function findCard(db: Db, workspaceId: string, cardId: string) {
  const [card] = await db
    .select({ id: cards.id, kind: cards.kind, currency: cards.currency, archivedAt: cards.archivedAt })
    .from(cards)
    .where(and(eq(cards.id, cardId), eq(cards.workspaceId, workspaceId)))
    .limit(1);
  return card ?? null;
}

export async function listBalances(db: Db, workspaceId: string): Promise<CashBalance[]> {
  return db
    .select()
    .from(cashBalances)
    .where(and(eq(cashBalances.workspaceId, workspaceId), isNull(cashBalances.archivedAt)))
    .orderBy(asc(cashBalances.label));
}

/**
 * Guarda el saldo de una tarjeta de débito (no archivada, con su moneda) o de un renglón libre (moneda del espacio).
 * Con `id` de un renglón libre existente lo actualiza. Devuelve null si la tarjeta o el renglón no son del espacio.
 */
export async function upsertBalance(db: Db, workspaceId: string, value: BalanceValues & { id?: string; workspaceCurrency: string }): Promise<string | null> {
  if (value.cardId) {
    const card = await findCard(db, workspaceId, value.cardId);
    if (!card || card.kind !== 'debit' || card.archivedAt) return null;
    const [row] = await db
      .insert(cashBalances)
      .values({ workspaceId, cardId: card.id, currency: card.currency, amountMinor: value.amountMinor })
      .onConflictDoUpdate({ target: cashBalances.cardId, set: { amountMinor: value.amountMinor, currency: card.currency, archivedAt: null, updatedAt: new Date() } })
      .returning({ id: cashBalances.id });
    return row!.id;
  }
  if (value.id) {
    const rows = await db
      .update(cashBalances)
      .set({ label: value.label, amountMinor: value.amountMinor })
      .where(and(eq(cashBalances.id, value.id), eq(cashBalances.workspaceId, workspaceId), isNull(cashBalances.cardId), isNull(cashBalances.archivedAt)))
      .returning({ id: cashBalances.id });
    return rows[0]?.id ?? null;
  }
  const [row] = await db
    .insert(cashBalances)
    .values({ workspaceId, label: value.label, currency: value.workspaceCurrency, amountMinor: value.amountMinor })
    .returning({ id: cashBalances.id });
  return row!.id;
}

export async function archiveBalance(db: Db, workspaceId: string, id: string): Promise<boolean> {
  const rows = await db
    .update(cashBalances)
    .set({ archivedAt: new Date() })
    .where(and(eq(cashBalances.id, id), eq(cashBalances.workspaceId, workspaceId), isNull(cashBalances.archivedAt)))
    .returning({ id: cashBalances.id });
  return rows.length > 0;
}
