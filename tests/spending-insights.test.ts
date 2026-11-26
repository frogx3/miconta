import { describe, expect, it } from 'vitest';
import { analyzeRows, type SpendRow } from '../src/lib/spending/analysis';
import { categoryTrends, dailySpend, dayAverages, donutSlices, versusAverage } from '../src/lib/spending/insights';

const row = (date: string, chargeMinor: number, extra: Partial<SpendRow> = {}): SpendRow => ({ date, descriptionNorm: 'TIENDA', chargeMinor, creditMinor: 0, currency: 'MXN', categoryId: null, planId: null, ...extra });

describe('gasto día por día', () => {
  // 2026-11-06 es viernes; 07 y 08, fin de semana.
  const days = dailySpend([row('2026-11-06', 100), row('2026-11-07', 300), row('2026-11-07', 100), row('2026-11-08', 500, { planId: 'p1' }), row('2026-11-09', 50, { descriptionNorm: 'INTERESES' })], '2026-11-06', '2026-11-09');

  it('suma solo compras y marca los fines de semana', () => {
    expect(days).toEqual([
      { date: '2026-11-06', spendMinor: 100, weekend: false },
      { date: '2026-11-07', spendMinor: 400, weekend: true },
      { date: '2026-11-08', spendMinor: 0, weekend: true },
      { date: '2026-11-09', spendMinor: 0, weekend: false },
    ]);
  });

  it('promedia por día, fines de semana y entre semana', () => {
    expect(dayAverages(days)).toEqual({ allMinor: 125, weekendMinor: 200, weekdayMinor: 50 });
  });
});

describe('contra el promedio', () => {
  it('compara con los periodos anteriores que tienen gasto', () => {
    const result = versusAverage(1_080, [1_000, 0, 1_000]);
    expect(result?.count).toBe(2);
    expect(result?.delta).toBeCloseTo(0.08);
    expect(versusAverage(900, [])).toBeNull();
    expect(versusAverage(900, [0])).toBeNull();
  });
});

describe('dona y tendencias', () => {
  const analysis = (rows: SpendRow[], key: string) => analyzeRows(rows, key, () => 0)[0];
  const nov = analysis([row('2026-11-01', 500, { categoryId: 'a' }), row('2026-11-01', 300, { categoryId: 'b' }), row('2026-11-01', 150, { categoryId: 'c' }), row('2026-11-01', 50)], '2026-11');

  it('junta en «otras» lo que no cabe', () => {
    expect(donutSlices(nov!.byCategory, 3).map((s) => [s.categoryId, s.amountMinor, s.share])).toEqual([
      ['a', 500, 0.5],
      ['b', 300, 0.3],
      ['other', 200, 0.2],
    ]);
    expect(donutSlices([], 3)).toEqual([]);
  });

  it('sigue las categorías más grandes del último periodo hacia atrás', () => {
    const oct = analysis([row('2026-10-01', 200, { categoryId: 'b' })], '2026-10');
    expect(categoryTrends([{ key: '2026-10', analysis: oct }, { key: '2026-11', analysis: nov }], 2)).toEqual([
      { categoryId: 'a', points: [{ key: '2026-10', amountMinor: 0 }, { key: '2026-11', amountMinor: 500 }] },
      { categoryId: 'b', points: [{ key: '2026-10', amountMinor: 200 }, { key: '2026-11', amountMinor: 300 }] },
    ]);
  });
});
