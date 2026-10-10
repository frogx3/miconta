import { describe, expect, it } from 'vitest';
import { validateAccountInput, validateCardInput } from '../src/lib/accounts/validation';
import { currencyDigits, currencyOptions, formatMinor, numberFormatFor, parseMoneyInput, toInputString } from '../src/lib/money-format';

describe('formato de dinero por idioma y moneda', () => {
  it('conoce los decimales de cada moneda y rechaza códigos inexistentes', () => {
    expect(currencyDigits('MXN')).toBe(2);
    expect(currencyDigits('JPY')).toBe(0);
    expect(currencyDigits('CLP')).toBe(0);
    expect(currencyDigits('ZZZ')).toBeNull();
    expect(currencyDigits('mxn')).toBeNull();
  });

  it('usa los separadores del locale', () => {
    expect(numberFormatFor('es-MX', 2)).toMatchObject({ decimalSeparator: '.', thousandsSeparator: ',' });
    expect(numberFormatFor('en', 2)).toMatchObject({ decimalSeparator: '.', thousandsSeparator: ',' });
    expect(numberFormatFor('es-AR', 2)).toMatchObject({ decimalSeparator: ',', thousandsSeparator: '.' });
  });

  it('interpreta lo que escribe la persona según su locale', () => {
    expect(parseMoneyInput('50,000.00', 'es-MX', 'MXN')).toBe(5_000_000);
    expect(parseMoneyInput('50000', 'es-MX', 'MXN')).toBe(5_000_000);
    expect(parseMoneyInput('$1,234.5', 'es-MX', 'MXN')).toBe(123_450);
    expect(parseMoneyInput('50.000,00', 'es-AR', 'ARS')).toBe(5_000_000);
    expect(parseMoneyInput('50000', 'es-MX', 'JPY')).toBe(50_000);
    expect(parseMoneyInput('50000.5', 'es-MX', 'JPY')).toBeNull();
    expect(parseMoneyInput('abc', 'es-MX', 'MXN')).toBeNull();
  });

  it('muestra montos formateados y los devuelve a un campo de texto', () => {
    expect(formatMinor(5_000_000, 'MXN', 'es-MX')).toBe('$50,000.00');
    expect(toInputString(5_000_000, 'es-MX', 'MXN')).toBe('50000.00');
    expect(toInputString(123_456, 'es-AR', 'ARS')).toBe('1234,56');
    expect(toInputString(50_000, 'es-MX', 'JPY')).toBe('50000');
    // Lo que se muestra en el campo se vuelve a leer igual.
    expect(parseMoneyInput(toInputString(123_456, 'es-AR', 'ARS'), 'es-AR', 'ARS')).toBe(123_456);
  });

  it('el selector incluye la moneda del registro aunque no sea común', () => {
    expect(currencyOptions()).toContain('MXN');
    expect(currencyOptions('CHF')[0]).toBe('CHF');
  });
});

describe('validación de cuentas', () => {
  it('normaliza nombre, banco e ID de cliente opcional', () => {
    expect(validateAccountInput({ name: ' Mi Banorte ', bank: 'Banorte', customerId: ' 123456 ' })).toEqual({
      ok: true,
      value: { name: 'Mi Banorte', bank: 'Banorte', customerId: '123456' },
    });
    expect(validateAccountInput({ name: 'Nómina', bank: 'BBVA' })).toMatchObject({ ok: true, value: { customerId: null } });
  });

  it('reporta los campos obligatorios y los demasiado largos', () => {
    expect(validateAccountInput({ name: '', bank: 'x'.repeat(61), customerId: 'y'.repeat(41) })).toEqual({
      ok: false,
      errors: [
        { field: 'name', code: 'required' },
        { field: 'bank', code: 'too_long' },
        { field: 'customerId', code: 'too_long' },
      ],
    });
  });
});

describe('validación de tarjetas', () => {
  const valid = { kind: 'credit', isDigital: false, last4: '4172', label: ' Física ', currency: 'mxn', creditLimit: '50,000.00', cutoffDay: '15', paymentDueDay: 5 };

  it('normaliza una tarjeta de crédito válida', () => {
    expect(validateCardInput(valid, 'es-MX')).toEqual({
      ok: true,
      value: { kind: 'credit', isDigital: false, last4: '4172', label: 'Física', currency: 'MXN', creditLimitMinor: 5_000_000, cutoffDay: 15, paymentDueDay: 5 },
    });
  });

  it('acepta la marca de tarjeta digital como booleano o como casilla', () => {
    expect(validateCardInput({ ...valid, isDigital: true }, 'es-MX')).toMatchObject({ ok: true, value: { isDigital: true } });
    expect(validateCardInput({ ...valid, isDigital: 'true' }, 'es-MX')).toMatchObject({ ok: true, value: { isDigital: true } });
    expect(validateCardInput({ ...valid, isDigital: 'false' }, 'es-MX')).toMatchObject({ ok: true, value: { isDigital: false } });
  });

  it('en crédito el día de corte es obligatorio; el límite es opcional', () => {
    const result = validateCardInput({ ...valid, cutoffDay: '', creditLimit: '' }, 'es-MX');
    expect(result).toEqual({ ok: false, errors: [{ field: 'cutoffDay', code: 'required' }] });
  });

  it('en débito ignora límite, corte y día límite de pago', () => {
    const result = validateCardInput({ ...valid, kind: 'debit', cutoffDay: '', creditLimit: '99', paymentDueDay: '10' }, 'es-MX');
    expect(result).toMatchObject({ ok: true, value: { creditLimitMinor: null, cutoffDay: null, paymentDueDay: null } });
  });

  it('una tarjeta es un solo plástico: exige 4 dígitos y no admite otros tipos', () => {
    expect(validateCardInput({ ...valid, last4: '41' }, 'es-MX')).toEqual({ ok: false, errors: [{ field: 'last4', code: 'invalid_digits' }] });
    expect(validateCardInput({ ...valid, last4: '' }, 'es-MX')).toEqual({ ok: false, errors: [{ field: 'last4', code: 'required' }] });
    expect(validateCardInput({ ...valid, kind: 'other' }, 'es-MX')).toEqual({ ok: false, errors: [{ field: 'kind', code: 'invalid_kind' }] });
  });

  it('reporta todos los errores por campo', () => {
    const result = validateCardInput({ kind: 'otro', last4: 'abcd', label: 'x'.repeat(41), currency: 'ZZZ', cutoffDay: '32' }, 'es-MX');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        { field: 'kind', code: 'invalid_kind' },
        { field: 'last4', code: 'invalid_digits' },
        { field: 'label', code: 'too_long' },
        { field: 'currency', code: 'invalid_currency' },
        { field: 'cutoffDay', code: 'invalid_day' },
      ]);
    }
  });

  it('rechaza límites no positivos o ilegibles', () => {
    for (const creditLimit of ['0', '-5', 'mucho']) {
      const result = validateCardInput({ ...valid, creditLimit }, 'es-MX');
      expect(result).toEqual({ ok: false, errors: [{ field: 'creditLimit', code: 'invalid_amount' }] });
    }
  });

  it('interpreta el límite según el locale del usuario', () => {
    const result = validateCardInput({ ...valid, currency: 'ARS', creditLimit: '50.000,00' }, 'es-AR');
    expect(result).toMatchObject({ ok: true, value: { creditLimitMinor: 5_000_000 } });
  });
});
