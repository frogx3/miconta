import { lastPayDate, stillPaying, type PayDateOf, type PlanFacts } from './schedule';

/**
 * Cuándo se libera tu dinero: los meses en que planes hacen su último pago. Desde el mes siguiente ya no se paga esa
 * mensualidad. Solo planes que se siguen pagando (abiertos o con la última mensualidad cargada y aún por pagar).
 */
export interface Release {
  /** Mes del último pago (`YYYY-MM`). */
  month: string;
  /** Lo que deja de pagarse cada mes a partir del siguiente. */
  freedMinor: number;
  plans: { id: string; name: string }[];
}

export function releases(plans: readonly PlanFacts[], currency: string, todayISO: string, payDateOf?: PayDateOf): Release[] {
  const byMonth = new Map<string, Release>();
  for (const plan of plans) {
    if (plan.currency !== currency || !stillPaying(plan, todayISO, payDateOf)) continue;
    const month = lastPayDate(plan, payDateOf).slice(0, 7);
    const entry = byMonth.get(month) ?? { month, freedMinor: 0, plans: [] };
    entry.freedMinor += plan.installmentAmountMinor;
    entry.plans.push({ id: plan.id, name: plan.name });
    byMonth.set(month, entry);
  }
  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)).map((entry) => ({ ...entry, plans: entry.plans.sort((a, b) => a.name.localeCompare(b.name)) }));
}

/**
 * «Tu banco dice»: el saldo que reportó el banco (CSV de planes) contra lo que Don Bigo calcula a esa misma fecha
 * (mensualidades que faltaban × monto). La diferencia suele ser intereses o centavos del último pago.
 */
export function bankComparison(plan: { totalInstallments: number; installmentAmountMinor: number; reportedBalanceMinor: number | null; reportedBalanceDate: string | null; reportedBalancePaid: number | null }) {
  if (plan.reportedBalanceMinor == null || plan.reportedBalancePaid == null || !plan.reportedBalanceDate) return null;
  const estimateMinor = Math.max(0, plan.totalInstallments - plan.reportedBalancePaid) * plan.installmentAmountMinor;
  return { date: plan.reportedBalanceDate, reportedMinor: plan.reportedBalanceMinor, estimateMinor, diffMinor: plan.reportedBalanceMinor - estimateMinor };
}
