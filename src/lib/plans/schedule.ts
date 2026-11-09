import { scheduledDate, naturalEndDate, remainingBalanceMinor } from '../import/plans';
import { daysBetween } from '../import/dates';
import type { PlanStatus } from '../import/types';
import { shiftMonth } from '../spending/analysis';
import { addDays, cutoffInMonth, dueDateFor, type RealCut } from '../spending/statement';

/** Lo que necesitan los cálculos de un plan; lo cumple una fila de la base. */
export interface PlanFacts {
  id: string;
  name: string;
  status: PlanStatus;
  currency: string;
  installmentAmountMinor: number;
  totalInstallments: number;
  paidInstallments: number;
  firstChargeDate: string;
  /** Saldo que reportó el banco y los pagos hechos entonces (ver `remainingBalanceMinor`). */
  reportedBalanceMinor?: number | null;
  reportedBalancePaid?: number | null;
}

/** Un plan debe dinero mientras esté activo o por revisar. */
export const isOpen = (plan: Pick<PlanFacts, 'status'>): boolean => plan.status === 'active' || plan.status === 'review';

/** Fecha en que se paga un cargo de un plan (ver `paymentDateFor`); nula si su tarjeta no tiene corte. */
export type PayDateOf = (plan: PlanFacts & { cardId?: string }, chargeISO: string) => string | null;
const noPayDate: PayDateOf = () => null;

/** Fecha en que se paga la última mensualidad; sin corte, la del último cargo. */
export const lastPayDate = (plan: PlanFacts, payDateOf: PayDateOf = noPayDate): string => payDateOf(plan, naturalEndDate(plan)) ?? naturalEndDate(plan);

/** Abierto, o liquidado de forma natural cuya última mensualidad (ya cargada) aún no vence: todavía se paga. */
export const stillPaying = (plan: PlanFacts, todayISO: string, payDateOf: PayDateOf = noPayDate): boolean =>
  isOpen(plan) || (plan.status === 'completed_natural' && (payDateOf(plan, naturalEndDate(plan)) ?? '') >= todayISO);

/** `charged` = el banco ya lo cargó, pero la fecha límite del corte donde cayó aún no llega. */
export type InstallmentState = 'paid' | 'charged' | 'next' | 'upcoming' | 'overdue' | 'waived';

export interface ScheduleRow {
  no: number;
  /** Fecha de operación del cargo (la que trae el CSV y el estado de cuenta). */
  date: string;
  /** Fecha límite de pago del corte en que cae el cargo; nula si la tarjeta no tiene corte. */
  payDate: string | null;
  amountMinor: number;
  state: InstallmentState;
}

/**
 * Fecha en que se paga un cargo: la fecha límite del corte que lo incluye. Manda el corte real capturado (los bancos no
 * cortan siempre el mismo día); después del último, se estima con el día de corte de la tarjeta.
 */
export function paymentDateFor(chargeISO: string, cuts: readonly RealCut[], cutoffDay: number | null, paymentDueDay: number | null): string | null {
  // Una mensualidad con fecha de un día antes del corte (o el mismo) pasa al corte siguiente: Banorte cargó AutoZone 3/9
  // (operación 3-sep) en el corte del 2-oct, no en el del 4-sep. shortcut: regla vista en Banorte; si otro banco difiere, hacerla por tarjeta.
  const earliest = addDays(chargeISO, 2);
  const lastReal = cuts.at(-1);
  // Solo dentro de lo que cubren los cortes capturados; antes del primero o después del último se estima.
  if (lastReal && chargeISO >= cuts[0]!.from && earliest <= lastReal.cutoff) return cuts.find((cut) => cut.cutoff >= earliest)!.dueDate;
  if (cutoffDay === null) return null;
  const month = earliest.slice(0, 7);
  const sameMonth = cutoffInMonth(cutoffDay, month);
  return dueDateFor(paymentDueDay, sameMonth >= earliest ? sameMonth : cutoffInMonth(cutoffDay, shiftMonth(month, 1)));
}

/**
 * Calendario completo de pagos de un plan. La siguiente mensualidad pasa a "por registrar" si su
 * fecha ya pasó por más de `graceDays` (el banco suele postear unos días después).
 * Un plan liquidado a mano deja sus pagos pendientes como "liquidado" (ya no se deben). Con `payDateOf` cada fila trae la
 * fecha en que se paga, y un cargo registrado queda "cargado" (no "pagado") hasta que pasa esa fecha.
 */
export function buildSchedule(plan: PlanFacts, todayISO: string, graceDays = 5, payDateOf: (chargeISO: string) => string | null = () => null): ScheduleRow[] {
  return Array.from({ length: plan.totalInstallments }, (_, index) => {
    const no = index + 1;
    const date = scheduledDate(plan, no);
    const payDate = payDateOf(date);
    let state: InstallmentState;
    if (plan.status === 'completed_natural' || no <= plan.paidInstallments) state = payDate && payDate >= todayISO ? 'charged' : 'paid';
    else if (plan.status === 'settled_manual') state = 'waived';
    else if (no === plan.paidInstallments + 1) state = daysBetween(date, todayISO) > graceDays ? 'overdue' : 'next';
    else state = 'upcoming';
    return { no, date, payDate, amountMinor: plan.installmentAmountMinor, state };
  });
}

export interface MonthRow {
  /** `YYYY-MM` */
  month: string;
  amountMinor: number;
  plans: number;
  /** Pagos cuya fecha ya pasó y siguen sin registrarse; se cuentan en el mes actual. */
  overdue: number;
}

export interface CurrencySummary {
  currency: string;
  openPlans: number;
  remainingBalanceMinor: number;
  /** Lo que vence en el mes actual (incluye lo pendiente de registrar). */
  thisMonthMinor: number;
  overdueInstallments: number;
  /** Fecha del último pago de todos los planes abiertos. */
  debtFreeDate: string | null;
  months: MonthRow[];
}

const monthOf = (iso: string) => iso.slice(0, 7);

function nextMonth(month: string): string {
  const [year, number] = month.split('-').map(Number) as [number, number];
  return number === 12 ? `${year + 1}-01` : `${year}-${String(number + 1).padStart(2, '0')}`;
}

/**
 * Resumen por moneda de los planes abiertos: deuda restante, compromiso de este mes, fecha en que
 * terminan todos los pagos y la proyección mes a mes ("escalera" de compromisos). Nunca mezcla monedas.
 */
export function summarize(plans: PlanFacts[], todayISO: string, maxMonths = 36, payDateOf: PayDateOf = noPayDate): CurrencySummary[] {
  const currentMonth = monthOf(todayISO);
  const byCurrency = new Map<string, PlanFacts[]>();
  for (const plan of plans.filter((plan) => stillPaying(plan, todayISO, payDateOf))) byCurrency.set(plan.currency, [...(byCurrency.get(plan.currency) ?? []), plan]);

  return [...byCurrency]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, open]) => {
      const buckets = new Map<string, { amountMinor: number; planIds: Set<string>; overdue: number }>();
      let lastMonth = currentMonth;
      let overdueInstallments = 0;

      for (const plan of open) {
        for (let no = 1; no <= plan.totalInstallments; no++) {
          const date = scheduledDate(plan, no);
          const payDate = payDateOf(plan, date);
          const charged = plan.status === 'completed_natural' || no <= plan.paidInstallments;
          // Un cargo registrado cuenta hasta su fecha límite; sin fecha de pago se da por pagado (como antes).
          if (charged && !(payDate && payDate >= todayISO)) continue;
          const late = !charged && monthOf(date) < currentMonth;
          const month = late ? currentMonth : monthOf(payDate ?? date);
          if (month > lastMonth) lastMonth = month;
          const bucket = buckets.get(month) ?? { amountMinor: 0, planIds: new Set<string>(), overdue: 0 };
          bucket.amountMinor += plan.installmentAmountMinor;
          bucket.planIds.add(plan.id);
          if (late) {
            bucket.overdue++;
            overdueInstallments++;
          }
          buckets.set(month, bucket);
        }
      }

      const months: MonthRow[] = [];
      for (let month = currentMonth; month <= lastMonth && months.length < maxMonths; month = nextMonth(month)) {
        const bucket = buckets.get(month);
        months.push({ month, amountMinor: bucket?.amountMinor ?? 0, plans: bucket?.planIds.size ?? 0, overdue: bucket?.overdue ?? 0 });
      }

      const ends = open.map((plan) => lastPayDate(plan, payDateOf));
      return {
        currency,
        openPlans: open.length,
        remainingBalanceMinor: open.reduce((sum, plan) => sum + (isOpen(plan) ? remainingBalanceMinor(plan) : 0), 0),
        thisMonthMinor: months[0]?.amountMinor ?? 0,
        overdueInstallments,
        debtFreeDate: ends.length ? ends.reduce((a, b) => (a > b ? a : b)) : null,
        months,
      };
    });
}

/** Un plan con la tarjeta a la que pertenece. */
export type CardPlanFacts = PlanFacts & { cardId: string; cardName: string };

export interface CardSummary {
  cardId: string;
  cardName: string;
  currency: string;
  openPlans: number;
  remainingBalanceMinor: number;
  /** Lo que vence este mes en esa tarjeta (incluye lo pendiente de registrar). */
  thisMonthMinor: number;
  overdueInstallments: number;
  debtFreeDate: string | null;
}

/**
 * Totales por tarjeta de los planes abiertos, agrupados por moneda (nunca mezcla monedas). Una tarjeta sin
 * planes abiertos no aparece. Las tarjetas salen por mayor compromiso de este mes y luego por nombre.
 */
export function summarizeByCard(plans: CardPlanFacts[], todayISO: string, payDateOf: PayDateOf = noPayDate): { currency: string; cards: CardSummary[] }[] {
  const byCard = new Map<string, CardPlanFacts[]>();
  for (const plan of plans.filter((plan) => stillPaying(plan, todayISO, payDateOf))) byCard.set(plan.cardId, [...(byCard.get(plan.cardId) ?? []), plan]);

  const byCurrency = new Map<string, CardSummary[]>();
  for (const [cardId, group] of byCard) {
    // Una tarjeta tiene una sola moneda; si por datos viejos mezclara, `summarize` ya las separa.
    for (const summary of summarize(group, todayISO, 1, payDateOf)) {
      const entry: CardSummary = {
        cardId,
        cardName: group[0]!.cardName,
        currency: summary.currency,
        openPlans: summary.openPlans,
        remainingBalanceMinor: summary.remainingBalanceMinor,
        thisMonthMinor: summary.thisMonthMinor,
        overdueInstallments: summary.overdueInstallments,
        debtFreeDate: summary.debtFreeDate,
      };
      byCurrency.set(summary.currency, [...(byCurrency.get(summary.currency) ?? []), entry]);
    }
  }
  return [...byCurrency]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, cards]) => ({ currency, cards: cards.sort((a, b) => b.thisMonthMinor - a.thisMonthMinor || a.cardName.localeCompare(b.cardName)) }));
}
