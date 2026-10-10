import { addMonthsISO, daysBetween } from '../import/dates';
import { naturalEndDate, remainingBalanceMinor, remainingInstallments, scheduledDate } from '../import/plans';
import { budgetStatus, type BudgetStatus } from '../spending/analysis';
import { isOpen, type PlanFacts } from '../plans/schedule';

/**
 * Avance de las metas. Todo se calcula con los datos vigentes (planes, gasto, aportes); no se guarda. Son
 * estimaciones sin intereses: sirven para decidir cuánto abonar, no para sustituir el cálculo del banco.
 */

/** Meses que faltan de `todayISO` a `targetISO`, redondeados hacia arriba; 0 si la fecha ya pasó. */
export function monthsLeft(todayISO: string, targetISO: string): number {
  if (targetISO <= todayISO) return 0;
  let months = 0;
  while (addMonthsISO(todayISO, months) < targetISO) months++;
  return months;
}

export type PlanGoalState = 'achieved' | 'on_track' | 'behind' | 'overdue';

export interface PlanGoalProgress {
  state: PlanGoalState;
  /** Deuda restante de los planes abiertos de la meta. */
  remainingMinor: number;
  /** Lo que las mensualidades ya programadas alcanzan a pagar antes de la fecha. */
  scheduledBeforeMinor: number;
  /** Lo que sobra por pagar a la fecha con solo las mensualidades programadas. */
  leftoverMinor: number;
  /** Último pago programado de los planes abiertos; nulo si no queda ninguno. */
  naturalEnd: string | null;
  /** Días de margen entre el fin natural y la fecha objetivo (negativo = se pasa). */
  marginDays: number | null;
  /** Abono extra mensual (aprox.) para llegar a la fecha. 0 si no hace falta. */
  extraMonthlyMinor: number;
  monthsLeft: number;
  /** Deuda que tenían los planes al crear la meta no se guarda: el avance se mide contra lo ya pagado de los planes. */
  paidRatio: number;
}

/** Meta de liberarse de los planes `plans` (todos los abiertos de una moneda, o uno solo) antes de `targetISO`. */
export function planGoalProgress(plans: readonly PlanFacts[], targetISO: string, todayISO: string): PlanGoalProgress {
  const open = plans.filter((plan) => isOpen(plan) && remainingInstallments(plan) > 0);
  const months = monthsLeft(todayISO, targetISO);

  let remaining = 0;
  let scheduled = 0;
  let totalAmount = 0;
  let paidAmount = 0;
  for (const plan of open) {
    const left = remainingBalanceMinor(plan);
    let before = 0;
    for (let no = plan.paidInstallments + 1; no <= plan.totalInstallments; no++) {
      if (scheduledDate(plan, no) <= targetISO) before += plan.installmentAmountMinor;
    }
    remaining += left;
    scheduled += Math.min(left, before);
    totalAmount += plan.totalInstallments * plan.installmentAmountMinor;
    paidAmount += plan.paidInstallments * plan.installmentAmountMinor;
  }
  const leftover = Math.max(0, remaining - scheduled);
  const naturalEnd = open.length ? open.map(naturalEndDate).reduce((a, b) => (a > b ? a : b)) : null;
  const marginDays = naturalEnd ? daysBetween(naturalEnd, targetISO) : null;

  const state: PlanGoalState = open.length === 0 ? 'achieved' : leftover === 0 ? 'on_track' : targetISO < todayISO ? 'overdue' : 'behind';
  return {
    state,
    remainingMinor: remaining,
    scheduledBeforeMinor: scheduled,
    leftoverMinor: leftover,
    naturalEnd,
    marginDays,
    extraMonthlyMinor: leftover === 0 ? 0 : Math.ceil(leftover / Math.max(1, months)),
    monthsLeft: months,
    paidRatio: totalAmount > 0 ? paidAmount / totalAmount : open.length === 0 ? 1 : 0,
  };
}

export type SavingsState = 'achieved' | 'on_track' | 'behind' | 'overdue';

export interface SavingsProgress {
  state: SavingsState;
  savedMinor: number;
  remainingMinor: number;
  ratio: number;
  monthsLeft: number | null;
  /** Aporte mensual para llegar a la fecha; nulo si la meta no tiene fecha. */
  neededPerMonthMinor: number | null;
}

/**
 * Ahorro: `savedMinor` es la suma de aportes. Con fecha objetivo, "en camino" compara contra el avance lineal desde que se
 * creó la meta (`createdISO`) hasta la fecha.
 */
export function savingsProgress(targetMinor: number, savedMinor: number, targetISO: string | null, createdISO: string, todayISO: string): SavingsProgress {
  const remaining = Math.max(0, targetMinor - savedMinor);
  const ratio = targetMinor > 0 ? Math.min(1, Math.max(0, savedMinor / targetMinor)) : 0;
  if (remaining === 0) return { state: 'achieved', savedMinor, remainingMinor: 0, ratio: 1, monthsLeft: null, neededPerMonthMinor: null };
  if (!targetISO) return { state: 'on_track', savedMinor, remainingMinor: remaining, ratio, monthsLeft: null, neededPerMonthMinor: null };

  const months = monthsLeft(todayISO, targetISO);
  if (targetISO < todayISO) return { state: 'overdue', savedMinor, remainingMinor: remaining, ratio, monthsLeft: 0, neededPerMonthMinor: remaining };

  const span = Math.max(1, daysBetween(createdISO, targetISO));
  const elapsed = Math.min(span, Math.max(0, daysBetween(createdISO, todayISO)));
  const expected = (targetMinor * elapsed) / span;
  return {
    state: savedMinor >= expected ? 'on_track' : 'behind',
    savedMinor,
    remainingMinor: remaining,
    ratio,
    monthsLeft: months,
    neededPerMonthMinor: Math.ceil(remaining / Math.max(1, months)),
  };
}

export interface AntGoalProgress {
  /** Gasto hormiga del mes en curso. */
  currentMinor: number;
  status: BudgetStatus;
  /** De los últimos meses completos con movimientos, en cuántos estuvo bajo el tope. */
  monthsUnder: number;
  monthsMeasured: number;
}

/** Tope mensual de gasto hormiga: el mes en curso contra el tope y el historial de los meses ya cerrados. */
export function antGoalProgress(capMinor: number, points: readonly { month: string; antMinor: number; spendMinor: number }[], currentMonth: string): AntGoalProgress {
  const current = points.find((point) => point.month === currentMonth)?.antMinor ?? 0;
  const closed = points.filter((point) => point.month < currentMonth && point.spendMinor > 0);
  return {
    currentMinor: current,
    status: budgetStatus(current, capMinor),
    monthsUnder: closed.filter((point) => point.antMinor <= capMinor).length,
    monthsMeasured: closed.length,
  };
}
