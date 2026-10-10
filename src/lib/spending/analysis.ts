import { currencyDigits } from '../money-format';
import { mergeMerchantKeys, merchantKey } from './categorize';

/** Lo mínimo de un movimiento que necesita el análisis. */
export interface SpendRow {
  date: string;
  descriptionNorm: string;
  chargeMinor: number;
  creditMinor: number;
  currency: string;
  categoryId: string | null;
  planId: string | null;
}

export const monthOf = (iso: string): string => iso.slice(0, 7);

/** Mes desplazado `delta` meses (`2026-01` − 1 = `2025-12`). */
export function shiftMonth(month: string, delta: number): string {
  const [year, number] = month.split('-').map(Number) as [number, number];
  const index = year * 12 + (number - 1) + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** Los últimos `count` meses terminando en `endMonth`, en orden cronológico. */
export function lastMonths(endMonth: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => shiftMonth(endMonth, i - (count - 1)));
}

/** Umbral por defecto de gasto hormiga: 200 unidades de la moneda (200.00 MXN, 200 JPY...). */
export function defaultAntThreshold(currency: string): number {
  return 200 * 10 ** (currencyDigits(currency) ?? 2);
}

/**
 * Umbral aplicable a una moneda. El que configura el usuario vale para la moneda de su espacio; las
 * demás monedas usan el valor por defecto, porque 200 pesos y 200 dólares no son lo mismo.
 */
export function thresholdFor(currency: string, workspace: { currency: string; thresholdMinor: number | null }): number {
  return currency === workspace.currency && workspace.thresholdMinor ? workspace.thresholdMinor : defaultAntThreshold(currency);
}

/**
 * Cargos que el banco pone por el crédito, no compras: intereses, el IVA sobre intereses y comisiones
 * ("INTERESES SUJETOS A IVA", "IVA SOBRE INTERESES DB", "16.00 % IVA SOBRE COMISIONES E INTERESES",
 * "COMISION ..."). Cuentan en lo que se debe pagar, pero no son gasto ni gasto hormiga.
 */
export const isFinanceCharge = (descriptionNorm: string): boolean =>
  /^(INTERESES\b|IVA SOBRE (INTERESES|COMISION)|\d+(\.\d+)? ?% IVA SOBRE|COMISION(ES)?\b)/.test(descriptionNorm);

type Chargeable = Pick<SpendRow, 'chargeMinor' | 'planId' | 'descriptionNorm'>;

/** Un cargo financiero (intereses, IVA, comisiones) que no pertenece a un plan. */
export const isFinance = (row: Chargeable): boolean => row.chargeMinor > 0 && row.planId === null && isFinanceCharge(row.descriptionNorm);

/** Un gasto es una compra: un cargo que no es de un plan (los planes son compromisos y tienen su propia vista) ni intereses. */
export const isSpend = (row: Chargeable): boolean => row.chargeMinor > 0 && row.planId === null && !isFinanceCharge(row.descriptionNorm);

/** Gasto hormiga: gasto pequeño, igual o menor al umbral. */
export const isAnt = (row: Chargeable, threshold: number): boolean => isSpend(row) && row.chargeMinor <= threshold;

export interface CategoryTotal {
  /** `null` = sin categoría */
  categoryId: string | null;
  amountMinor: number;
  count: number;
  antMinor: number;
}

export interface MerchantTotal {
  key: string;
  amountMinor: number;
  count: number;
  averageMinor: number;
}

export interface MonthAnalysis {
  currency: string;
  month: string;
  thresholdMinor: number;
  spendMinor: number;
  spendCount: number;
  /** Cargos de planes del mes: compromisos, fuera del gasto. */
  planChargesMinor: number;
  /** Intereses, IVA y comisiones del mes: se pagan, pero no son gasto. */
  financeMinor: number;
  antMinor: number;
  antCount: number;
  /** Parte del gasto que es hormiga (0 a 1). */
  antShare: number;
  uncategorizedMinor: number;
  uncategorizedCount: number;
  byCategory: CategoryTotal[];
  topAnt: MerchantTotal[];
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}

/** Análisis de un mes, una entrada por moneda con movimientos ese mes. Nunca mezcla monedas. */
export function analyzeMonth(rows: readonly SpendRow[], month: string, thresholdOf: (currency: string) => number, topLimit = 10): MonthAnalysis[] {
  const inMonth = rows.filter((row) => monthOf(row.date) === month);
  return [...groupBy(inMonth, (row) => row.currency)]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, items]) => {
      const threshold = thresholdOf(currency);
      const spend = items.filter(isSpend);
      const ant = spend.filter((row) => isAnt(row, threshold));
      const sum = (list: SpendRow[]) => list.reduce((total, row) => total + row.chargeMinor, 0);

      const categories = new Map<string, CategoryTotal>();
      for (const row of spend) {
        const key = row.categoryId ?? '';
        const entry = categories.get(key) ?? { categoryId: row.categoryId, amountMinor: 0, count: 0, antMinor: 0 };
        entry.amountMinor += row.chargeMinor;
        entry.count++;
        if (row.chargeMinor <= threshold) entry.antMinor += row.chargeMinor;
        categories.set(key, entry);
      }

      const merged = mergeMerchantKeys(ant.map((row) => merchantKey(row.descriptionNorm)));
      const merchants = new Map<string, { amountMinor: number; count: number }>();
      for (const row of ant) {
        const key = merged.get(merchantKey(row.descriptionNorm))!;
        const entry = merchants.get(key) ?? { amountMinor: 0, count: 0 };
        entry.amountMinor += row.chargeMinor;
        entry.count++;
        merchants.set(key, entry);
      }

      const uncategorized = categories.get('');
      const spendMinor = sum(spend);
      return {
        currency,
        month,
        thresholdMinor: threshold,
        spendMinor,
        spendCount: spend.length,
        planChargesMinor: sum(items.filter((row) => row.chargeMinor > 0 && row.planId !== null)),
        financeMinor: sum(items.filter(isFinance)),
        antMinor: sum(ant),
        antCount: ant.length,
        antShare: spendMinor > 0 ? sum(ant) / spendMinor : 0,
        uncategorizedMinor: uncategorized?.amountMinor ?? 0,
        uncategorizedCount: uncategorized?.count ?? 0,
        byCategory: [...categories.values()].sort((a, b) => b.amountMinor - a.amountMinor || b.count - a.count),
        topAnt: [...merchants]
          .map(([key, value]) => ({ key, ...value, averageMinor: Math.round(value.amountMinor / value.count) }))
          .sort((a, b) => b.amountMinor - a.amountMinor || a.key.localeCompare(b.key))
          .slice(0, topLimit),
      };
    });
}

export interface TrendPoint {
  month: string;
  spendMinor: number;
  antMinor: number;
  antCount: number;
}

/** Tendencia mes a mes por moneda (los meses sin movimientos salen en cero, para que sea continua). */
export function trend(rows: readonly SpendRow[], months: string[], thresholdOf: (currency: string) => number): { currency: string; points: TrendPoint[] }[] {
  const currencies = [...new Set(rows.map((row) => row.currency))].sort();
  return currencies.map((currency) => ({
    currency,
    points: months.map((month) => {
      const found = analyzeMonth(rows, month, thresholdOf).find((analysis) => analysis.currency === currency);
      return { month, spendMinor: found?.spendMinor ?? 0, antMinor: found?.antMinor ?? 0, antCount: found?.antCount ?? 0 };
    }),
  }));
}

/** Equivalente anual de un gasto mensual: lo que suma en un año si sigue a este ritmo. */
export const annualized = (monthlyMinor: number): number => monthlyMinor * 12;

export const isMonth = (value: string | null | undefined): value is string => !!value && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);

/** Mes pedido en la URL si es válido; si no, el último con movimientos; si no hay, el actual. */
export function resolveMonth(requested: string | null, latest: string | null, todayISO: string): string {
  return isMonth(requested) ? requested : (latest ?? todayISO.slice(0, 7));
}

/** Primer y último día posibles del mes, como fechas ISO comparables. */
export const monthBounds = (month: string): { from: string; to: string } => ({ from: `${month}-01`, to: `${month}-31` });

export interface BudgetStatus {
  /** Gastado ÷ presupuesto (1 = justo en el presupuesto). */
  ratio: number;
  /** `warn` desde el 80 %; `over` al pasarse. */
  state: 'ok' | 'warn' | 'over';
  /** Lo que queda; negativo si se pasó. */
  remainingMinor: number;
}

export const BUDGET_WARN_RATIO = 0.8;

export function budgetStatus(spentMinor: number, budgetMinor: number): BudgetStatus {
  const ratio = budgetMinor > 0 ? spentMinor / budgetMinor : 0;
  return { ratio, state: ratio > 1 ? 'over' : ratio >= BUDGET_WARN_RATIO ? 'warn' : 'ok', remainingMinor: budgetMinor - spentMinor };
}
