import { addMonthsISO, daysBetween } from './dates';
import { normalizeDescription } from './text';
import type { NormalizedMovement, PlanStatus } from './types';

/** Lo mínimo de un plan que necesitan los cálculos y el emparejamiento. */
export interface PlanLike {
  id: string;
  /** Texto (normalizable) que identifica al comercio en los cargos mensuales. */
  matchText: string;
  installmentAmountMinor: number;
  totalInstallments: number;
  /** Mensualidades ya cobradas (incluye la que se vincula al crear el plan). */
  paidInstallments: number;
  /** Fecha del primer cargo; los siguientes recurren el mismo día de cada mes. */
  firstChargeDate: string;
  status: PlanStatus;
}

/** Fecha esperada del cargo de la mensualidad `installmentNo` (1-based). */
export function scheduledDate(plan: Pick<PlanLike, 'firstChargeDate'>, installmentNo: number): string {
  return addMonthsISO(plan.firstChargeDate, installmentNo - 1);
}

/** Fecha natural de liquidación: la del último cargo. */
export function naturalEndDate(plan: Pick<PlanLike, 'firstChargeDate' | 'totalInstallments'>): string {
  return scheduledDate(plan, plan.totalInstallments);
}

export function remainingInstallments(plan: Pick<PlanLike, 'totalInstallments' | 'paidInstallments'>): number {
  return Math.max(0, plan.totalInstallments - plan.paidInstallments);
}

/**
 * Saldo pendiente. Si el banco reportó uno (CSV de planes) se usa ese, menos las mensualidades que se
 * hayan pagado desde entonces; si no, es una aproximación (mensualidades restantes × monto), que no
 * incluye intereses ni los centavos que el banco ajuste en la última mensualidad.
 */
export function remainingBalanceMinor(
  plan: Pick<PlanLike, 'totalInstallments' | 'paidInstallments' | 'installmentAmountMinor'> & {
    reportedBalanceMinor?: number | null;
    reportedBalancePaid?: number | null;
  },
): number {
  if (remainingInstallments(plan) === 0) return 0;
  if (plan.reportedBalanceMinor != null && plan.reportedBalancePaid != null) {
    const since = Math.max(0, plan.paidInstallments - plan.reportedBalancePaid);
    return Math.max(0, plan.reportedBalanceMinor - since * plan.installmentAmountMinor);
  }
  return remainingInstallments(plan) * plan.installmentAmountMinor;
}

export interface MatchOptions {
  /** Días de holgura entre la fecha esperada y la del cargo (el banco suele postear unos días después). */
  toleranceDays?: number;
  amountToleranceMinor?: number;
  /** Última fecha cubierta por el archivo; permite detectar cargos que debieron aparecer y no están. */
  coverageEnd?: string;
}

export interface InstallmentMatch {
  planId: string;
  movementKey: string;
  installmentNo: number;
  expectedDate: string;
  /** Días entre la fecha esperada y la del movimiento. */
  daysOffset: number;
  /** Es la última mensualidad: el plan pasaría a liquidado de forma natural. */
  isFinal: boolean;
}

export interface MissingInstallment {
  planId: string;
  installmentNo: number;
  expectedDate: string;
}

type MatchableMovement = Pick<NormalizedMovement, 'uniqueKey' | 'date' | 'descriptionNorm' | 'chargeMinor'>;

/**
 * Propone qué cargo del archivo corresponde a la siguiente mensualidad de cada plan activo.
 * Son sugerencias: la aplicación las muestra para confirmar y nunca las aplica sola.
 * La asignación es uno a uno, así dos planes iguales no consumen el mismo cargo.
 */
export function matchPlanInstallments(
  plans: PlanLike[],
  movements: MatchableMovement[],
  options: MatchOptions = {},
): { matches: InstallmentMatch[]; missing: MissingInstallment[] } {
  const toleranceDays = options.toleranceDays ?? 5;
  const amountTolerance = options.amountToleranceMinor ?? 0;

  type Candidate = InstallmentMatch & { plan: number; movement: number };
  const candidates: Candidate[] = [];
  const open = plans.filter((p) => (p.status === 'active' || p.status === 'review') && p.paidInstallments < p.totalInstallments);

  open.forEach((plan, planIndex) => {
    const installmentNo = plan.paidInstallments + 1;
    const expectedDate = scheduledDate(plan, installmentNo);
    const needle = normalizeDescription(plan.matchText);
    movements.forEach((movement, movementIndex) => {
      if (movement.chargeMinor <= 0 || !movement.descriptionNorm.includes(needle)) return;
      if (Math.abs(movement.chargeMinor - plan.installmentAmountMinor) > amountTolerance) return;
      const daysOffset = daysBetween(expectedDate, movement.date);
      if (Math.abs(daysOffset) > toleranceDays) return;
      candidates.push({
        plan: planIndex,
        movement: movementIndex,
        planId: plan.id,
        movementKey: movement.uniqueKey,
        installmentNo,
        expectedDate,
        daysOffset,
        isFinal: installmentNo === plan.totalInstallments,
      });
    });
  });

  candidates.sort((a, b) => Math.abs(a.daysOffset) - Math.abs(b.daysOffset));
  const takenPlans = new Set<number>();
  const takenMovements = new Set<number>();
  const matches: InstallmentMatch[] = [];
  for (const { plan, movement, ...match } of candidates) {
    if (takenPlans.has(plan) || takenMovements.has(movement)) continue;
    takenPlans.add(plan);
    takenMovements.add(movement);
    matches.push(match);
  }

  const missing: MissingInstallment[] = [];
  if (options.coverageEnd) {
    open.forEach((plan, planIndex) => {
      if (takenPlans.has(planIndex)) return;
      const installmentNo = plan.paidInstallments + 1;
      const expectedDate = scheduledDate(plan, installmentNo);
      if (daysBetween(expectedDate, options.coverageEnd!) > toleranceDays) {
        missing.push({ planId: plan.id, installmentNo, expectedDate });
      }
    });
  }
  return { matches, missing };
}

export type PlanHint = 'installments_in_description' | 'shares_reference_with_interest';

/**
 * Pistas para el asistente de primera carga: qué movimientos podrían ser un plan.
 * Solo sugieren; la decisión es del usuario. (La pista "recurrente" requiere historial de cargas.)
 */
export function planHints(
  movements: Pick<NormalizedMovement, 'uniqueKey' | 'descriptionNorm' | 'reference' | 'chargeMinor'>[],
): Map<string, PlanHint[]> {
  const interestRefs = new Set(
    movements.filter((m) => m.reference && /^(INTERESES|IVA SOBRE INTERESES)/.test(m.descriptionNorm)).map((m) => m.reference!),
  );
  const hints = new Map<string, PlanHint[]>();
  for (const movement of movements) {
    const found: PlanHint[] = [];
    if (/\b(A MESES|MSI|MCI)\b/.test(movement.descriptionNorm)) found.push('installments_in_description');
    if (movement.chargeMinor > 0 && movement.reference && interestRefs.has(movement.reference) && !/^(INTERESES|IVA SOBRE)/.test(movement.descriptionNorm)) {
      found.push('shares_reference_with_interest');
    }
    if (found.length > 0) hints.set(movement.uniqueKey, found);
  }
  return hints;
}
