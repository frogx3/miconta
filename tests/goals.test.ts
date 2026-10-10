import { describe, expect, it } from 'vitest';
import { antGoalProgress, monthsLeft, planGoalProgress, savingsProgress } from '../src/lib/goals/compute';
import type { PlanFacts } from '../src/lib/plans/schedule';

const plan = (over: Partial<PlanFacts> = {}): PlanFacts => ({
  id: 'p', name: 'p', status: 'active', currency: 'MXN', installmentAmountMinor: 10_000, totalInstallments: 6, paidInstallments: 2,
  firstChargeDate: '2026-08-10', ...over,
});

describe('meses que faltan', () => {
  it('redondea hacia arriba y no es negativo', () => {
    expect(monthsLeft('2026-10-09', '2026-10-09')).toBe(0);
    expect(monthsLeft('2026-10-09', '2026-09-01')).toBe(0);
    expect(monthsLeft('2026-10-09', '2026-10-10')).toBe(1);
    expect(monthsLeft('2026-10-09', '2026-11-09')).toBe(1);
    expect(monthsLeft('2026-10-09', '2026-11-10')).toBe(2);
    expect(monthsLeft('2026-10-09', '2027-10-09')).toBe(12);
  });
});

describe('meta de libertad de pagos', () => {
  // Plan: 6 pagos de 100, primero 10-ago → 10-ago, 10-sep, 10-oct, 10-nov, 10-dic, 10-ene. Pagados 2 → faltan 4 (oct..ene).
  it('en camino si las mensualidades alcanzan antes de la fecha', () => {
    const progress = planGoalProgress([plan()], '2027-02-01', '2026-10-09');
    expect(progress).toMatchObject({ state: 'on_track', remainingMinor: 40_000, leftoverMinor: 0, extraMonthlyMinor: 0, naturalEnd: '2027-01-10' });
    expect(progress.marginDays).toBe(22);
  });

  it('atrasada: calcula lo que sobra y el abono extra mensual', () => {
    // A 10-dic solo caben oct, nov, dic = 300 de 400; sobran 100 y faltan 3 meses → 33.34 al mes.
    const progress = planGoalProgress([plan()], '2026-12-10', '2026-10-09');
    expect(progress).toMatchObject({ state: 'behind', scheduledBeforeMinor: 30_000, leftoverMinor: 10_000, extraMonthlyMinor: 3_334, monthsLeft: 3 });
    expect(progress.marginDays).toBe(-31);
  });

  it('con saldo real del banco usa ese saldo (el interés no está en la mensualidad)', () => {
    const progress = planGoalProgress([plan({ reportedBalanceMinor: 45_000, reportedBalancePaid: 2 })], '2027-02-01', '2026-10-09');
    // Mensualidades alcanzan 40_000 de 45_000 → sobran 5_000 aunque el calendario termine a tiempo.
    expect(progress).toMatchObject({ remainingMinor: 45_000, scheduledBeforeMinor: 40_000, leftoverMinor: 5_000, state: 'behind' });
  });

  it('vencida cuando la fecha pasó y aún hay deuda; lograda cuando no queda nada', () => {
    expect(planGoalProgress([plan()], '2026-10-01', '2026-10-09').state).toBe('overdue');
    expect(planGoalProgress([plan({ status: 'completed_natural' })], '2026-12-01', '2026-10-09')).toMatchObject({ state: 'achieved', remainingMinor: 0, paidRatio: 1 });
    expect(planGoalProgress([], '2026-12-01', '2026-10-09').state).toBe('achieved');
  });

  it('suma varios planes y mide el avance por lo ya pagado', () => {
    const progress = planGoalProgress([plan({ id: 'a' }), plan({ id: 'b', installmentAmountMinor: 20_000 })], '2027-02-01', '2026-10-09');
    expect(progress.remainingMinor).toBe(40_000 + 80_000);
    expect(progress.paidRatio).toBeCloseTo((2 * 10_000 + 2 * 20_000) / (6 * 10_000 + 6 * 20_000), 5);
  });

  it('un plan liquidado a mano o por revisar: solo cuentan los abiertos', () => {
    const progress = planGoalProgress([plan({ id: 'a', status: 'settled_manual' }), plan({ id: 'b', status: 'review' })], '2027-02-01', '2026-10-09');
    expect(progress.remainingMinor).toBe(40_000);
  });
});

describe('meta de ahorro', () => {
  it('lograda al alcanzar el monto', () => {
    expect(savingsProgress(100_000, 100_000, '2027-01-01', '2026-10-01', '2026-10-09')).toMatchObject({ state: 'achieved', ratio: 1, remainingMinor: 0 });
    expect(savingsProgress(100_000, 150_000, null, '2026-10-01', '2026-10-09').state).toBe('achieved');
  });

  it('en camino o atrasada contra el avance lineal', () => {
    // 100 días entre creación y fecha; hoy van 50 → se esperan 50_000.
    expect(savingsProgress(100_000, 50_000, '2027-01-09', '2026-10-01', '2026-11-20')).toMatchObject({ state: 'on_track' });
    expect(savingsProgress(100_000, 20_000, '2027-01-09', '2026-10-01', '2026-11-20')).toMatchObject({ state: 'behind', remainingMinor: 80_000 });
  });

  it('calcula el aporte mensual y marca vencida si la fecha pasó', () => {
    expect(savingsProgress(100_000, 40_000, '2027-02-09', '2026-10-09', '2026-10-09')).toMatchObject({ neededPerMonthMinor: 15_000, monthsLeft: 4 });
    expect(savingsProgress(100_000, 40_000, '2026-10-01', '2026-09-01', '2026-10-09')).toMatchObject({ state: 'overdue', neededPerMonthMinor: 60_000 });
  });

  it('sin fecha no hay aporte sugerido', () => {
    expect(savingsProgress(100_000, 10_000, null, '2026-10-01', '2026-10-09')).toMatchObject({ state: 'on_track', neededPerMonthMinor: null });
  });
});

describe('meta de gasto hormiga', () => {
  const points = [
    { month: '2026-07', antMinor: 180_000, spendMinor: 900_000 },
    { month: '2026-08', antMinor: 120_000, spendMinor: 800_000 },
    { month: '2026-09', antMinor: 90_000, spendMinor: 700_000 },
    { month: '2026-10', antMinor: 130_000, spendMinor: 300_000 },
  ];
  it('compara el mes en curso con el tope y cuenta los meses cerrados bajo el tope', () => {
    const progress = antGoalProgress(150_000, points, '2026-10');
    expect(progress).toMatchObject({ currentMinor: 130_000, monthsUnder: 2, monthsMeasured: 3 });
    expect(progress.status.state).toBe('warn');
  });
  it('sin gasto en el mes, está en cero y no hay meses medidos si no hay historial', () => {
    expect(antGoalProgress(150_000, [], '2026-10')).toMatchObject({ currentMinor: 0, monthsMeasured: 0, status: { state: 'ok' } });
  });
});
