import type { CardTone } from '../accounts/validation';
import { analyzeRows, annualized, type MerchantTotal, type SpendRow } from '../spending/analysis';
import { summarizeStatement, type RealCut } from '../spending/statement';

/**
 * Portada por corte: junta todas las cuentas con tarjeta de crédito en una moneda. Cada cuenta tiene sus propios cortes;
 * «el corte de noviembre» es, en cada cuenta, el que cierra en noviembre (si lo hay). Funciones puras: `load.ts` consulta
 * la base y les pasa los movimientos ya filtrados por periodo.
 */

export interface DashboardAccount {
  accountId: string;
  accountName: string;
  /** Tarjeta de crédito principal de la cuenta: su terminación, color, límite y días de corte y pago. */
  last4: string | null;
  tone: CardTone;
  creditLimitMinor: number | null;
  cuts: RealCut[];
  /** Movimientos de cada corte pedido (`YYYY-MM`), en la moneda de la portada. */
  rowsByMonth: ReadonlyMap<string, readonly SpendRow[]>;
  /** Movimientos desde el último corte (periodo en curso). */
  openRows: readonly SpendRow[];
  /** Saldo pendiente de los planes de las tarjetas de la cuenta. */
  plansRemainingMinor: number;
}

/** Meses de corte que existen en alguna cuenta, del más antiguo al más reciente. */
export function dashboardMonths(accounts: readonly Pick<DashboardAccount, 'cuts'>[]): string[] {
  return [...new Set(accounts.flatMap((account) => account.cuts.map((cut) => cut.month)))].sort();
}

export interface MonthSelection {
  month: string | null;
  prev: string | null;
  next: string | null;
  /** Hasta 6 cortes que terminan en `month` (para el historial y los promedios). */
  window: string[];
}

/** El corte pedido si existe; si no, el más reciente. */
export function selectMonth(months: readonly string[], requested: string | null, size = 6): MonthSelection {
  const month = requested && months.includes(requested) ? requested : (months.at(-1) ?? null);
  const index = month ? months.indexOf(month) : -1;
  return {
    month,
    prev: index > 0 ? months[index - 1]! : null,
    next: index >= 0 && index < months.length - 1 ? months[index + 1]! : null,
    window: index >= 0 ? months.slice(Math.max(0, index - size + 1), index + 1) : [],
  };
}

export interface CardCut {
  accountId: string;
  accountName: string;
  last4: string | null;
  tone: CardTone;
  dueDate: string | null;
  /** Pago para no generar intereses: el del estado de cuenta si se capturó; si no, el estimado con los movimientos. */
  payMinor: number;
  basis: 'official' | 'estimate';
  /** Parte del pago que son mensualidades de planes. */
  planChargesMinor: number;
}

export interface CategoryLine {
  categoryId: string | null;
  amountMinor: number;
  /** Promedio por corte en la ventana (incluye el corte elegido). */
  averageMinor: number;
}

export interface HistoryPoint {
  month: string;
  planMinor: number;
  /** Gasto del corte que no es hormiga. */
  purchasesMinor: number;
  antMinor: number;
}

export interface CutSections {
  cards: CardCut[];
  payTotalMinor: number;
  spendMinor: number;
  categories: CategoryLine[];
  history: HistoryPoint[];
  ant: { amountMinor: number; count: number; yearlyMinor: number; top: MerchantTotal[] };
}

const rowsOf = (accounts: readonly DashboardAccount[], month: string) => accounts.flatMap((account) => [...(account.rowsByMonth.get(month) ?? [])]);

/** Lo que muestra la portada del corte elegido. `thresholdMinor` es el umbral de hormiga de la moneda. */
export function buildCutSections(accounts: readonly DashboardAccount[], selection: MonthSelection, currency: string, thresholdMinor: number, topCategories = 6): CutSections | null {
  const month = selection.month;
  if (!month) return null;
  const thresholdOf = () => thresholdMinor;

  const cards: CardCut[] = accounts.flatMap((account) => {
    const cut = account.cuts.find((entry) => entry.month === month);
    if (!cut) return [];
    const summary = summarizeStatement(account.rowsByMonth.get(month) ?? [], thresholdMinor);
    const official = cut.recorded.officialPayMinor;
    return [
      {
        accountId: account.accountId,
        accountName: account.accountName,
        last4: account.last4,
        tone: account.tone,
        dueDate: cut.dueDate,
        payMinor: official ?? summary.payMinor,
        basis: official !== null ? 'official' : 'estimate',
        planChargesMinor: summary.planChargesMinor,
      },
    ];
  });

  const analysisOf = (m: string) => analyzeRows(rowsOf(accounts, m), m, thresholdOf).find((entry) => entry.currency === currency);
  const analyses = new Map(selection.window.map((m) => [m, analysisOf(m)]));
  const current = analyses.get(month);

  // Promedio por categoría en la ventana: suma de cada corte entre el número de cortes (un corte sin gasto cuenta como 0).
  const totals = new Map<string, number>();
  for (const analysis of analyses.values()) for (const line of analysis?.byCategory ?? []) totals.set(line.categoryId ?? '', (totals.get(line.categoryId ?? '') ?? 0) + line.amountMinor);
  const categories = (current?.byCategory ?? []).slice(0, topCategories).map((line) => ({
    categoryId: line.categoryId,
    amountMinor: line.amountMinor,
    averageMinor: Math.round((totals.get(line.categoryId ?? '') ?? 0) / selection.window.length),
  }));

  return {
    cards: cards.sort((a, b) => b.payMinor - a.payMinor || a.accountName.localeCompare(b.accountName)),
    payTotalMinor: cards.reduce((total, card) => total + card.payMinor, 0),
    spendMinor: current?.spendMinor ?? 0,
    categories,
    history: selection.window.map((m) => {
      const analysis = analyses.get(m);
      return { month: m, planMinor: analysis?.planChargesMinor ?? 0, purchasesMinor: (analysis?.spendMinor ?? 0) - (analysis?.antMinor ?? 0), antMinor: analysis?.antMinor ?? 0 };
    }),
    ant: { amountMinor: current?.antMinor ?? 0, count: current?.antCount ?? 0, yearlyMinor: annualized(current?.antMinor ?? 0), top: (current?.topAnt ?? []).slice(0, 5) },
  };
}

export interface LineUsage {
  accountId: string;
  accountName: string;
  last4: string | null;
  tone: CardTone;
  limitMinor: number;
  plansMinor: number;
  /** Cargos desde el último corte (estimación de lo que se ha usado y aún no se paga). */
  openChargesMinor: number;
  /** (planes + compras) / límite; puede pasar de 1. */
  share: number;
}

/** Uso de la línea de cada cuenta con límite capturado: saldo de planes + cargos del corte en curso. Hoy, no por corte. */
export function lineUsage(accounts: readonly DashboardAccount[]): LineUsage[] {
  return accounts
    .filter((account) => (account.creditLimitMinor ?? 0) > 0)
    .map((account) => {
      // Las mensualidades ya están en el saldo de planes: solo cuentan los cargos que no son de un plan.
      const openChargesMinor = account.openRows.filter((row) => row.chargeMinor > 0 && row.planId === null).reduce((total, row) => total + row.chargeMinor, 0);
      const limitMinor = account.creditLimitMinor!;
      return {
        accountId: account.accountId,
        accountName: account.accountName,
        last4: account.last4,
        tone: account.tone,
        limitMinor,
        plansMinor: account.plansRemainingMinor,
        openChargesMinor,
        share: (account.plansRemainingMinor + openChargesMinor) / limitMinor,
      };
    })
    .sort((a, b) => b.share - a.share);
}
