import type { BankId } from '../banks';
import { addMonthsISO, daysBetween } from '../import/dates';
import { normalizeDescription } from '../import/text';
import { matchBankPlans, type BalanceMatch, type BankPlanRow, type MatchablePlan } from '../plans/bank-balances';

/**
 * Comparador de estados de cuenta (docs/plan-de-actualizacion.md §3, Fase 0). Recibe un estado de cuenta ya
 * extraído, venga de un lector de PDF, de la IA o de un agente vía MCP, y lo compara contra lo que hay en Don Bigo.
 * Solo describe diferencias: aplicar cualquier cambio es decisión del usuario en la pantalla de diferencias.
 */

export interface StatementMovement {
  /** Fecha de operación (YYYY-MM-DD), la misma que guarda Don Bigo. */
  date: string;
  /** Fecha de cargo, si el estado de cuenta la trae: decide en qué corte cae. */
  postedDate: string | null;
  description: string;
  chargeMinor: number;
  creditMinor: number;
  last4: string | null;
}

export interface ExtractedStatement {
  bankId: BankId;
  currency: string;
  period: { start: string; cutoff: string; dueDate: string | null };
  /** Totales impresos en el estado de cuenta; sirven para que el lector se compruebe a sí mismo. */
  totals: { chargesMinor: number; creditsMinor: number } | null;
  movements: StatementMovement[];
  /** Planes a meses con su número de pago y saldo pendiente, en el mismo formato que el CSV de planes del banco. */
  plans: BankPlanRow[];
}

/** Movimiento de Don Bigo dentro del periodo del estado de cuenta (lo carga quien llama). */
export interface ExistingMovement {
  id: string;
  date: string;
  description: string;
  chargeMinor: number;
  creditMinor: number;
  last4: string | null;
}

export interface MovementPair {
  statement: StatementMovement;
  existing: ExistingMovement;
}

export interface PlanDifference {
  planId: string;
  planName: string;
  row: BankPlanRow;
  /** Pagos que Don Bigo tiene registrados; el banco dice `row.current`. */
  paidInstallments: number;
  /** Mensualidad en Don Bigo; la del banco es `row.paymentMinor - row.interestMinor`. */
  installmentAmountMinor: number;
}

export interface StatementComparison {
  /** La suma de lo extraído cuadra con los totales impresos; null si el estado de cuenta no los trae. */
  totalsOk: boolean | null;
  matched: MovementPair[];
  /** Mismo movimiento con otro monto. */
  changed: MovementPair[];
  /** En el estado de cuenta y no en Don Bigo. */
  missing: StatementMovement[];
  /** En Don Bigo y no en el estado de cuenta. */
  extra: ExistingMovement[];
  plans: { matched: BalanceMatch[]; differs: PlanDifference[]; missing: BankPlanRow[] };
  /** Corte o fecha límite distintos a los capturados; null si no hay corte capturado. */
  cutoffDiffers: boolean | null;
}

/** El CSV trae la fecha de operación y el estado de cuenta a veces la recorre: días de holgura. */
const DATE_TOLERANCE_DAYS = 3;
const CENT_TOLERANCE = 2;
const PLAN_DATE_TOLERANCE_DAYS = 5;

const tokens = (text: string) => new Set(normalizeDescription(text).split(/[^A-Z0-9]+/).filter((word) => word.length > 1));
function similarity(a: string, b: string): number {
  const left = tokens(a);
  const right = tokens(b);
  if (left.size === 0 || right.size === 0) return 0;
  const shared = [...left].filter((word) => right.has(word)).length;
  return shared / Math.min(left.size, right.size);
}
const sameCard = (a: string | null, b: string | null) => a === null || b === null || a === b;

/** Empareja uno a uno: primero el candidato más cercano en fecha y, a igual fecha, el de descripción más parecida. */
function pairUp(statement: readonly StatementMovement[], existing: readonly ExistingMovement[], accept: (s: StatementMovement, e: ExistingMovement) => boolean) {
  const candidates: { s: number; e: number; distance: number; score: number }[] = [];
  statement.forEach((s, si) =>
    existing.forEach((e, ei) => {
      const distance = Math.abs(daysBetween(s.date, e.date));
      if (accept(s, e)) candidates.push({ s: si, e: ei, distance, score: similarity(s.description, e.description) });
    }),
  );
  candidates.sort((a, b) => a.distance - b.distance || b.score - a.score || a.s - b.s || a.e - b.e);
  const usedS = new Set<number>();
  const usedE = new Set<number>();
  const pairs: MovementPair[] = [];
  for (const { s, e } of candidates) {
    if (usedS.has(s) || usedE.has(e)) continue;
    usedS.add(s);
    usedE.add(e);
    pairs.push({ statement: statement[s]!, existing: existing[e]! });
  }
  return { pairs, restS: statement.filter((_, i) => !usedS.has(i)), restE: existing.filter((_, i) => !usedE.has(i)) };
}

export function compareStatement(
  statement: ExtractedStatement,
  current: { movements: readonly ExistingMovement[]; plans: readonly MatchablePlan[]; cutoff: { date: string; dueDate: string | null } | null },
): StatementComparison {
  const sum = (key: 'chargeMinor' | 'creditMinor') => statement.movements.reduce((total, movement) => total + movement[key], 0);
  const totalsOk = statement.totals ? sum('chargeMinor') === statement.totals.chargesMinor && sum('creditMinor') === statement.totals.creditsMinor : null;

  // Un renglón en $0.00 (reversa de bonificación) no mueve nada y el CSV no lo trae: no se compara.
  const statementMovements = statement.movements.filter((m) => m.chargeMinor !== 0 || m.creditMinor !== 0);
  const exact = pairUp(statementMovements, current.movements, (s, e) =>
    s.chargeMinor === e.chargeMinor && s.creditMinor === e.creditMinor && sameCard(s.last4, e.last4) && Math.abs(daysBetween(s.date, e.date)) <= DATE_TOLERANCE_DAYS,
  );
  // Lo que sobra de ambos lados: mismo día, misma tarjeta y descripción parecida = mismo movimiento con otro monto.
  const loose = pairUp(exact.restS, exact.restE, (s, e) =>
    sameCard(s.last4, e.last4) && Math.abs(daysBetween(s.date, e.date)) <= 1 && similarity(s.description, e.description) >= 0.5,
  );

  const planMatch = matchBankPlans(statement.plans, current.plans);
  const matched = [...planMatch.matches];
  const matchedIds = new Set(matched.map((match) => match.planId));
  const differs: PlanDifference[] = [];
  const missing: BankPlanRow[] = [];
  // Lo que no emparejó exacto: mismo plazo y fecha de compra cercana = mismo plan (de preferencia con la misma
  // mensualidad). Incluye filas ya liquidadas en el banco: si Don Bigo lo tiene igual (terminado), coincide.
  for (const row of [...planMatch.unmatched, ...planMatch.closed]) {
    const installment = row.paymentMinor - row.interestMinor;
    const sameAmount = (plan: MatchablePlan) => Math.abs(plan.installmentAmountMinor - installment) <= CENT_TOLERANCE;
    const candidates = current.plans.filter(
      (plan) =>
        !matchedIds.has(plan.id) &&
        plan.totalInstallments === row.total &&
        // Banorte pone la fecha de compra; Banamex, la del cargo de este mes (pago número `row.current`).
        [plan.firstChargeDate, addMonthsISO(plan.firstChargeDate, row.current - 1)].some((date) => Math.abs(daysBetween(date, row.date)) <= PLAN_DATE_TOLERANCE_DAYS),
    );
    const plan = candidates.find(sameAmount) ?? candidates[0];
    if (!plan) {
      if (row.pendingMinor !== 0) missing.push(row);
      continue;
    }
    matchedIds.add(plan.id);
    // Ya liquidado en el banco con los mismos pagos: el último cargo suele traer el ajuste de redondeo.
    if (plan.paidInstallments === row.current && (sameAmount(plan) || row.pendingMinor === 0)) matched.push({ planId: plan.id, planName: plan.name, row });
    else differs.push({ planId: plan.id, planName: plan.name, row, paidInstallments: plan.paidInstallments, installmentAmountMinor: plan.installmentAmountMinor });
  }

  return {
    totalsOk,
    matched: exact.pairs,
    changed: loose.pairs,
    missing: loose.restS,
    extra: loose.restE,
    plans: { matched, differs, missing },
    cutoffDiffers: current.cutoff
      ? current.cutoff.date !== statement.period.cutoff || (statement.period.dueDate !== null && current.cutoff.dueDate !== statement.period.dueDate)
      : null,
  };
}
