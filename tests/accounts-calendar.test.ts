import { describe, expect, it } from 'vitest';
import { cutHistory, cutState, monthMarks, type CalendarAccount } from '../src/lib/accounts/calendar';
import type { SpendRow } from '../src/lib/spending/analysis';
import { realCuts } from '../src/lib/spending/statement';

const cuts = (dates: [string, number | null][], cutoffDay = 4, dueDay = 24) =>
  realCuts(dates.map(([cutoffDate, officialPayMinor]) => ({ cutoffDate, startDate: null, officialPayMinor })), cutoffDay, dueDay);

const account = (id: string, extra: Partial<CalendarAccount> = {}): CalendarAccount => ({
  accountId: id,
  accountName: id,
  last4: '1234',
  tone: 'navy',
  currency: 'MXN',
  cutoffDay: 4,
  paymentDueDay: 24,
  cuts: [],
  ...extra,
});

describe('calendario de cortes y pagos', () => {
  it('marca el corte real del mes y la fecha límite de pago; sin corte real, los estima con los días de la tarjeta', () => {
    const marks = monthMarks(
      [
        account('Banorte', { cuts: cuts([['2026-10-04', null], ['2026-11-05', 1_000_00]]) }),
        account('Nu', { cutoffDay: 15, paymentDueDay: 6 }),
      ],
      '2026-11',
      '2026-11-18',
    );
    expect(marks).toEqual([
      // Nu: el corte de octubre (día 15) se paga el 6 de noviembre.
      { day: 5, kind: 'cut', accountId: 'Banorte', estimated: false },
      { day: 6, kind: 'due', accountId: 'Nu', estimated: true },
      { day: 15, kind: 'cut', accountId: 'Nu', estimated: true },
      { day: 24, kind: 'due', accountId: 'Banorte', estimated: false },
    ]);
  });

  it('una cuenta sin día de corte ni de pago no deja marcas', () => {
    expect(monthMarks([account('Débito', { cutoffDay: null, paymentDueDay: null })], '2026-11', '2026-11-18')).toEqual([]);
  });
});

describe('estado de la última carga', () => {
  it('avisa cuando ya cerró un corte que no se ha cargado', () => {
    const list = cuts([['2026-10-04', null]]);
    expect(cutState(list, 4, '2026-11-03')).toEqual({ state: 'ok', lastMonth: '2026-10' });
    expect(cutState(list, 4, '2026-11-04')).toEqual({ state: 'late', lastMonth: '2026-10', expectedMonth: '2026-11' });
    expect(cutState([], 4, '2026-11-04')).toEqual({ state: 'none' });
    expect(cutState(list, null, '2027-05-01')).toEqual({ state: 'ok', lastMonth: '2026-10' });
  });
});

describe('historial de cortes', () => {
  it('del más reciente al más antiguo, con el pago oficial o el estimado y su desglose', () => {
    const row = (chargeMinor: number, planId: string | null = null): SpendRow => ({ date: '2026-11-01', descriptionNorm: 'TIENDA', chargeMinor, creditMinor: 0, currency: 'MXN', categoryId: null, planId });
    const list = cuts([['2026-09-04', null], ['2026-10-04', null], ['2026-11-04', 2_000_00]]);
    const rows = new Map([
      ['2026-10', [row(300_00, 'p1'), row(200_00)]],
      ['2026-11', [row(300_00, 'p1'), row(900_00)]],
    ]);
    expect(cutHistory(list, rows, 100_00, 2)).toEqual([
      { month: '2026-11', cutoff: '2026-11-04', dueDate: '2026-11-24', payMinor: 2_000_00, basis: 'official', planMinor: 300_00, purchasesMinor: 900_00 },
      { month: '2026-10', cutoff: '2026-10-04', dueDate: '2026-10-24', payMinor: 500_00, basis: 'estimate', planMinor: 300_00, purchasesMinor: 200_00 },
    ]);
  });
});
