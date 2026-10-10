import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { goalEntries, goals, plans } from '../../db/schema';
import type { Db } from '../auth/hooks';
import type { EntryValues, GoalEdit, GoalValues } from './validation';

/** Todas las funciones reciben el `workspaceId` y lo aplican en cada consulta. */

export type Goal = typeof goals.$inferSelect;
export type GoalEntry = typeof goalEntries.$inferSelect;

export interface GoalWithSaved extends Goal {
  /** Suma de aportes (solo metas de ahorro). */
  savedMinor: number;
}

export async function listGoals(db: Db, workspaceId: string, includeArchived = false): Promise<GoalWithSaved[]> {
  const rows = await db
    .select()
    .from(goals)
    .where(includeArchived ? eq(goals.workspaceId, workspaceId) : and(eq(goals.workspaceId, workspaceId), isNull(goals.archivedAt)))
    .orderBy(asc(goals.createdAt));
  if (rows.length === 0) return [];
  const sums = await db
    .select({ goalId: goalEntries.goalId, total: sql<number>`coalesce(sum(${goalEntries.amountMinor}), 0)` })
    .from(goalEntries)
    .where(and(eq(goalEntries.workspaceId, workspaceId), inArray(goalEntries.goalId, rows.map((row) => row.id))))
    .groupBy(goalEntries.goalId);
  const saved = new Map(sums.map((row) => [row.goalId, Number(row.total)]));
  return rows.map((row) => ({ ...row, savedMinor: saved.get(row.id) ?? 0 }));
}

export async function getGoal(db: Db, workspaceId: string, goalId: string): Promise<Goal | null> {
  const [row] = await db.select().from(goals).where(and(eq(goals.id, goalId), eq(goals.workspaceId, workspaceId))).limit(1);
  return row ?? null;
}

export type CreateResult = { ok: true; id: string } | { ok: false; reason: 'plan_not_found' };

/** Crea la meta; una de liquidar un plan exige un plan abierto del espacio y toma su moneda. */
export async function createGoal(db: Db, workspaceId: string, userId: string, currency: string, value: GoalValues): Promise<CreateResult> {
  let goalCurrency = currency;
  if (value.type === 'payoff_plan') {
    const [plan] = await db
      .select({ currency: plans.currency, status: plans.status })
      .from(plans)
      .where(and(eq(plans.id, value.planId!), eq(plans.workspaceId, workspaceId)))
      .limit(1);
    if (!plan || (plan.status !== 'active' && plan.status !== 'review')) return { ok: false, reason: 'plan_not_found' };
    goalCurrency = plan.currency;
  }
  const [row] = await db
    .insert(goals)
    .values({ workspaceId, type: value.type, name: value.name, currency: goalCurrency, targetDate: value.targetDate, targetAmountMinor: value.targetAmountMinor, planId: value.planId, createdBy: userId })
    .returning({ id: goals.id });
  return { ok: true, id: row!.id };
}

export async function updateGoal(db: Db, workspaceId: string, goalId: string, edit: GoalEdit): Promise<boolean> {
  const rows = await db
    .update(goals)
    .set({ name: edit.name, targetDate: edit.targetDate, targetAmountMinor: edit.targetAmountMinor })
    .where(and(eq(goals.id, goalId), eq(goals.workspaceId, workspaceId)))
    .returning({ id: goals.id });
  return rows.length > 0;
}

export async function setGoalArchived(db: Db, workspaceId: string, goalId: string, archived: boolean): Promise<boolean> {
  const rows = await db
    .update(goals)
    .set({ archivedAt: archived ? new Date() : null })
    .where(and(eq(goals.id, goalId), eq(goals.workspaceId, workspaceId)))
    .returning({ id: goals.id });
  return rows.length > 0;
}

/** Elimina la meta y sus aportes. Una meta no es un registro financiero: borrarla no toca planes ni movimientos. */
export async function deleteGoal(db: Db, workspaceId: string, goalId: string): Promise<boolean> {
  if (!(await getGoal(db, workspaceId, goalId))) return false;
  await db.batch([
    db.delete(goalEntries).where(and(eq(goalEntries.goalId, goalId), eq(goalEntries.workspaceId, workspaceId))),
    db.delete(goals).where(and(eq(goals.id, goalId), eq(goals.workspaceId, workspaceId))),
  ]);
  return true;
}

export async function listEntries(db: Db, workspaceId: string, goalId: string): Promise<GoalEntry[]> {
  return db
    .select()
    .from(goalEntries)
    .where(and(eq(goalEntries.workspaceId, workspaceId), eq(goalEntries.goalId, goalId)))
    .orderBy(desc(goalEntries.date), desc(goalEntries.createdAt));
}

export type EntryResult = { ok: true; id: string } | { ok: false; reason: 'not_found' | 'not_savings' };

export async function addEntry(db: Db, workspaceId: string, userId: string, goalId: string, value: EntryValues): Promise<EntryResult> {
  const goal = await getGoal(db, workspaceId, goalId);
  if (!goal) return { ok: false, reason: 'not_found' };
  if (goal.type !== 'savings') return { ok: false, reason: 'not_savings' };
  const [row] = await db.insert(goalEntries).values({ workspaceId, goalId, createdBy: userId, ...value }).returning({ id: goalEntries.id });
  return { ok: true, id: row!.id };
}

export async function deleteEntry(db: Db, workspaceId: string, goalId: string, entryId: string): Promise<boolean> {
  const rows = await db
    .delete(goalEntries)
    .where(and(eq(goalEntries.id, entryId), eq(goalEntries.goalId, goalId), eq(goalEntries.workspaceId, workspaceId)))
    .returning({ id: goalEntries.id });
  return rows.length > 0;
}
