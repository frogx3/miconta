import type { PlanStatus } from './types';

/**
 * Reglas para deshacer una carga de importación. Son una función pura: la capa de datos reúne los
 * hechos y aquí se decide. Lo importante es no perder trabajo del usuario.
 *
 * - Solo se deshace la última carga de cada tarjeta (las posteriores pueden depender de ella).
 * - Si un plan que la carga creó o avanzó cambió después (se editó, se liquidó, se registró otro pago),
 *   deshacerla borraría trabajo del usuario: se bloquea y se explica qué plan lo impide.
 */

export interface CreatedPlanFacts {
  planId: string;
  name: string;
  /** Eventos del plan ajenos a esta carga y posteriores a ella. */
  laterEvents: number;
  /** Movimientos de OTRA carga vinculados a este plan. */
  foreignMovements: number;
}

export interface AdvancedPlanFacts {
  planId: string;
  name: string;
  /** Mensualidad que esta carga registró en el plan. */
  installmentNo: number;
  paidInstallments: number;
  laterEvents: number;
  /** Estado del plan antes de la carga; `null` en cargas antiguas que no lo guardaron. */
  previousStatus: PlanStatus | null;
}

export interface RevertFacts {
  status: 'applied' | 'reverted';
  isLatest: boolean;
  movementCount: number;
  created: CreatedPlanFacts[];
  advanced: AdvancedPlanFacts[];
}

export interface Blocker {
  planId: string;
  name: string;
  why: 'changed_after' | 'linked_elsewhere';
}

export interface PlanUndo {
  planId: string;
  name: string;
  installmentNo: number;
  restorePaid: number;
  restoreStatus: PlanStatus;
}

export type RevertDecision =
  | { ok: true; movements: number; deletePlanIds: string[]; undo: PlanUndo[] }
  | { ok: false; reason: 'already_reverted' | 'not_latest' }
  | { ok: false; reason: 'plans_changed'; blockers: Blocker[] };

export function decideRevert(facts: RevertFacts): RevertDecision {
  if (facts.status === 'reverted') return { ok: false, reason: 'already_reverted' };
  if (!facts.isLatest) return { ok: false, reason: 'not_latest' };

  const blockers: Blocker[] = [];
  for (const plan of facts.created) {
    if (plan.laterEvents > 0) blockers.push({ planId: plan.planId, name: plan.name, why: 'changed_after' });
    else if (plan.foreignMovements > 0) blockers.push({ planId: plan.planId, name: plan.name, why: 'linked_elsewhere' });
  }
  for (const plan of facts.advanced) {
    // Si los pagos realizados ya no son los que dejó la carga, alguien los cambió a mano.
    if (plan.laterEvents > 0 || plan.paidInstallments !== plan.installmentNo) blockers.push({ planId: plan.planId, name: plan.name, why: 'changed_after' });
  }
  if (blockers.length > 0) return { ok: false, reason: 'plans_changed', blockers };

  return {
    ok: true,
    movements: facts.movementCount,
    deletePlanIds: facts.created.map((plan) => plan.planId),
    undo: facts.advanced.map((plan) => ({
      planId: plan.planId,
      name: plan.name,
      installmentNo: plan.installmentNo,
      restorePaid: plan.installmentNo - 1,
      // Las cargas antiguas no guardaron el estado previo: lo normal es que estuviera activo.
      restoreStatus: plan.previousStatus ?? 'active',
    })),
  };
}
