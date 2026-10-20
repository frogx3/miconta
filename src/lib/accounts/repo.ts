import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { accounts, cards, importBatches, movements, plans } from '../../db/schema';
import type { Db } from '../auth/hooks';
import type { AccountInput, CardInput } from './validation';

/**
 * Todas las funciones reciben el `workspaceId` y lo aplican en cada consulta: nunca se confía en
 * un identificador suelto, así un usuario no puede leer ni tocar cuentas de otro espacio.
 * No existe borrado de cuentas: se archivan y conservan todo su historial. Una tarjeta sin
 * movimientos ni planes sí se puede quitar; si tiene historial solo se archiva.
 */

export type Account = typeof accounts.$inferSelect;
export type Card = typeof cards.$inferSelect;
export interface AccountWithCards extends Account {
  cards: Card[];
}
/** Tarjeta con el nombre de su cuenta, para selectores y listados. */
export interface CardWithAccount extends Card {
  accountName: string;
}

async function attachCards(db: Db, list: Account[]): Promise<AccountWithCards[]> {
  if (list.length === 0) return [];
  const rows = await db
    .select()
    .from(cards)
    .where(
      inArray(
        cards.accountId,
        list.map((account) => account.id),
      ),
    )
    .orderBy(asc(cards.isDigital), asc(cards.createdAt), asc(cards.last4));
  return list.map((account) => ({ ...account, cards: rows.filter((card) => card.accountId === account.id) }));
}

export async function listAccounts(db: Db, workspaceId: string, includeArchived = false): Promise<AccountWithCards[]> {
  const rows = await db
    .select()
    .from(accounts)
    .where(includeArchived ? eq(accounts.workspaceId, workspaceId) : and(eq(accounts.workspaceId, workspaceId), isNull(accounts.archivedAt)))
    .orderBy(asc(accounts.name));
  return attachCards(db, rows);
}

export async function getAccount(db: Db, workspaceId: string, accountId: string): Promise<AccountWithCards | null> {
  const rows = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.workspaceId, workspaceId)))
    .limit(1);
  return (await attachCards(db, rows))[0] ?? null;
}

export async function createAccount(db: Db, workspaceId: string, input: AccountInput): Promise<string> {
  const [row] = await db
    .insert(accounts)
    .values({ workspaceId, ...input })
    .returning({ id: accounts.id });
  return row!.id;
}

export async function updateAccount(db: Db, workspaceId: string, accountId: string, input: AccountInput): Promise<boolean> {
  const rows = await db
    .update(accounts)
    .set(input)
    .where(and(eq(accounts.id, accountId), eq(accounts.workspaceId, workspaceId)))
    .returning({ id: accounts.id });
  return rows.length > 0;
}

export async function setAccountArchived(db: Db, workspaceId: string, accountId: string, archived: boolean): Promise<boolean> {
  const rows = await db
    .update(accounts)
    .set({ archivedAt: archived ? new Date() : null })
    .where(and(eq(accounts.id, accountId), eq(accounts.workspaceId, workspaceId)))
    .returning({ id: accounts.id });
  return rows.length > 0;
}

/** Tarjetas del espacio con el nombre de su cuenta; por defecto solo las activas de cuentas activas. */
export async function listCards(db: Db, workspaceId: string, includeArchived = false): Promise<CardWithAccount[]> {
  const rows = await db
    .select({ card: cards, accountName: accounts.name })
    .from(cards)
    .innerJoin(accounts, eq(accounts.id, cards.accountId))
    .where(
      includeArchived
        ? eq(cards.workspaceId, workspaceId)
        : and(eq(cards.workspaceId, workspaceId), isNull(cards.archivedAt), isNull(accounts.archivedAt)),
    )
    .orderBy(asc(accounts.name), asc(cards.isDigital), asc(cards.createdAt), asc(cards.last4));
  return rows.map((row) => ({ ...row.card, accountName: row.accountName }));
}

export async function getCard(db: Db, workspaceId: string, cardId: string): Promise<CardWithAccount | null> {
  const [row] = await db
    .select({ card: cards, accountName: accounts.name })
    .from(cards)
    .innerJoin(accounts, eq(accounts.id, cards.accountId))
    .where(and(eq(cards.id, cardId), eq(cards.workspaceId, workspaceId)))
    .limit(1);
  return row ? { ...row.card, accountName: row.accountName } : null;
}

export type CardResult = { ok: true; id: string } | { ok: false; reason: 'not_found' | 'duplicate' | 'in_use' };

export async function addCard(db: Db, workspaceId: string, accountId: string, input: CardInput): Promise<CardResult> {
  const account = await getAccount(db, workspaceId, accountId);
  if (!account) return { ok: false, reason: 'not_found' };
  if (account.cards.some((card) => card.last4 === input.last4)) return { ok: false, reason: 'duplicate' };
  const [row] = await db
    .insert(cards)
    .values({ workspaceId, accountId, ...input })
    .returning({ id: cards.id });
  return { ok: true, id: row!.id };
}

export async function updateCard(db: Db, workspaceId: string, accountId: string, cardId: string, input: CardInput): Promise<CardResult> {
  const account = await getAccount(db, workspaceId, accountId);
  const current = account?.cards.find((card) => card.id === cardId);
  if (!account || !current) return { ok: false, reason: 'not_found' };
  if (account.cards.some((card) => card.id !== cardId && card.last4 === input.last4)) return { ok: false, reason: 'duplicate' };
  await db.update(cards).set(input).where(eq(cards.id, cardId));
  return { ok: true, id: cardId };
}

export async function setCardArchived(db: Db, workspaceId: string, accountId: string, cardId: string, archived: boolean): Promise<boolean> {
  const rows = await db
    .update(cards)
    .set({ archivedAt: archived ? new Date() : null })
    .where(and(eq(cards.id, cardId), eq(cards.accountId, accountId), eq(cards.workspaceId, workspaceId)))
    .returning({ id: cards.id });
  return rows.length > 0;
}

/** Una tarjeta con movimientos o planes forma parte del historial: no se quita, solo se archiva. */
export async function removeCard(db: Db, workspaceId: string, accountId: string, cardId: string): Promise<CardResult> {
  const account = await getAccount(db, workspaceId, accountId);
  if (!account?.cards.some((card) => card.id === cardId)) return { ok: false, reason: 'not_found' };
  const [usedByMovements] = await db.select({ n: count() }).from(movements).where(eq(movements.cardId, cardId));
  const [usedByPlans] = await db.select({ n: count() }).from(plans).where(eq(plans.cardId, cardId));
  if ((usedByMovements?.n ?? 0) + (usedByPlans?.n ?? 0) > 0) return { ok: false, reason: 'in_use' };
  await db.delete(cards).where(eq(cards.id, cardId));
  return { ok: true, id: cardId };
}

/** Ids de las tarjetas de la cuenta que ya tienen movimientos o planes (no se pueden quitar, solo archivar). */
export async function cardsInUse(db: Db, workspaceId: string, accountId: string): Promise<Set<string>> {
  const account = await getAccount(db, workspaceId, accountId);
  const ids = account?.cards.map((card) => card.id) ?? [];
  if (ids.length === 0) return new Set();
  const byMovements = await db.selectDistinct({ id: movements.cardId }).from(movements).where(inArray(movements.cardId, ids));
  const byPlans = await db.selectDistinct({ id: plans.cardId }).from(plans).where(inArray(plans.cardId, ids));
  return new Set([...byMovements, ...byPlans].map((row) => row.id).filter((id): id is string => !!id));
}

export interface AccountActivity {
  movements: number;
  openPlans: number;
  /** Corte de la última carga aplicada (o su fecha de registro si no tiene corte). */
  lastImport: string | null;
  byCard: Map<string, { movements: number; openPlans: number }>;
}

/** Cuánta información tiene una cuenta (y cada una de sus tarjetas), para enlazar a sus planes y movimientos solo si existen. */
export async function accountActivity(db: Db, workspaceId: string, accountId: string, cardIds: string[]): Promise<AccountActivity> {
  const [total] = await db.select({ n: count() }).from(movements).where(and(eq(movements.workspaceId, workspaceId), eq(movements.accountId, accountId)));
  const perCardMovements = await db
    .select({ cardId: movements.cardId, n: count() })
    .from(movements)
    .where(and(eq(movements.workspaceId, workspaceId), eq(movements.accountId, accountId)))
    .groupBy(movements.cardId);
  const perCardPlans = cardIds.length
    ? await db
        .select({ cardId: plans.cardId, n: count() })
        .from(plans)
        .where(and(eq(plans.workspaceId, workspaceId), inArray(plans.cardId, cardIds), inArray(plans.status, ['active', 'review'])))
        .groupBy(plans.cardId)
    : [];
  const [last] = await db
    .select({ cutoffDate: importBatches.cutoffDate, createdAt: importBatches.createdAt })
    .from(importBatches)
    .where(and(eq(importBatches.workspaceId, workspaceId), eq(importBatches.accountId, accountId), eq(importBatches.status, 'applied'), eq(importBatches.source, 'csv')))
    .orderBy(desc(importBatches.createdAt), desc(sql`${importBatches}.rowid`))
    .limit(1);

  const byCard = new Map<string, { movements: number; openPlans: number }>();
  for (const id of cardIds) byCard.set(id, { movements: 0, openPlans: 0 });
  for (const row of perCardMovements) if (row.cardId) byCard.get(row.cardId)!.movements = row.n;
  for (const row of perCardPlans) byCard.get(row.cardId)!.openPlans = row.n;
  return {
    movements: total?.n ?? 0,
    openPlans: [...byCard.values()].reduce((sum, card) => sum + card.openPlans, 0),
    lastImport: last ? (last.cutoffDate ?? last.createdAt.toISOString().slice(0, 10)) : null,
    byCard,
  };
}
