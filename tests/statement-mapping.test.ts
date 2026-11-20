import { describe, expect, it } from 'vitest';
import { draftMovement, finishMovement, guessColumns, guessDateFormat, guessKind, last4From, planRow } from '../src/lib/statements/mapping';
import { validateStatementInput } from '../src/lib/statements/input';
import type { DetectedTable } from '../src/lib/statements/tables';

const table = (header: string[], rows: string[][], title: string | null = null): DetectedTable => ({ pages: [1], title, subtitle: null, header, rows });

describe('sugerencias de columnas', () => {
  it('movimientos con encabezado y monto con signo (Banorte)', () => {
    const t = table(['Fecha de la operación', 'Fecha de cargo', 'Descripción del movimiento', 'Monto'], [['02-OCT-2026', '05-OCT-2026', 'OXXO', '+$207.00'], ['03-OCT-2026', '03-OCT-2026', 'SU PAGO', '-$1,500.00']], 'CARGOS, ABONOS Y COMPRAS REGULARES (NO A MESES)');
    expect(guessKind(t)).toBe('movements');
    const columns = guessColumns(t, 'movements');
    expect(columns).toMatchObject({ date: 0, postedDate: 1, description: 2, amount: 3 });
    const format = guessDateFormat(t.rows.map((r) => r[0]!));
    expect(t.rows.map((r) => draftMovement(r, columns, format, '4172').value)).toEqual([
      { date: '2026-10-02', postedDate: '2026-10-05', description: 'OXXO', chargeMinor: 20_700, creditMinor: 0, last4: '4172' },
      { date: '2026-10-03', postedDate: '2026-10-03', description: 'SU PAGO', chargeMinor: 0, creditMinor: 150_000, last4: '4172' },
    ]);
  });

  it('sin encabezado legible: columna de signo aparte y renglón ilegible que se completa a mano (Banamex)', () => {
    const t = table(['', '', '', '', '', ''], [['08-oct-2026', '08-oct-2026', 'APPLE ONLINE STORE', '010 de 018', '+', '$305.50'], ['22-oct-2026', '22-oct-2026', '', '', '', '']]);
    const columns = guessColumns(t, 'movements');
    expect(columns).toMatchObject({ date: 0, postedDate: 1, description: 2, sign: 4, amount: 5 });
    const format = guessDateFormat(t.rows.map((r) => r[0]!));
    expect(draftMovement(t.rows[0]!, columns, format, null).value).toMatchObject({ chargeMinor: 30_550, creditMinor: 0 });
    const blank = draftMovement(t.rows[1]!, columns, format, null);
    expect(blank.value).toBeNull();
    expect(finishMovement({ ...blank, description: 'SU ABONO', amount: '763.76', isCredit: true }, '2026-10-22', null).value).toMatchObject({ date: '2026-10-22', chargeMinor: 0, creditMinor: 76_376 });
  });

  it('planes: tipo, columnas y renglón con intereses', () => {
    const t = table(
      ['Fecha de la operación', 'Descripción', 'Monto original', 'Saldo pendiente', 'Intereses del periodo', 'IVA de intereses del periodo', 'Pago requerido', 'Núm. de pago'],
      [['03-JUL-2026', 'AUTOZONE', '$4,417.00', '$2,542.73', '$55.45', '$8.14', '$545.00', '04/09']],
      'COMPRAS Y CARGOS DIFERIDOS A MESES CON INTERESES',
    );
    expect(guessKind(t)).toBe('plans');
    const columns = guessColumns(t, 'plans');
    expect(columns).toEqual({ date: 0, description: 1, original: 2, pending: 3, interest: 4, interestTax: 5, payment: 6, number: 7 });
    expect(planRow(t.rows[0]!, columns, guessDateFormat(['03-JUL-2026']))).toEqual({ date: '2026-07-03', description: 'AUTOZONE', originalMinor: 441_700, pendingMinor: 254_273, interestMinor: 6_359, paymentMinor: 54_500, current: 4, total: 9 });
    expect(last4From('Tarjeta adicional XXXX XXXX XXXX 2455')).toBe('2455');
  });
});

describe('validación de lo que manda el navegador', () => {
  const ok = { accountId: 'a', period: { start: '2026-10-05', cutoff: '2026-11-04', dueDate: '' }, totals: null, movements: [{ date: '2026-10-05', description: ' OXXO ', chargeMinor: 100, creditMinor: 0, last4: '4172' }], plans: [] };
  it('acepta un estado de cuenta válido y limpia textos', () => {
    const r = validateStatementInput(ok);
    expect(r.ok && r.value.movements[0]).toEqual({ date: '2026-10-05', postedDate: null, description: 'OXXO', chargeMinor: 100, creditMinor: 0, last4: '4172' });
  });
  it('rechaza periodos al revés, montos negativos, terminaciones raras y planes imposibles', () => {
    expect(validateStatementInput({ ...ok, period: { start: '2026-11-05', cutoff: '2026-11-04' } })).toEqual({ ok: false, field: 'period' });
    expect(validateStatementInput({ ...ok, movements: [{ ...ok.movements[0], chargeMinor: -1 }] })).toEqual({ ok: false, field: 'movements' });
    expect(validateStatementInput({ ...ok, movements: [{ ...ok.movements[0], last4: '12a4' }] })).toEqual({ ok: false, field: 'movements' });
    expect(validateStatementInput({ ...ok, movements: [], plans: [{ date: '2026-10-05', originalMinor: 1, pendingMinor: 1, interestMinor: 0, paymentMinor: 1, current: 5, total: 3 }] })).toEqual({ ok: false, field: 'plans' });
    expect(validateStatementInput({ ...ok, movements: [] })).toEqual({ ok: false, field: 'rows' });
  });
});

describe('llaves de los movimientos guardados desde el PDF', () => {
  it('son propias del PDF, estables y distinguen renglones idénticos', async () => {
    const { statementKeys } = await import('../src/lib/statements/apply');
    const m = { date: '2026-10-05', postedDate: null, description: 'OXXO', chargeMinor: 100, creditMinor: 0, last4: '4172' };
    const [a, b, c] = await statementKeys([m, { ...m }, { ...m, chargeMinor: 200 }]);
    expect(a).toMatch(/^pdf:[0-9a-f]{64}#1$/);
    expect(b).toBe(a!.replace('#1', '#2'));
    expect(c!.endsWith('#1')).toBe(true);
    expect((await statementKeys([m]))[0]).toBe(a);
  });
});

describe('Plata: menos tipográfico y tabla de MSI con título en el subtítulo', () => {
  it('"−" (U+2212) en la columna de signo es abono', () => {
    const t = table(
      ['Fecha de la operación', 'Fecha de cargo', 'Descripción del movimiento', '', 'Monto', 'Moneda', 'Tipo de cambio', '', 'Monto en MXN'],
      [
        ['20-oct-2026', '20-oct-2026', '1145 CHED MERIDA PRIME', '+', '530.00', 'MXN', '1.00', '+', '$530.00'],
        ['01-nov-2026', '01-nov-2026', 'Cashback', '−', '38.27', 'MXN', '1.00', '−', '$38.27'],
        ['12-nov-2026', '12-nov-2026', 'Pago – SPEI', '−', '5,654.65', 'MXN', '1.00', '−', '$5,654.65'],
      ],
    );
    const columns = guessColumns(t, 'movements');
    const format = guessDateFormat(t.rows.map((r) => r[0]!));
    expect(t.rows.map((r) => draftMovement(r, columns, format, null).value).map((m) => [m?.description, m?.chargeMinor, m?.creditMinor])).toEqual([
      ['1145 CHED MERIDA PRIME', 53_000, 0],
      ['Cashback', 0, 3_827],
      ['Pago – SPEI', 0, 565_465],
    ]);
  });

  it('MSI con "0 de 12": se reconoce como planes y el renglón se lee', () => {
    const t = { ...table(['Fecha de la operación', 'Descripción', 'Monto original', 'Saldo pendiente', 'Pago requerido', 'Núm. de pago', 'Tasa de interés aplicable'], [['14-nov-2026', 'SAMS VENTA EN LINEA', '$6,545.15', '$6,545.15', '$545.43', '0 de 12', '0%']]), subtitle: 'Compras y cargos diferidos a meses sin intereses Tarjeta titular [528043XXXXXX2791]' };
    expect(guessKind(t)).toBe('plans');
    const row = planRow(t.rows[0]!, guessColumns(t, 'plans'), guessDateFormat(['14-nov-2026']));
    expect(row).toMatchObject({ date: '2026-11-14', originalMinor: 654_515, pendingMinor: 654_515, paymentMinor: 54_543, current: 0, total: 12 });
  });
});
