import { describe, expect, it } from 'vitest';
import { antGoalProgress } from '../src/lib/goals/compute';
import { goalTimeline, goalsTally } from '../src/lib/goals/visual';

describe('formas de las metas', () => {
  it('cuenta las metas por estado', () => {
    expect(goalsTally([{ tone: 'good' }, { tone: 'good' }, { tone: 'bad' }, { tone: 'done' }])).toEqual({ done: 1, good: 2, warn: 0, bad: 1 });
  });

  it('ubica la fecha meta y el último pago en la línea de hoy a la más lejana', () => {
    // Hoy 2026-01-01; la meta, el 2026-01-11; el último pago, el 2026-01-21 (se pasa).
    expect(goalTimeline('2026-01-01', '2026-01-11', '2026-01-21')).toEqual({ targetPct: 50, endPct: 100 });
    expect(goalTimeline('2026-01-01', '2026-01-21', '2026-01-11')).toEqual({ targetPct: 100, endPct: 50 });
    expect(goalTimeline('2026-01-01', '2025-12-01', null)).toEqual({ targetPct: 0, endPct: null });
  });

  it('el tope de hormiga devuelve cada mes cerrado y si quedó bajo el tope', () => {
    const points = [
      { month: '2026-08', antMinor: 120, spendMinor: 500 },
      { month: '2026-09', antMinor: 200, spendMinor: 600 },
      { month: '2026-10', antMinor: 50, spendMinor: 100 },
    ];
    expect(antGoalProgress(150, points, '2026-10').months).toEqual([
      { month: '2026-08', antMinor: 120, under: true },
      { month: '2026-09', antMinor: 200, under: false },
    ]);
  });
});
