import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { accounts, importBatches, movements, planEvents, planTags, plans, user } from '../../db/schema';
import type { Db } from '../auth/hooks';
import { decideRevert, type AdvancedPlanFacts, type CreatedPlanFacts, type RevertDecision } from './revert';
import type { PlanStatus } from './types';

const CHUNK = 90; // D1: máximo 100 parámetros por consulta
const chunks = <T>(items: readonly T[]): T[][] => Array.from({ length: Math.ceil(items.length / CHUNK) }, (_, i) => items.slice(i * CHUNK, (i + 1) * CHUNK));

export interface BatchSummary {
  rows?: { total: number; fresh: number; duplicates: number; errors: number };
  plansCreated?: number;
  installmentsLinked?: number;
  revert?: { byUserId: string; byName: string; movementsDeleted: number; plansDeleted: number; installmentsUndone: number };
}

export interface BatchListItem {
  id: string;
  fileName: string;
  createdAt: Date;
  cutoffDate: string | null;
  status: 'applied' | 'reverted';
  accountId: string;
  accountName: string;
  createdByName: string;
  revertedAt: Date | null;
  /** Movimientos que esta carga aún tiene guardados (0 si se revirtió). */
  movementCount: number;
  summary: BatchSummary | null;
  /** Es la carga más reciente (aplicada) de su cuenta: la única que se puede deshacer. */
  isLatest: boolean;
}

/** Cargas del espacio, de la más reciente a la más antigua. */
export async function listBatches(db: Db, workspaceId: string): Promise<BatchListItem[]> {
  const rows = await db
    .select({
      batch: importBatches,
      accountName: accounts.name,
      createdByName: user.name,
    })
    .from(importBatches)
    .innerJoin(accounts, eq(accounts.id, importBatches.accountId))
    .innerJoin(user, eq(user.id, importBatches.createdBy))
    .where(eq(importBatches.workspaceId, workspaceId))
    .orderBy(desc(importBatches.createdAt), desc(sql`${importBatches}.rowid`));

  const counts = await db
    .select({ batchId: movements.batchId, n: sql<number>`count(*)` })
    .from(movements)
    .where(eq(movements.workspaceId, workspaceId))
    .groupBy(movements.batchId);
  const countOf = new Map(counts.map((c) => [c.batchId, c.n]));

  const latestOfAccount = new Set<string>();
  const seen = new Set<string>();
  for (const { batch } of rows) {
    if (batch.status === 'applied' && !seen.has(batch.accountId)) {
      seen.add(batch.accountId);
      latestOfAccount.add(batch.id);
    }
  }

  return rows.map(({ batch, accountName, createdByName }) => ({
    id: batch.id,
    fileName: batch.fileName,
    createdAt: batch.createdAt,
    cutoffDate: batch.cutoffDate,
    status: batch.status,
    accountId: batch.accountId,
    accountName,
    createdByName,
    revertedAt: batch.revertedAt,
    movementCount: countOf.get(batch.id) ?? 0,
    summary: (batch.summary as BatchSummary | null) ?? null,
    isLatest: latestOfAccount.has(batch.id),
  }));
}

interface GatheredFacts {
  batch: typeof importBatches.$inferSelect;
  decision: RevertDecision;
  names: Map<string, string>;
}

/** Reúne lo que decide si una carga puede deshacerse y aplica las reglas de `decideRevert`. */
async function evaluate(db: Db, workspaceId: string, batchId: string): Promise<GatheredFacts | null> {
  const [batch] = await db
    .select()
    .from(importBatches)
    .where(and(eq(importBatches.id, batchId), eq(importBatches.workspaceId, workspaceId)))
    .limit(1);
  if (!batch) return null;

  const [latest] = await db
    .select({ id: importBatches.id })
    .from(importBatches)
    .where(and(eq(importBatches.workspaceId, workspaceId), eq(importBatches.accountId, batch.accountId), eq(importBatches.status, 'applied')))
    .orderBy(desc(importBatches.createdAt), desc(sql`${importBatches}.rowid`))
    .limit(1);

  const events = await db
    .select({ planId: planEvents.planId, type: planEvents.type, data: planEvents.data })
    .from(planEvents)
    .where(and(eq(planEvents.workspaceId, workspaceId), eq(planEvents.batchId, batchId)));

  const createdIds = [...new Set(events.filter((e) => e.type === 'created').map((e) => e.planId))];
  const advancedEvents = events.filter((e) => e.type === 'installment_recorded' && !createdIds.includes(e.planId));
  const planIds = [...new Set([...createdIds, ...advancedEvents.map((e) => e.planId)])];

  const names = new Map<string, string>();
  const current = new Map<string, number>();
  const later = new Map<string, number>();
  const foreign = new Map<string, number>();
  for (const part of chunks(planIds)) {
    for (const row of await db.select({ id: plans.id, name: plans.name, paid: plans.paidInstallments }).from(plans).where(and(eq(plans.workspaceId, workspaceId), inArray(plans.id, part)))) {
      names.set(row.id, row.name);
      current.set(row.id, row.paid);
    }
    // Eventos posteriores a los de esta carga (por orden de inserción, no por hora: dos cambios pueden caer en el mismo segundo).
    const laterRows = await db
      .select({ planId: planEvents.planId, n: sql<number>`count(*)` })
      .from(planEvents)
      .where(
        and(
          inArray(planEvents.planId, part),
          sql`${planEvents}.rowid > (select max(b.rowid) from plan_events b where b.batch_id = ${batchId} and b.plan_id = ${planEvents.planId})`,
        ),
      )
      .groupBy(planEvents.planId);
    for (const row of laterRows) later.set(row.planId, row.n);
  }
  for (const part of chunks(createdIds)) {
    const rows = await db
      .select({ planId: movements.planId, n: sql<number>`count(*)` })
      .from(movements)
      .where(and(inArray(movements.planId, part), sql`${movements.batchId} <> ${batchId}`))
      .groupBy(movements.planId);
    for (const row of rows) if (row.planId) foreign.set(row.planId, row.n);
  }

  const [{ n: movementCount } = { n: 0 }] = await db.select({ n: sql<number>`count(*)` }).from(movements).where(eq(movements.batchId, batchId));

  const created: CreatedPlanFacts[] = createdIds.map((planId) => ({
    planId,
    name: names.get(planId) ?? planId,
    laterEvents: later.get(planId) ?? 0,
    foreignMovements: foreign.get(planId) ?? 0,
  }));
  const advanced: AdvancedPlanFacts[] = advancedEvents.map((event) => {
    const data = (event.data ?? {}) as { installmentNo?: number; previousStatus?: PlanStatus };
    return {
      planId: event.planId,
      name: names.get(event.planId) ?? event.planId,
      installmentNo: Number(data.installmentNo ?? 0),
      paidInstallments: current.get(event.planId) ?? 0,
      laterEvents: later.get(event.planId) ?? 0,
      previousStatus: data.previousStatus ?? null,
    };
  });

  const decision = decideRevert({
    status: batch.status,
    isLatest: latest?.id === batchId,
    movementCount,
    created,
    advanced,
  });
  return { batch, decision, names };
}

/** Qué pasaría al deshacer una carga, sin tocar nada. `null` si la carga no existe en este espacio. */
export async function previewRevert(db: Db, workspaceId: string, batchId: string): Promise<RevertDecision | null> {
  return (await evaluate(db, workspaceId, batchId))?.decision ?? null;
}

export type RevertOutcome =
  | { ok: true; movementsDeleted: number; plansDeleted: number; installmentsUndone: number }
  | { ok: false; reason: 'not_found' }
  | Exclude<RevertDecision, { ok: true }>;

/**
 * Deshace una carga en una sola transacción: elimina sus movimientos y los planes que creó, y devuelve
 * los planes que avanzó a su estado anterior (dejando constancia en su historial). Nada de esto ocurre
 * si las reglas de `decideRevert` lo impiden. Se conservan categorías, reglas, perfil, tarjetas y el archivo.
 */
export async function revertBatch(db: Db, workspaceId: string, userId: string, batchId: string): Promise<RevertOutcome> {
  const evaluated = await evaluate(db, workspaceId, batchId);
  if (!evaluated) return { ok: false, reason: 'not_found' };
  const { batch, decision } = evaluated;
  if (!decision.ok) return decision;

  const [actor] = await db.select({ name: user.name }).from(user).where(eq(user.id, userId)).limit(1);
  const statements: BatchItem<'sqlite'>[] = [];

  // Los eventos que apuntaban a movimientos de esta carga conservan su texto pero pierden el vínculo.
  statements.push(
    db
      .update(planEvents)
      .set({ movementId: null })
      .where(and(eq(planEvents.workspaceId, workspaceId), inArray(planEvents.movementId, db.select({ id: movements.id }).from(movements).where(eq(movements.batchId, batchId))))),
    db.delete(movements).where(and(eq(movements.workspaceId, workspaceId), eq(movements.batchId, batchId))),
  );

  for (const part of chunks(decision.deletePlanIds)) {
    statements.push(
      db.delete(planEvents).where(and(eq(planEvents.workspaceId, workspaceId), inArray(planEvents.planId, part))),
      db.delete(planTags).where(inArray(planTags.planId, part)),
      db.delete(plans).where(and(eq(plans.workspaceId, workspaceId), inArray(plans.id, part))),
    );
  }

  for (const undo of decision.undo) {
    statements.push(
      db
        .update(plans)
        .set({ paidInstallments: undo.restorePaid, status: undo.restoreStatus, settledAt: null })
        .where(and(eq(plans.id, undo.planId), eq(plans.workspaceId, workspaceId))),
      db.insert(planEvents).values({
        workspaceId,
        planId: undo.planId,
        type: 'reverted',
        data: { batchId, installmentNo: undo.installmentNo, restored: { paid: undo.restorePaid, status: undo.restoreStatus } },
        batchId,
        actorUserId: userId,
      }),
    );
  }

  const outcome = { movementsDeleted: decision.movements, plansDeleted: decision.deletePlanIds.length, installmentsUndone: decision.undo.length };
  statements.push(
    db
      .update(importBatches)
      .set({
        status: 'reverted',
        revertedAt: new Date(),
        summary: { ...((batch.summary as BatchSummary | null) ?? {}), revert: { byUserId: userId, byName: actor?.name ?? '', ...outcome } },
      })
      .where(and(eq(importBatches.id, batchId), eq(importBatches.workspaceId, workspaceId))),
  );

  await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
  return { ok: true, ...outcome };
}
