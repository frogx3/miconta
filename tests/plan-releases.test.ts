import { describe, expect, it } from 'vitest';
import { bankComparison, releases } from '../src/lib/plans/releases';
import type { PlanFacts } from '../src/lib/plans/schedule';

const plan = (id: string, firstChargeDate: string, total: number, paid: number, amount: number, extra: Partial<PlanFacts> = {}): PlanFacts => ({
  id,
  name: id,
  status: 'active',
  currency: 'MXN',
  installmentAmountMinor: amount,
  totalInstallments: total,
  paidInstallments: paid,
  firstChargeDate,
  ...extra,
});

describe('cuándo se libera tu dinero', () => {
  it('agrupa por mes del último pago y suma lo que deja de pagarse', () => {
    const list = [
      plan('Refri', '2026-06-06', 12, 6, 1_250_00),
      plan('Pantalla', '2026-11-06', 6, 1, 800_00),
      plan('Laptop', '2026-08-06', 9, 4, 2_000_00),
      plan('Dólares', '2026-06-06', 12, 6, 50_00, { currency: 'USD' }),
      plan('Liquidado', '2026-06-06', 12, 6, 999_00, { status: 'settled_manual' }),
    ];
    expect(releases(list, 'MXN', '2026-11-26')).toEqual([
      { month: '2027-04', freedMinor: 2_800_00, plans: [{ id: 'Laptop', name: 'Laptop' }, { id: 'Pantalla', name: 'Pantalla' }] },
      { month: '2027-05', freedMinor: 1_250_00, plans: [{ id: 'Refri', name: 'Refri' }] },
    ]);
  });

  it('usa la fecha de pago (según el corte) si se conoce', () => {
    const payDateOf = (_plan: PlanFacts, chargeISO: string) => (chargeISO === '2027-01-06' ? '2027-02-03' : null);
    expect(releases([plan('Viaje', '2026-12-06', 2, 1, 500_00)], 'MXN', '2026-11-26', payDateOf).map((entry) => entry.month)).toEqual(['2027-02']);
  });
});

describe('saldo del banco contra Don Bigo', () => {
  it('compara con las mensualidades que faltaban a la fecha del reporte', () => {
    const base = { totalInstallments: 12, installmentAmountMinor: 1_250_00 };
    expect(bankComparison({ ...base, reportedBalanceMinor: 6_300_00, reportedBalanceDate: '2026-11-04', reportedBalancePaid: 7 })).toEqual({ date: '2026-11-04', reportedMinor: 6_300_00, estimateMinor: 6_250_00, diffMinor: 50_00 });
    expect(bankComparison({ ...base, reportedBalanceMinor: null, reportedBalanceDate: null, reportedBalancePaid: null })).toBeNull();
  });
});
