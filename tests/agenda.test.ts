import { describe, expect, it } from 'vitest';
import { doneRequest, monthResult, monthResults, nextDueDate, projectRecurring, type Entry, type SeriesItem } from '../src/lib/agenda/compute';
import { cardDuesInMonth } from '../src/lib/agenda/card-payments';
import { validateBalance, validateItem } from '../src/lib/agenda/validation';
import { realCuts, recordsByMonth, statementPeriod } from '../src/lib/spending/statement';

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

describe('projectRecurring', () => {
  const s = (dueDate: string, extra: Partial<SeriesItem> = {}): SeriesItem => ({
    key: 'r', kind: 'payable', description: 'renta', amountMinor: 100_00, currency: 'MXN', dueDate, status: 'pending', recurrence: 'monthly', anchorDay: Number(dueDate.slice(8)), ...extra,
  });
  const dates = (out: Entry[]) => out.map((x) => x.dueDate);

  it('mensual del 31 se proyecta a febrero y marzo', () => {
    const out = projectRecurring([s('2027-01-31')], '2027-03-31');
    expect(dates(out)).toEqual(['2027-02-28', '2027-03-31']);
    expect(out[0]).toMatchObject({ key: 'proj:r:2027-02-28', status: 'pending', suggested: false, projected: true, amountMinor: 100_00 });
  });
  it('quincenal del 15 de noviembre proyecta el 30 dentro del mes', () => {
    expect(dates(projectRecurring([s('2026-11-15', { recurrence: 'biweekly' })], '2026-11-30'))).toEqual(['2026-11-30']);
  });
  it('nada para sin repetición o no pendientes', () => {
    expect(projectRecurring([s('2026-11-10', { recurrence: 'none' }), s('2026-11-10', { status: 'done' }), s('2026-11-10', { status: 'cancelled' })], '2027-12-31')).toEqual([]);
  });
  it('nada después de through', () => {
    expect(projectRecurring([s('2026-11-10')], '2026-12-09')).toEqual([]);
    expect(dates(projectRecurring([s('2026-11-10')], '2026-12-10'))).toEqual(['2026-12-10']);
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

  it('pendiente del mes antes de hoy se aplica hoy', () => {
    const r = monthResult({ ...base, entries: [e('p', 'payable', 1_000_00, '2026-11-04')] });
    expect(day(r, '2026-11-09').balanceMinor).toBe(8_000_00);
    expect(day(r, '2026-11-10').balanceMinor).toBe(7_000_00);
  });

  it('short sin cobro posterior y con nombre del pago', () => {
    const r = monthResult({ ...base, entries: [e('chico', 'payable', 1_00, '2026-11-15'), e('grande', 'payable', 9_000_00, '2026-11-15')] });
    expect(r.strategy[0]).toEqual({ kind: 'short', date: '2026-11-15', shortMinor: 1_00 + 9_000_00 - 8_000_00, payable: 'grande', nextReceivable: null });
  });

  it('arrastre negativo inicial: short en hoy con payable null', () => {
    const r = monthResult({ ...base, availableMinor: -500_00, entries: [] });
    expect(r.strategy[0]).toEqual({ kind: 'short', date: '2026-11-10', shortMinor: 500_00, payable: null, nextReceivable: null });
  });

  it('máximo dos overdue_receivable, el más viejo primero', () => {
    const r = monthResult({ ...base, entries: [e('c', 'receivable', 1_00, '2026-11-05'), e('a', 'receivable', 1_00, '2026-10-01'), e('b', 'receivable', 1_00, '2026-11-02')] });
    expect(r.strategy.filter((l) => l.kind === 'overdue_receivable').map((l) => (l as { description: string }).description)).toEqual(['a', 'b']);
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

  it('encadena 2+ meses futuros y con dos monedas a la vez', () => {
    const r = monthResults({
      month: '2027-01', todayISO: '2026-11-10',
      balances: [{ currency: 'MXN', amountMinor: 8_000_00 }, { currency: 'USD', amountMinor: 100_00 }],
      entries: [e('renta', 'payable', 6_000_00, '2026-11-18'), e('luz', 'payable', 1_000_00, '2026-12-05'), e('u', 'payable', 40_00, '2026-12-06', { currency: 'USD' })],
    });
    expect(r.map((x) => [x.currency, x.availableMinor])).toEqual([['MXN', 1_000_00], ['USD', 60_00]]);
  });

  it('mes futuro desde cierre negativo: short el día 1 sin pago', () => {
    const r = monthResults({ month: '2026-12', todayISO: '2026-11-10', balances: [{ currency: 'MXN', amountMinor: 1_000_00 }], entries: [e('renta', 'payable', 3_000_00, '2026-11-18')] })[0]!;
    expect(r.availableMinor).toBe(-2_000_00);
    expect(r.strategy[0]).toEqual({ kind: 'short', date: '2026-12-01', shortMinor: 2_000_00, payable: null, nextReceivable: null });
  });

  it('no devuelve monedas sin saldo ni pendientes en el mes', () => {
    const r = monthResults({ month: '2026-11', todayISO: '2026-11-10', balances: [{ currency: 'MXN', amountMinor: 1_00 }], entries: [e('viejo', 'payable', 5_00, '2026-09-01', { currency: 'USD', status: 'done' })] });
    expect(r.map((x) => x.currency)).toEqual(['MXN']);
  });

  it('no mezcla monedas', () => {
    const r = monthResults({ month: '2026-11', todayISO: '2026-11-10', balances: [{ currency: 'USD', amountMinor: 100_00 }, { currency: 'MXN', amountMinor: 8_000_00 }], entries: [e('x', 'payable', 50_00, '2026-11-12', { currency: 'USD' })] });
    expect(r.map((x) => x.currency)).toEqual(['MXN', 'USD']);
    expect(r[0]!.resultMinor).toBe(8_000_00);
    expect(r[1]!.resultMinor).toBe(50_00);
  });
});

describe('cardDuesInMonth', () => {
  const card = { cardId: 'c1', accountName: 'Banorte', currency: 'MXN', paymentDueDay: 17, todayISO: '2026-11-05' };
  const cuts = realCuts([
    { cutoffDate: '2026-09-28', startDate: null, officialPayMinor: 1_000_00 },
    { cutoffDate: '2026-10-28', startDate: null, officialPayMinor: 2_500_00 },
  ], 28, 17);

  it('usa el corte real cuyo pago cae en el mes', () => {
    expect(cardDuesInMonth({ ...card, cutoffDay: 28, cuts, month: '2026-11' })).toEqual([{
      cardId: 'c1', accountName: 'Banorte', currency: 'MXN', cutMonth: '2026-10', from: '2026-09-29', to: '2026-10-28',
      dueDate: '2026-11-17', recordedPayMinor: 2_500_00, previousOwedMinor: 1_000_00,
    }]);
  });

  it('sin corte real estima con el día de corte', () => {
    const period = statementPeriod(28, 17, '2026-11', card.todayISO, recordsByMonth(cuts.map((c) => c.recorded)));
    const [due, ...rest] = cardDuesInMonth({ ...card, cutoffDay: 28, cuts, month: '2026-12' });
    expect(rest).toEqual([]);
    expect(due).toMatchObject({ cutMonth: '2026-11', from: period.from, to: period.to, dueDate: '2026-12-17', recordedPayMinor: null, previousOwedMinor: null });
    expect(due!.from).toBe('2026-10-29');
  });

  it('corte estimado ya cerrado toma el adeudo del corte real anterior', () => {
    expect(cardDuesInMonth({ ...card, cutoffDay: 28, cuts: cuts.slice(0, 1), month: '2026-11' })).toEqual([{
      cardId: 'c1', accountName: 'Banorte', currency: 'MXN', cutMonth: '2026-10', from: '2026-09-29', to: '2026-10-28',
      dueDate: '2026-11-17', recordedPayMinor: null, previousOwedMinor: 1_000_00,
    }]);
  });

  it('dos cortes que vencen el mismo día dan un solo pago (el más reciente)', () => {
    const dues = cardDuesInMonth({ ...card, cutoffDay: 31, paymentDueDay: 30, cuts: [], month: '2026-02', todayISO: '2026-03-15' });
    expect(dues.map((d) => [d.cutMonth, d.dueDate])).toEqual([['2026-02', '2026-02-28']]);
  });

  it('sin día de corte ni cortes no hay nada', () => {
    expect(cardDuesInMonth({ ...card, cutoffDay: null, cuts: [], month: '2026-11' })).toEqual([]);
  });
});

describe('validateItem', () => {
  const ctx = { locale: 'es-MX', currency: 'MXN' };
  const ok = { kind: 'payable', description: 'Renta', amount: '1,234.50', dueDate: '2026-11-15', recurrence: 'monthly' };
  const codes = (body: Record<string, unknown>) => {
    const r = validateItem(body, ctx);
    return r.ok ? [] : r.errors;
  };
  it('acepta un pago válido y lee el monto en es-MX', () => {
    expect(validateItem(ok, ctx)).toEqual({ ok: true, value: { kind: 'payable', description: 'Renta', amountMinor: 123450, dueDate: '2026-11-15', recurrence: 'monthly' } });
  });
  it('rechaza descripción vacía, monto cero, fecha inexistente y repetición desconocida', () => {
    expect(codes({ ...ok, description: '  ' })).toContainEqual({ field: 'description', code: 'required' });
    expect(codes({ ...ok, amount: '0' })).toContainEqual({ field: 'amount', code: 'positive' });
    expect(codes({ ...ok, dueDate: '2026-02-30' })).toContainEqual({ field: 'dueDate', code: 'invalid' });
    expect(codes({ ...ok, recurrence: 'weekly' })).toContainEqual({ field: 'recurrence', code: 'invalid' });
    expect(codes({ ...ok, kind: 'gasto' })).toContainEqual({ field: 'kind', code: 'invalid' });
    expect(codes({ ...ok, description: 'x'.repeat(121) })).toContainEqual({ field: 'description', code: 'too_long' });
  });
});

describe('validateBalance', () => {
  const ctx = { locale: 'es-MX', currency: 'MXN' };
  it('permite saldo cero o negativo y pide etiqueta en renglones libres', () => {
    expect(validateBalance({ label: 'Efectivo', amount: '-50' }, ctx)).toEqual({ ok: true, value: { cardId: null, label: 'Efectivo', amountMinor: -5000 } });
    expect(validateBalance({ cardId: 'c1', amount: '0' }, ctx)).toEqual({ ok: true, value: { cardId: 'c1', label: null, amountMinor: 0 } });
    const r = validateBalance({ amount: '10' }, ctx);
    expect(r.ok ? [] : r.errors).toContainEqual({ field: 'label', code: 'required' });
  });
});

describe('doneRequest', () => {
  const suggestions = [{ key: 'card:c1:2026-11-20', cardId: 'c1', dueDate: '2026-11-20' }];
  it('un registro se marca con su endpoint', () => {
    expect(doneRequest(e('abc', 'receivable', 1_00, '2026-11-12'), suggestions)).toEqual({ url: '/api/agenda/items/abc/done', body: {} });
  });
  it('un pago de tarjeta sugerido se guarda con la acción done', () => {
    expect(doneRequest(e('card:c1:2026-11-20', 'payable', 1_00, '2026-11-20', { suggested: true }), suggestions)).toEqual({
      url: '/api/agenda/card-payments',
      body: { cardId: 'c1', dueDate: '2026-11-20', action: 'done' },
    });
  });
  it('proyectadas y no pendientes no tienen acción', () => {
    expect(doneRequest(e('proj:abc:2026-11-27', 'payable', 1_00, '2026-11-27', { projected: true }), suggestions)).toBeNull();
    expect(doneRequest(e('abc', 'payable', 1_00, '2026-11-02', { status: 'done' }), suggestions)).toBeNull();
  });
});
