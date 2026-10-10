import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { matchBankPlans, parseBankPlans, type MatchablePlan } from '../src/lib/plans/bank-balances';
import { remainingBalanceMinor } from '../src/lib/import/plans';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const plan = (id: string, firstChargeDate: string, total: number, paid: number, amount: number, status = 'active'): MatchablePlan => ({
  id, name: id, status, totalInstallments: total, paidInstallments: paid, installmentAmountMinor: amount, firstChargeDate,
});

describe('CSV de planes del banco', () => {
  it('lee los tres formatos (sin intereses, adicional y con intereses)', () => {
    const titular = parseBankPlans(fixture('plans-titular-full.csv'));
    const additional = parseBankPlans(fixture('plans-additional-sample.csv'));
    const interest = parseBankPlans(fixture('plans-interest-sample.csv'));
    expect(titular.ok && titular.rows.length).toBe(5);
    expect(additional.ok && additional.rows.length).toBe(16);
    expect(interest.ok && interest.rows).toEqual([
      { date: '2026-07-03', description: 'AUTOZONE 9540 MERIDA', originalMinor: 441_700, pendingMinor: 302_414, interestMinor: 7_373, paymentMinor: 54_648, current: 3, total: 9 },
    ]);
    expect(titular.ok && titular.rows[0]).toMatchObject({ date: '2026-06-30', pendingMinor: 201_800, paymentMinor: 25_225, current: 4, total: 12 });
  });

  it('rechaza archivos que no son de planes', () => {
    expect(parseBankPlans('Fecha,Concepto,Abono,Cargo\n01/10/2026,X,0,1')).toEqual({ ok: false, reason: 'columns' });
    expect(parseBankPlans('')).toEqual({ ok: false, reason: 'empty' });
  });

  it('empareja por fecha de compra, total, número de pago y mensualidad sin intereses', () => {
    const rows = [
      ...(parseBankPlans(fixture('plans-interest-sample.csv')) as { rows: never[] }).rows,
      ...(parseBankPlans(fixture('plans-titular-full.csv')) as { rows: never[] }).rows,
    ];
    const plans = [
      plan('autozone', '2026-07-03', 9, 3, 47_275),
      plan('edo-1', '2026-06-30', 12, 4, 25_225),
      plan('edo-2', '2026-06-30', 12, 4, 25_225),
      plan('aguila', '2026-07-03', 12, 3, 90_236),
    ];
    const { matches, unmatched } = matchBankPlans(rows, plans);
    // Autozone se empareja pese a que el pago requerido trae intereses e IVA; los dos planes idénticos usan filas distintas.
    expect(matches.map((m) => m.planId).sort()).toEqual(['aguila', 'autozone', 'edo-1', 'edo-2']);
    expect(new Set(matches.map((m) => m.row)).size).toBe(4);
    expect(matches.find((m) => m.planId === 'autozone')!.row.pendingMinor).toBe(302_414);
    // Rumaya y Mapfre no tienen plan en este ejemplo.
    expect(unmatched.map((row) => row.description)).toEqual(['RUMAYA TRAVEL LP MERIDA YUC', 'MAPFRE L COBRANZA CIUDAD DE M']);
  });

  it('no empareja un plan con otro número de pago ni uno ya cerrado', () => {
    const rows = (parseBankPlans(fixture('plans-interest-sample.csv')) as { rows: never[] }).rows;
    expect(matchBankPlans(rows, [plan('autozone', '2026-07-03', 9, 2, 47_275)]).matches).toHaveLength(0);
    expect(matchBankPlans(rows, [plan('autozone', '2026-07-03', 9, 3, 47_275, 'completed_natural')]).matches).toHaveLength(0);
  });
});

describe('tolerancia de fechas', () => {
  const row = (parseBankPlans(fixture('plans-interest-sample.csv')) as { rows: never[] }).rows;
  it('acepta unos días de diferencia entre la compra y el primer cargo del plan', () => {
    expect(matchBankPlans(row, [plan('autozone', '2026-07-06', 9, 3, 47_275)]).matches).toHaveLength(1);
    expect(matchBankPlans(row, [plan('autozone', '2026-07-20', 9, 3, 47_275)]).matches).toHaveLength(0);
  });
  it('con dos planes iguales prefiere el de la fecha más cercana', () => {
    const { matches } = matchBankPlans(row, [plan('lejano', '2026-07-07', 9, 3, 47_275), plan('exacto', '2026-07-03', 9, 3, 47_275)]);
    expect(matches.map((m) => m.planId)).toEqual(['exacto']);
  });
});

describe('saldo con el reportado por el banco', () => {
  const base = { totalInstallments: 9, paidInstallments: 3, installmentAmountMinor: 47_275 };
  it('sin saldo del banco es mensualidades × restantes', () => {
    expect(remainingBalanceMinor(base)).toBe(6 * 47_275);
  });
  it('con saldo del banco lo usa tal cual', () => {
    expect(remainingBalanceMinor({ ...base, reportedBalanceMinor: 302_414, reportedBalancePaid: 3 })).toBe(302_414);
  });
  it('descuenta las mensualidades pagadas desde que se reportó, sin bajar de cero', () => {
    expect(remainingBalanceMinor({ ...base, paidInstallments: 4, reportedBalanceMinor: 302_414, reportedBalancePaid: 3 })).toBe(302_414 - 47_275);
    expect(remainingBalanceMinor({ ...base, paidInstallments: 9, reportedBalanceMinor: 302_414, reportedBalancePaid: 3 })).toBe(0);
  });
});
