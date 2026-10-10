import { describe, expect, it } from 'vitest';
import { isValidISODate } from '../src/lib/import/dates';
import { buildSchedule, isOpen, summarize, type PlanFacts } from '../src/lib/plans/schedule';
import { validatePlanEdit } from '../src/lib/plans/validation';

const plan = (overrides: Partial<PlanFacts> & Pick<PlanFacts, 'id' | 'firstChargeDate'>): PlanFacts => ({
  name: overrides.id,
  status: 'active',
  currency: 'MXN',
  installmentAmountMinor: 10_000,
  totalInstallments: 12,
  paidInstallments: 0,
  ...overrides,
});

describe('calendario de pagos', () => {
  const p = plan({ id: 'a', firstChargeDate: '2026-07-03', paidInstallments: 3, totalInstallments: 6, installmentAmountMinor: 90_236 });

  it('marca pagados, el siguiente y los pendientes, con sus fechas', () => {
    const schedule = buildSchedule(p, '2026-10-08');
    expect(schedule.map((r) => [r.no, r.date, r.state])).toEqual([
      [1, '2026-07-03', 'paid'],
      [2, '2026-08-03', 'paid'],
      [3, '2026-09-03', 'paid'],
      [4, '2026-10-03', 'next'],
      [5, '2026-11-03', 'upcoming'],
      [6, '2026-12-03', 'upcoming'],
    ]);
    expect(schedule.every((r) => r.amountMinor === 90_236)).toBe(true);
  });

  it('el siguiente pago pasa a "por registrar" tras los días de gracia', () => {
    expect(buildSchedule(p, '2026-10-08')[3]!.state).toBe('next'); // 5 días: dentro de la gracia
    expect(buildSchedule(p, '2026-10-09')[3]!.state).toBe('overdue');
  });

  it('un plan liquidado de forma natural lo tiene todo pagado; uno liquidado a mano, "liquidado"', () => {
    expect(buildSchedule({ ...p, status: 'completed_natural', paidInstallments: 6 }, '2027-01-01').every((r) => r.state === 'paid')).toBe(true);
    const manual = buildSchedule({ ...p, status: 'settled_manual' }, '2026-10-08');
    expect(manual.map((r) => r.state)).toEqual(['paid', 'paid', 'paid', 'waived', 'waived', 'waived']);
  });

  it('solo los planes activos o por revisar deben dinero', () => {
    expect(['active', 'review', 'completed_natural', 'settled_manual'].map((status) => isOpen({ status: status as PlanFacts['status'] }))).toEqual([true, true, false, false]);
  });
});

describe('resumen y proyección por mes', () => {
  const today = '2026-10-08';
  const plans: PlanFacts[] = [
    // Termina en 2026-12 (le quedan 3: oct, nov, dic)
    plan({ id: 'corto', firstChargeDate: '2026-07-03', totalInstallments: 6, paidInstallments: 3, installmentAmountMinor: 100_000 }),
    // Termina en 2027-02 (le quedan 5: oct..feb)
    plan({ id: 'largo', firstChargeDate: '2026-06-30', totalInstallments: 9, paidInstallments: 4, installmentAmountMinor: 25_225 }),
    // Cerrados: no cuentan
    plan({ id: 'cerrado', firstChargeDate: '2026-01-01', status: 'completed_natural', paidInstallments: 12 }),
    plan({ id: 'manual', firstChargeDate: '2026-01-01', status: 'settled_manual', paidInstallments: 2 }),
    // Otra moneda: no se mezcla
    plan({ id: 'usd', firstChargeDate: '2026-10-15', currency: 'USD', totalInstallments: 2, installmentAmountMinor: 5_000 }),
  ];
  const [mxn, usd] = summarize(plans, today);

  it('agrupa por moneda sin mezclar', () => {
    expect([mxn!.currency, usd!.currency]).toEqual(['MXN', 'USD']);
    expect(mxn!.openPlans).toBe(2);
    expect(usd!.openPlans).toBe(1);
  });

  it('suma la deuda restante y el compromiso de este mes', () => {
    expect(mxn!.remainingBalanceMinor).toBe(3 * 100_000 + 5 * 25_225);
    expect(mxn!.thisMonthMinor).toBe(100_000 + 25_225);
    expect(usd!.remainingBalanceMinor).toBe(2 * 5_000);
  });

  it('da la fecha en que terminan todos los pagos', () => {
    expect(mxn!.debtFreeDate).toBe('2027-02-28');
    expect(usd!.debtFreeDate).toBe('2026-11-15');
  });

  it('proyecta mes a mes y se ve cuánto se libera cuando termina un plan', () => {
    expect(mxn!.months.map((m) => [m.month, m.amountMinor, m.plans])).toEqual([
      ['2026-10', 125_225, 2],
      ['2026-11', 125_225, 2],
      ['2026-12', 125_225, 2],
      ['2027-01', 25_225, 1], // terminó el plan corto: se libera 1,000.00
      ['2027-02', 25_225, 1],
    ]);
  });

  it('los pagos con fecha pasada sin registrar se cuentan en el mes actual y se marcan', () => {
    const late = plan({ id: 'atrasado', firstChargeDate: '2026-07-01', totalInstallments: 6, paidInstallments: 1, installmentAmountMinor: 10_000 });
    const [summary] = summarize([late], today);
    // pagos 2 (ago), 3 (sep) y 4 (oct): los dos primeros están atrasados.
    expect(summary!.overdueInstallments).toBe(2);
    expect(summary!.months[0]).toMatchObject({ month: '2026-10', amountMinor: 30_000, overdue: 2 });
    expect(summary!.months.at(-1)!.month).toBe('2026-12');
  });

  it('sin planes abiertos no hay resumen', () => {
    expect(summarize([plans[2]!, plans[3]!], today)).toEqual([]);
  });

  it('los meses vacíos entre planes también aparecen (la escalera es continua)', () => {
    const gap = [plan({ id: 'x', firstChargeDate: '2026-10-20', totalInstallments: 1 }), plan({ id: 'y', firstChargeDate: '2027-01-20', totalInstallments: 1 })];
    expect(summarize(gap, today)[0]!.months.map((m) => [m.month, m.plans])).toEqual([
      ['2026-10', 1],
      ['2026-11', 0],
      ['2026-12', 0],
      ['2027-01', 1],
    ]);
  });
});

describe('validación de la edición manual', () => {
  const ctx = { locale: 'es-MX', currency: 'MXN' };
  const base = {
    name: 'Seguro', matchText: 'EL AGUILA', type: 'msi', installmentAmount: '902.36', totalAmount: '10,828.32',
    totalInstallments: '12', paidInstallments: '3', firstChargeDate: '2026-07-06', interestRate: '', comment: ' abono ',
  };

  it('acepta y normaliza todos los parámetros', () => {
    expect(validatePlanEdit(base, ctx)).toEqual({
      ok: true,
      value: {
        name: 'Seguro', matchText: 'EL AGUILA', type: 'msi', installmentAmountMinor: 90_236, totalInstallments: 12,
        paidInstallments: 3, totalAmountMinor: 1_082_832, interestRateBp: 0, firstChargeDate: '2026-07-06', comment: 'abono',
      },
    });
  });

  it('permite 0 pagos realizados y un plazo de 1 (p. ej. tras un abono que lo acorta)', () => {
    expect(validatePlanEdit({ ...base, paidInstallments: '0', totalInstallments: '1' }, ctx)).toMatchObject({ ok: true, value: { paidInstallments: 0, totalInstallments: 1 } });
  });

  it('los pagos realizados no pueden superar el plazo', () => {
    expect(validatePlanEdit({ ...base, paidInstallments: '13' }, ctx)).toEqual({ ok: false, errors: [{ field: 'paidInstallments', code: 'current_exceeds_total' }] });
  });

  it('lee la tasa en meses con intereses y la ignora en MSI', () => {
    expect(validatePlanEdit({ ...base, type: 'mci', interestRate: '24.5' }, ctx)).toMatchObject({ ok: true, value: { interestRateBp: 2450 } });
    expect(validatePlanEdit({ ...base, interestRate: '24.5' }, ctx)).toMatchObject({ ok: true, value: { interestRateBp: 0 } });
  });

  it('valida la fecha del primer cargo', () => {
    expect(validatePlanEdit({ ...base, firstChargeDate: '2026-02-31' }, ctx)).toEqual({ ok: false, errors: [{ field: 'firstChargeDate', code: 'invalid_date' }] });
    expect(validatePlanEdit({ ...base, firstChargeDate: '' }, ctx)).toEqual({ ok: false, errors: [{ field: 'firstChargeDate', code: 'required' }] });
  });

  it('reporta los errores por campo', () => {
    const result = validatePlanEdit({ ...base, name: '', installmentAmount: '0', totalAmount: 'x', totalInstallments: '200', comment: 'x'.repeat(501) }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => `${e.field}:${e.code}`)).toEqual([
        'name:required', 'installmentAmount:invalid_amount', 'totalAmount:invalid_amount', 'totalInstallments:invalid_installments', 'comment:too_long',
      ]);
    }
  });

  it('isValidISODate rechaza fechas que no existen', () => {
    expect([isValidISODate('2026-02-28'), isValidISODate('2026-02-31'), isValidISODate('2026-13-01'), isValidISODate('hoy')]).toEqual([true, false, false, false]);
  });
});

import { describeEvent, type EventFormat } from '../src/lib/plans/events';

describe('historial legible', () => {
  const fmt: EventFormat = {
    t: (key, params) => (params ? `${key}(${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(',')})` : key),
    money: (minor) => `$${(minor / 100).toFixed(2)}`,
    date: (iso) => `d:${iso}`,
    rate: (bp) => `${bp / 100}%`,
  };

  it('describe una edición campo por campo, con formato según el tipo de dato', () => {
    const view = describeEvent(
      {
        type: 'edited',
        comment: 'abono a capital',
        data: {
          changes: {
            installmentAmountMinor: { from: 90_236, to: 85_000 },
            totalInstallments: { from: 12, to: 10 },
            firstChargeDate: { from: '2026-07-06', to: '2026-07-10' },
            interestRateBp: { from: 0, to: 2450 },
            type: { from: 'msi', to: 'mci' },
          },
          status: { from: 'active', to: 'completed_natural' },
        },
      },
      fmt,
    );
    expect(view.title).toBe('plan.event.edited');
    expect(view.lines).toEqual([
      'plan.field.installmentAmountMinor: $902.36 → $850.00',
      'plan.field.totalInstallments: 12 → 10',
      'plan.field.firstChargeDate: d:2026-07-06 → d:2026-07-10',
      'plan.field.interestRateBp: 0% → 24.5%',
      'plan.field.type: import.plan.type.msi → import.plan.type.mci',
      'plan.event.status_changed(from=plans.status.active,to=plans.status.completed_natural)',
    ]);
    expect(view.comment).toBe('abono a capital');
  });

  it('describe pagos, cambios de estado y liquidaciones', () => {
    expect(describeEvent({ type: 'installment_recorded', data: { installmentNo: 4 }, comment: null }, fmt).title).toBe('plan.event.installment_recorded(n=4)');
    expect(describeEvent({ type: 'status_changed', data: { from: 'active', to: 'review' }, comment: null }, fmt).title).toBe(
      'plan.event.status_changed(from=plans.status.active,to=plans.status.review)',
    );
    expect(describeEvent({ type: 'settled', data: {}, comment: 'pagado en sucursal' }, fmt)).toEqual({ title: 'plan.event.settled', lines: [], comment: 'pagado en sucursal' });
  });

  it('tolera datos ausentes o con otra forma', () => {
    expect(describeEvent({ type: 'edited', data: null, comment: null }, fmt).lines).toEqual([]);
    expect(describeEvent({ type: 'reverted', data: 'x', comment: null }, fmt).title).toBe('plan.event.reverted');
  });
});

describe('totales por tarjeta', () => {
  const plan = (over: Partial<import('../src/lib/plans/schedule').CardPlanFacts>): import('../src/lib/plans/schedule').CardPlanFacts => ({
    id: 'p', name: 'p', status: 'active', currency: 'MXN', installmentAmountMinor: 10_000, totalInstallments: 6, paidInstallments: 2,
    firstChargeDate: '2026-08-10', cardId: 'c1', cardName: 'Mi Banorte ···· 4172', ...over,
  });

  it('agrupa por tarjeta, suma lo de este mes y la deuda restante, y ordena por compromiso', async () => {
    const { summarizeByCard } = await import('../src/lib/plans/schedule');
    const result = summarizeByCard(
      [
        plan({ id: 'a' }),
        plan({ id: 'b', installmentAmountMinor: 5_000 }),
        plan({ id: 'c', cardId: 'c2', cardName: 'Mi Banorte ···· 2455', installmentAmountMinor: 30_000 }),
      ],
      '2026-10-09',
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.cards.map((card) => card.cardId)).toEqual(['c2', 'c1']);
    expect(result[0]!.cards[1]).toMatchObject({ openPlans: 2, thisMonthMinor: 15_000, remainingBalanceMinor: 4 * 10_000 + 4 * 5_000 });
    expect(result[0]!.cards[0]).toMatchObject({ openPlans: 1, thisMonthMinor: 30_000 });
  });

  it('el total de las tarjetas es el del resumen general y no mezcla monedas', async () => {
    const { summarize, summarizeByCard } = await import('../src/lib/plans/schedule');
    const plans = [plan({ id: 'a' }), plan({ id: 'b', cardId: 'c2', cardName: 'Otra' }), plan({ id: 'c', cardId: 'c3', cardName: 'Dólares', currency: 'USD' })];
    const byCard = summarizeByCard(plans, '2026-10-09');
    expect(byCard.map((entry) => entry.currency)).toEqual(['MXN', 'USD']);
    const mxn = summarize(plans, '2026-10-09').find((entry) => entry.currency === 'MXN')!;
    const cards = byCard.find((entry) => entry.currency === 'MXN')!.cards;
    expect(cards.reduce((sum, card) => sum + card.thisMonthMinor, 0)).toBe(mxn.thisMonthMinor);
    expect(cards.reduce((sum, card) => sum + card.remainingBalanceMinor, 0)).toBe(mxn.remainingBalanceMinor);
  });

  it('no incluye planes cerrados ni tarjetas sin planes abiertos', async () => {
    const { summarizeByCard } = await import('../src/lib/plans/schedule');
    expect(summarizeByCard([plan({ status: 'completed_natural' }), plan({ id: 'x', status: 'settled_manual', cardId: 'c9' })], '2026-10-09')).toEqual([]);
  });
});
