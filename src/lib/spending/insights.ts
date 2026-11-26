import { addDays } from './statement';
import { isSpend, type MonthAnalysis, type SpendRow } from './analysis';

/** Gasto de cada día del periodo (compras: sin mensualidades ni intereses), hasta `lastDay`. */
export interface DaySpend {
  date: string;
  spendMinor: number;
  weekend: boolean;
}

export function dailySpend(rows: readonly SpendRow[], from: string, lastDay: string): DaySpend[] {
  const byDate = new Map<string, number>();
  for (const row of rows) if (isSpend(row)) byDate.set(row.date, (byDate.get(row.date) ?? 0) + row.chargeMinor);
  const days: DaySpend[] = [];
  for (let date = from; date <= lastDay; date = addDays(date, 1)) {
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    days.push({ date, spendMinor: byDate.get(date) ?? 0, weekend: weekday === 0 || weekday === 6 });
  }
  return days;
}

/** Promedio por día: de todo el periodo, de los fines de semana y de entre semana (0 si no hay días de ese tipo). */
export function dayAverages(days: readonly DaySpend[]): { allMinor: number; weekendMinor: number; weekdayMinor: number } {
  const avg = (list: readonly DaySpend[]) => (list.length ? Math.round(list.reduce((sum, d) => sum + d.spendMinor, 0) / list.length) : 0);
  return { allMinor: avg(days), weekendMinor: avg(days.filter((d) => d.weekend)), weekdayMinor: avg(days.filter((d) => !d.weekend)) };
}

/**
 * El gasto del periodo contra el promedio de los anteriores. Un corte sin gasto casi siempre es uno sin movimientos
 * cargados: no entra al promedio. Devuelve también cuántos cortes se promediaron (null si ninguno).
 */
export function versusAverage(currentMinor: number, previousMinor: readonly number[]): { delta: number; count: number } | null {
  const loaded = previousMinor.filter((value) => value > 0);
  if (loaded.length === 0) return null;
  const average = loaded.reduce((sum, value) => sum + value, 0) / loaded.length;
  return { delta: (currentMinor - average) / average, count: loaded.length };
}

export interface Slice {
  /** `null` = sin categoría; `'other'` = el resto junto. */
  categoryId: string | null | 'other';
  amountMinor: number;
  share: number;
}

/** Rebanadas de la dona: las `max − 1` categorías más grandes y el resto junto en «otras». */
export function donutSlices(byCategory: MonthAnalysis['byCategory'], max = 6): Slice[] {
  const total = byCategory.reduce((sum, line) => sum + line.amountMinor, 0);
  if (total === 0) return [];
  const head = byCategory.length > max ? byCategory.slice(0, max - 1) : byCategory;
  const rest = byCategory.slice(head.length).reduce((sum, line) => sum + line.amountMinor, 0);
  const slices: Slice[] = head.map((line) => ({ categoryId: line.categoryId, amountMinor: line.amountMinor, share: line.amountMinor / total }));
  if (rest > 0) slices.push({ categoryId: 'other', amountMinor: rest, share: rest / total });
  return slices;
}

/** Tendencia de las categorías más grandes del último periodo, en cada periodo de la serie (0 donde no hubo gasto). */
export function categoryTrends(series: readonly { key: string; analysis: MonthAnalysis | undefined }[], top = 4): { categoryId: string | null; points: { key: string; amountMinor: number }[] }[] {
  const last = series.at(-1)?.analysis;
  return (last?.byCategory ?? []).slice(0, top).map((line) => ({
    categoryId: line.categoryId,
    points: series.map(({ key, analysis }) => ({ key, amountMinor: analysis?.byCategory.find((entry) => entry.categoryId === line.categoryId)?.amountMinor ?? 0 })),
  }));
}
