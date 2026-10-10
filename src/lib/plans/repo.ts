import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { accounts, cards, movements, planEvents, plans, user } from '../../db/schema';
import { cardDisplay } from '../accounts/format';
import type { Db } from '../auth/hooks';
import { remainingBalanceMinor } from '../import/plans';
import type { PlanEdit } from './validation';

/**
 * Todas las funciones reciben el `workspaceId` y lo aplican en cada consulta. Los planes nunca se
 * borran: se liquidan o se reabren, y cada cambio deja un evento con quién, cuándo y por qué.
 */

export type Plan = typeof plans.$inferSelect;
export type PlanEvent = typeof planEvents.$inferSelect;
export interface PlanListItem extends Plan {
  /** Cuenta y tarjeta del plan, ya formateadas: "Mi Banorte ···· 4172". */
  cardName: string;
  accountId: string;
  accountName: string;
}

export async function listPlans(db: Db, workspaceId: string): Promise<PlanListItem[]> {
  const rows = await db
    .select({ plan: plans, accountId: accounts.id, accountName: accounts.name, last4: cards.last4, label: cards.label })
    .from(plans)
    .innerJoin(cards, eq(cards.id, plans.cardId))
    .innerJoin(accounts, eq(accounts.id, cards.accountId))
    .where(eq(plans.workspaceId, workspaceId))
    .orderBy(asc(plans.name));
  return rows.map((row) => ({
    ...row.plan,
    cardName: cardDisplay({ accountName: row.accountName, last4: row.last4, label: row.label }),
    accountId: row.accountId,
    accountName: row.accountName,
  }));
}

export interface PlanDetail {
  plan: Plan;
  card: { id: string; name: string; accountId: string; accountName: string };
  events: (PlanEvent & { actorName: string })[];
  movements: { id: string; date: string; description: string; chargeMinor: number; planInstallmentNo: number | null }[];
}

export async function getPlanDetail(db: Db, workspaceId: string, planId: string): Promise<PlanDetail | null> {
  const [row] = await db
    .select({ plan: plans, cardId: cards.id, accountId: accounts.id, accountName: accounts.name, last4: cards.last4, label: cards.label })
    .from(plans)
    .innerJoin(cards, eq(cards.id, plans.cardId))
    .innerJoin(accounts, eq(accounts.id, cards.accountId))
    .where(and(eq(plans.id, planId), eq(plans.workspaceId, workspaceId)))
    .limit(1);
  if (!row) return null;

  const events = await db
    .select({ event: planEvents, actorName: user.name })
    .from(planEvents)
    .innerJoin(user, eq(user.id, planEvents.actorUserId))
    .where(and(eq(planEvents.planId, planId), eq(planEvents.workspaceId, workspaceId)))
    .orderBy(desc(planEvents.createdAt));

  const linked = await db
    .select({ id: movements.id, date: movements.date, description: movements.description, chargeMinor: movements.chargeMinor, planInstallmentNo: movements.planInstallmentNo })
    .from(movements)
    .where(and(eq(movements.planId, planId), eq(movements.workspaceId, workspaceId)))
    .orderBy(asc(movements.date));

  return {
    plan: row.plan,
    card: { id: row.cardId, name: cardDisplay({ accountName: row.accountName, last4: row.last4, label: row.label }), accountId: row.accountId, accountName: row.accountName },
    events: events.map((e) => ({ ...e.event, actorName: e.actorName })),
    movements: linked,
  };
}

const EDITABLE: (keyof PlanEdit & keyof Plan)[] = [
  'name',
  'matchText',
  'type',
  'installmentAmountMinor',
  'totalInstallments',
  'paidInstallments',
  'totalAmountMinor',
  'interestRateBp',
  'firstChargeDate',
];

export type UpdateResult = { ok: true; changed: string[] } | { ok: false; reason: 'not_found' };

/**
 * Edita a mano cualquier parámetro del plan. Registra el valor anterior y el nuevo de cada campo en
 * el historial (con el comentario) y anota qué campos se ajustaron a mano. El estado se corrige solo
 * cuando corresponde: si los pagos realizados alcanzan el total, el plan queda liquidado de forma
 * natural; si vuelven a bajar, regresa a activo. Un plan liquidado a mano conserva su estado.
 */
export async function updatePlan(db: Db, workspaceId: string, userId: string, planId: string, edit: PlanEdit): Promise<UpdateResult> {
  const [current] = await db
    .select()
    .from(plans)
    .where(and(eq(plans.id, planId), eq(plans.workspaceId, workspaceId)))
    .limit(1);
  if (!current) return { ok: false, reason: 'not_found' };

  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const field of EDITABLE) if (current[field] !== edit[field]) changes[field] = { from: current[field], to: edit[field] };
  if (Object.keys(changes).length === 0) return { ok: true, changed: [] };

  let status = current.status;
  if (status !== 'settled_manual') {
    if (edit.paidInstallments >= edit.totalInstallments) status = 'completed_natural';
    else if (status === 'completed_natural') status = 'active';
  }
  const statusChanged = status !== current.status;
  const overridden = [...new Set([...current.overriddenFields, ...Object.keys(changes)])];

  const statements: BatchItem<'sqlite'>[] = [
    db
      .update(plans)
      .set({
        name: edit.name,
        matchText: edit.matchText,
        type: edit.type,
        installmentAmountMinor: edit.installmentAmountMinor,
        totalInstallments: edit.totalInstallments,
        paidInstallments: edit.paidInstallments,
        totalAmountMinor: edit.totalAmountMinor,
        interestRateBp: edit.interestRateBp,
        firstChargeDate: edit.firstChargeDate,
        status,
        settledAt: status === 'completed_natural' ? (current.settledAt ?? new Date()) : status === 'active' || status === 'review' ? null : current.settledAt,
        overriddenFields: overridden,
      })
      .where(and(eq(plans.id, planId), eq(plans.workspaceId, workspaceId))),
    db.insert(planEvents).values({
      workspaceId,
      planId,
      type: 'edited',
      data: { changes, ...(statusChanged ? { status: { from: current.status, to: status } } : {}) },
      comment: edit.comment,
      actorUserId: userId,
    }),
  ];
  await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
  return { ok: true, changed: Object.keys(changes) };
}

export type TransitionResult = { ok: true } | { ok: false; reason: 'not_found' | 'invalid_state' };

/** Liquidación manual (pagado por otra vía): exige comentario, que queda como nota y en el historial. */
export async function settlePlan(db: Db, workspaceId: string, userId: string, planId: string, comment: string): Promise<TransitionResult> {
  const [current] = await db
    .select()
    .from(plans)
    .where(and(eq(plans.id, planId), eq(plans.workspaceId, workspaceId)))
    .limit(1);
  if (!current) return { ok: false, reason: 'not_found' };
  if (current.status !== 'active' && current.status !== 'review') return { ok: false, reason: 'invalid_state' };

  await db.batch([
    db
      .update(plans)
      .set({ status: 'settled_manual', settledAt: new Date(), settlementNote: comment })
      .where(and(eq(plans.id, planId), eq(plans.workspaceId, workspaceId))),
    db.insert(planEvents).values({
      workspaceId,
      planId,
      type: 'settled',
      data: { from: current.status, paidInstallments: current.paidInstallments, totalInstallments: current.totalInstallments },
      comment,
      actorUserId: userId,
    }),
  ]);
  return { ok: true };
}

export type StatusTarget = 'active' | 'review';
const ALLOWED: Record<string, StatusTarget[]> = {
  active: ['review'],
  review: ['active'],
  settled_manual: ['active'], // reabrir un plan liquidado a mano
};

/** Marca/quita "por revisar" y reabre un plan liquidado a mano. La liquidación natural no se revierte aquí. */
export async function changeStatus(db: Db, workspaceId: string, userId: string, planId: string, to: StatusTarget, comment: string | null): Promise<TransitionResult> {
  const [current] = await db
    .select()
    .from(plans)
    .where(and(eq(plans.id, planId), eq(plans.workspaceId, workspaceId)))
    .limit(1);
  if (!current) return { ok: false, reason: 'not_found' };
  if (!(ALLOWED[current.status] ?? []).includes(to)) return { ok: false, reason: 'invalid_state' };

  const reopening = current.status === 'settled_manual';
  await db.batch([
    db
      .update(plans)
      .set({ status: to, ...(reopening ? { settledAt: null, settlementNote: null } : {}) })
      .where(and(eq(plans.id, planId), eq(plans.workspaceId, workspaceId))),
    db.insert(planEvents).values({
      workspaceId,
      planId,
      type: 'status_changed',
      data: { from: current.status, to, ...(reopening ? { previousNote: current.settlementNote } : {}) },
      comment,
      actorUserId: userId,
    }),
  ]);
  return { ok: true };
}

// ── Saldos reportados por el banco ────────────────────────────────────────────────────────────

export interface BalanceUpdate {
  planId: string;
  balanceMinor: number;
}

/**
 * Guarda el saldo pendiente que reportó el banco en cada plan (solo planes abiertos del espacio) y deja un
 * evento con el valor anterior y el nuevo. Todo en una transacción. Devuelve cuántos planes actualizó.
 */
export async function applyReportedBalances(db: Db, workspaceId: string, userId: string, asOf: string, updates: BalanceUpdate[]): Promise<number> {
  if (updates.length === 0) return 0;
  const rows = await db.select().from(plans).where(and(eq(plans.workspaceId, workspaceId), inArray(plans.id, updates.map((u) => u.planId))));
  const byId = new Map(rows.filter((plan) => plan.status === 'active' || plan.status === 'review').map((plan) => [plan.id, plan]));

  const statements: BatchItem<'sqlite'>[] = [];
  for (const update of updates) {
    const plan = byId.get(update.planId);
    if (!plan) continue;
    statements.push(
      db
        .update(plans)
        .set({ reportedBalanceMinor: update.balanceMinor, reportedBalanceDate: asOf, reportedBalancePaid: plan.paidInstallments })
        .where(and(eq(plans.id, plan.id), eq(plans.workspaceId, workspaceId))),
      db.insert(planEvents).values({
        workspaceId,
        planId: plan.id,
        type: 'balance_reported',
        data: { from: remainingBalanceMinor(plan), to: update.balanceMinor, asOf },
        actorUserId: userId,
      }),
    );
  }
  if (statements.length === 0) return 0;
  await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
  return statements.length / 2;
}
