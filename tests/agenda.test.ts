import { describe, expect, it } from 'vitest';
import { monthResult, monthResults, nextDueDate, type Entry } from '../src/lib/agenda/compute';

const e = (key: string, kind: Entry['kind'], amountMinor: number, dueDate: string, extra: Partial<Entry> = {}): Entry => ({
  key, kind, description: key, amountMinor, currency: 'MXN', dueDate, status: 'pending', suggested: false, ...extra,
});
const base = { month: '2026-11', todayISO: '2026-11-10', availableMinor: 8_000_00, currency: 'MXN' };
const day = (r: ReturnType<typeof monthResult>, d: string) => r.days.find((x) => x.date === d)!;

describe('nextDueDate', () => {
  it('mensual conserva el día ancla', () => {
    expect(nextDueDate('2026-01-31', 'monthly', 31)).toBe('2026-02-28');
    expect(nextDueDate('2026-02-28', 'monthly', 31)).toBe('2026-03-31');
    expect(nextDueDate('2028-01-31', 'monthly', 31)).toBe('2028-02-29');
  });
  it('quincenal suma 15 días', () => {
    expect(nextDueDate('2026-02-20', 'biweekly', 20)).toBe('2026-03-07');
  });
});

describe('monthResult', () => {
  const entries = [e('cobro', 'receivable', 5_000_00, '2026-11-20'), e('renta', 'payable', 6_000_00, '2026-11-18'), e('luz', 'payable', 3_000_00, '2026-11-25')];

  it('alcanza', () => {
    const r = monthResult({ ...base, entries });
    expect(r.resultMinor).toBe(4_000_00);
    expect(day(r, '2026-11-18').balanceMinor).toBe(2_000_00);
    expect(day(r, '2026-11-05').balanceMinor).toBe(8_000_00);
    expect(r.days).toHaveLength(30);
    const s = r.strategy[0]!;
    expect(s.kind).toBe('ok');
    if (s.kind === 'ok') expect(s.biggest?.description).toBe('renta');
  });

  it('falta antes del cobro', () => {
    const r = monthResult({ ...base, entries: [entries[0]!, e('renta', 'payable', 9_000_00, '2026-11-18'), entries[2]!] });
    expect(day(r, '2026-11-18').balanceMinor).toBe(-1_000_00);
    expect(r.resultMinor).toBe(1_000_00);
    expect(r.strategy[0]).toMatchObject({ kind: 'short', date: '2026-11-18', shortMinor: 1_000_00, nextReceivable: { date: '2026-11-20' } });
  });

  it('vencido cuenta solo en el mes actual y se aplica hoy', () => {
    const overdue = [e('viejo', 'payable', 1_000_00, '2026-10-30')];
    const cur = monthResult({ ...base, entries: overdue });
    expect(cur.payableMinor).toBe(1_000_00);
    expect(day(cur, '2026-11-10').balanceMinor).toBe(7_000_00);
    expect(monthResult({ ...base, month: '2026-10', entries: overdue }).payableMinor).toBe(1_000_00); // su propio mes
    expect(monthResult({ ...base, month: '2026-09', entries: overdue }).payableMinor).toBe(0);
    expect(monthResults({ month: '2026-12', todayISO: base.todayISO, balances: [{ currency: 'MXN', amountMinor: 8_000_00 }], entries: overdue })[0]!.availableMinor).toBe(7_000_00);
  });

  it('cobro vencido genera línea overdue_receivable', () => {
    const r = monthResult({ ...base, entries: [e('deuda', 'receivable', 500_00, '2026-11-03')] });
    expect(r.strategy).toContainEqual({ kind: 'overdue_receivable', description: 'deuda', amountMinor: 500_00, date: '2026-11-03' });
  });

  it('done/cancelled no suman pero se muestran; resultado cero no es faltante', () => {
    const r = monthResult({ ...base, availableMinor: 1_000_00, entries: [e('a', 'payable', 1_000_00, '2026-11-15'), e('b', 'payable', 9_000_00, '2026-11-16', { status: 'done' }), e('c', 'payable', 9_000_00, '2026-11-17', { status: 'cancelled' })] });
    expect(r.resultMinor).toBe(0);
    expect(r.strategy[0]!.kind).toBe('ok');
    expect(day(r, '2026-11-16').entries).toHaveLength(1);
  });
});

describe('monthResults', () => {
  it('mes futuro encadena el saldo proyectado al cierre de noviembre', () => {
    const r = monthResults({
      month: '2026-12', todayISO: '2026-11-10', balances: [{ currency: 'MXN', amountMinor: 8_000_00 }],
      entries: [e('renta', 'payable', 6_000_00, '2026-11-18'), e('cobro', 'receivable', 1_000_00, '2026-12-05')],
    });
    expect(r[0]!.availableMinor).toBe(2_000_00);
    expect(r[0]!.resultMinor).toBe(3_000_00);
  });

  it('no mezcla monedas', () => {
    const r = monthResults({ month: '2026-11', todayISO: '2026-11-10', balances: [{ currency: 'USD', amountMinor: 100_00 }, { currency: 'MXN', amountMinor: 8_000_00 }], entries: [e('x', 'payable', 50_00, '2026-11-12', { currency: 'USD' })] });
    expect(r.map((x) => x.currency)).toEqual(['MXN', 'USD']);
    expect(r[0]!.resultMinor).toBe(8_000_00);
    expect(r[1]!.resultMinor).toBe(50_00);
  });
});
