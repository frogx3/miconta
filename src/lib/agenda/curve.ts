import type { DayPoint } from './compute';

export interface CurvePoint {
  date: string;
  /** Saldo con lo agendado; los cobros pendientes no cuentan (pueden no llegar). */
  balanceMinor: number;
  /** El mismo saldo si cada cobro pendiente llega en su fecha. */
  withIncomeMinor: number;
}

/**
 * Curva del saldo día a día del mes (de `monthResult`): el saldo tal cual y otra línea sumando los cobros pendientes en
 * su fecha. Los días en negativo son los de `balanceMinor < 0`.
 */
export function balanceCurve(days: readonly DayPoint[]): CurvePoint[] {
  let income = 0;
  return days.map((day) => {
    income += day.entries.filter((e) => e.kind === 'receivable' && e.status === 'pending').reduce((sum, e) => sum + e.amountMinor, 0);
    return { date: day.date, balanceMinor: day.balanceMinor, withIncomeMinor: day.balanceMinor + income };
  });
}

/** Tramos consecutivos de días con saldo negativo (para sombrearlos). */
export function negativeRuns(points: readonly CurvePoint[]): { from: string; to: string }[] {
  const runs: { from: string; to: string }[] = [];
  for (const point of points) {
    if (point.balanceMinor >= 0) continue;
    const last = runs.at(-1);
    const previous = points[points.indexOf(point) - 1];
    if (last && previous && last.to === previous.date) last.to = point.date;
    else runs.push({ from: point.date, to: point.date });
  }
  return runs;
}
