import type { GoalView, Tone } from './view';

/** Cuántas metas hay en cada estado (para «Vas bien en X de tus N metas»). */
export function goalsTally(views: readonly Pick<GoalView, 'tone'>[]): Record<Tone, number> {
  const tally: Record<Tone, number> = { done: 0, good: 0, warn: 0, bad: 0 };
  for (const view of views) tally[view.tone]++;
  return tally;
}

const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

/**
 * Línea de tiempo de una meta de planes: de hoy (0%) a la fecha más lejana entre la meta y el último pago (100%).
 * Devuelve dónde cae cada una; `endPct` es nulo si ya no quedan pagos.
 */
export function goalTimeline(todayISO: string, targetISO: string, naturalEndISO: string | null): { targetPct: number; endPct: number | null } {
  const start = day(todayISO);
  const finish = Math.max(day(targetISO), naturalEndISO ? day(naturalEndISO) : 0, start + 86_400_000);
  const pct = (iso: string) => Math.min(100, Math.max(0, ((day(iso) - start) / (finish - start)) * 100));
  return { targetPct: pct(targetISO), endPct: naturalEndISO ? pct(naturalEndISO) : null };
}
