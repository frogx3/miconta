import { describe, expect, it } from 'vitest';
import type { DayPoint, Entry } from '../src/lib/agenda/compute';
import { balanceCurve, negativeRuns } from '../src/lib/agenda/curve';

const entry = (kind: Entry['kind'], amountMinor: number, status: Entry['status'] = 'pending'): Entry => ({ key: `${kind}${amountMinor}`, kind, description: 'x', amountMinor, currency: 'MXN', dueDate: '2026-11-01', status, suggested: false });
const day = (date: string, balanceMinor: number, entries: Entry[] = []): DayPoint => ({ date, balanceMinor, entries });

describe('curva del saldo', () => {
  it('suma los cobros pendientes desde su fecha en la línea «si cobras a tiempo»; los hechos ya están en el saldo', () => {
    const curve = balanceCurve([day('2026-11-01', 1_000), day('2026-11-02', -500, [entry('payable', 1_500)]), day('2026-11-03', -500, [entry('receivable', 800), entry('receivable', 300, 'done')]), day('2026-11-04', -500)]);
    expect(curve.map((p) => [p.balanceMinor, p.withIncomeMinor])).toEqual([
      [1_000, 1_000],
      [-500, -500],
      [-500, 300],
      [-500, 300],
    ]);
  });

  it('agrupa los días negativos seguidos', () => {
    const curve = balanceCurve([day('2026-11-01', 10), day('2026-11-02', -1), day('2026-11-03', -2), day('2026-11-04', 5), day('2026-11-05', -3)]);
    expect(negativeRuns(curve)).toEqual([
      { from: '2026-11-02', to: '2026-11-03' },
      { from: '2026-11-05', to: '2026-11-05' },
    ]);
  });
});
