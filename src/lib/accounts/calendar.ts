import { cardDuesInMonth } from '../agenda/card-payments';
import type { SpendRow } from '../spending/analysis';
import { currentCutoffMonth, cutoffInMonth, summarizeStatement, type RealCut } from '../spending/statement';
import type { CardTone } from './validation';

/**
 * Cuentas: calendario de cortes y pagos del mes, estado de la última carga e historial de cortes. Funciones puras; las
 * páginas pasan los cortes reales (`realCuts`) y, para el historial, los movimientos de cada corte.
 */

export interface CalendarAccount {
  accountId: string;
  accountName: string;
  last4: string | null;
  tone: CardTone;
  currency: string;
  cutoffDay: number | null;
  paymentDueDay: number | null;
  cuts: RealCut[];
}

export interface CalendarMark {
  /** Día del mes (1-31). */
  day: number;
  kind: 'cut' | 'due';
  accountId: string;
  /** Sin corte real capturado: la fecha sale del día de corte o de pago de la tarjeta. */
  estimated: boolean;
}

/** Corte y fecha límite de pago de cada cuenta que caen en `month` (`YYYY-MM`). */
export function monthMarks(accounts: readonly CalendarAccount[], month: string, todayISO: string): CalendarMark[] {
  const marks: CalendarMark[] = [];
  for (const account of accounts) {
    const real = account.cuts.find((cut) => cut.cutoff.startsWith(month));
    const cutDate = real?.cutoff ?? (account.cutoffDay !== null ? cutoffInMonth(account.cutoffDay, month) : null);
    if (cutDate) marks.push({ day: Number(cutDate.slice(8)), kind: 'cut', accountId: account.accountId, estimated: !real });
    if (account.paymentDueDay !== null) {
      const dues = cardDuesInMonth({ cardId: account.accountId, accountName: account.accountName, currency: account.currency, cutoffDay: account.cutoffDay, paymentDueDay: account.paymentDueDay, cuts: account.cuts, month, todayISO });
      for (const due of dues) marks.push({ day: Number(due.dueDate.slice(8)), kind: 'due', accountId: account.accountId, estimated: due.recordedPayMinor === null && !account.cuts.some((cut) => cut.month === due.cutMonth) });
    }
  }
  return marks.sort((a, b) => a.day - b.day || a.kind.localeCompare(b.kind));
}

export type CutState = { state: 'none' } | { state: 'ok'; lastMonth: string } | { state: 'late'; lastMonth: string; expectedMonth: string };

/**
 * ¿Ya se cargó el último corte que ocurrió? Con el día de corte de la tarjeta se sabe qué corte ya cerró; si el último
 * corte real es anterior, falta cargarlo. Sin día de corte no se puede saber y se da por bueno.
 */
export function cutState(cuts: readonly RealCut[], cutoffDay: number | null, todayISO: string): CutState {
  const last = cuts.at(-1);
  if (!last) return { state: 'none' };
  if (cutoffDay === null) return { state: 'ok', lastMonth: last.month };
  const expectedMonth = currentCutoffMonth(cutoffDay, todayISO);
  return last.month < expectedMonth ? { state: 'late', lastMonth: last.month, expectedMonth } : { state: 'ok', lastMonth: last.month };
}

export interface CutHistoryRow {
  month: string;
  cutoff: string;
  dueDate: string | null;
  payMinor: number;
  basis: 'official' | 'estimate';
  planMinor: number;
  purchasesMinor: number;
}

/** Cortes de la cuenta, del más reciente al más antiguo (hasta `limit`), con su pago y su desglose. */
export function cutHistory(cuts: readonly RealCut[], rowsByMonth: ReadonlyMap<string, readonly SpendRow[]>, thresholdMinor: number, limit = 6): CutHistoryRow[] {
  return [...cuts]
    .reverse()
    .slice(0, limit)
    .map((cut) => {
      const summary = summarizeStatement(rowsByMonth.get(cut.month) ?? [], thresholdMinor);
      const official = cut.recorded.officialPayMinor;
      return {
        month: cut.month,
        cutoff: cut.cutoff,
        dueDate: cut.dueDate,
        payMinor: official ?? summary.payMinor,
        basis: official !== null ? 'official' : 'estimate',
        planMinor: summary.planChargesMinor,
        purchasesMinor: summary.spendMinor,
      };
    });
}
