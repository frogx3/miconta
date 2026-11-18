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
