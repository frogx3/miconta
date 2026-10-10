import { parseMoney, type NumberFormat } from './import/money';

const FALLBACK_CURRENCIES = ['MXN', 'USD', 'EUR', 'CAD', 'GBP', 'ARS', 'CLP', 'COP', 'PEN', 'BRL', 'UYU', 'CRC', 'GTQ', 'DOP', 'PAB'];

let knownCurrencies: Set<string> | undefined;
function currencies(): Set<string> {
  knownCurrencies ??= new Set(typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('currency') : FALLBACK_CURRENCIES);
  return knownCurrencies;
}

/** Decimales de una moneda ISO 4217 (MXN 2, JPY 0, KWD 3), o null si el código no existe. */
export function currencyDigits(currency: string): number | null {
  if (!currencies().has(currency)) return null;
  return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

/** Separadores de miles y decimales que usa un locale al escribir números. */
export function numberFormatFor(locale: string, minorDigits: number): NumberFormat {
  const parts = new Intl.NumberFormat(locale).formatToParts(12345.6);
  const group = parts.find((p) => p.type === 'group')?.value ?? '';
  const decimal = parts.find((p) => p.type === 'decimal')?.value ?? '.';
  return {
    decimalSeparator: decimal === ',' ? ',' : '.',
    thousandsSeparator: group === '.' ? '.' : group === ',' ? ',' : group.trim() === '' && group !== '' ? ' ' : '',
    minorDigits,
  };
}

/** Interpreta lo que escribió una persona ("50,000.00" en es-MX) como unidades menores enteras. */
export function parseMoneyInput(raw: string, locale: string, currency: string): number | null {
  const digits = currencyDigits(currency);
  return digits === null ? null : parseMoney(raw, numberFormatFor(locale, digits));
}

/** "$50,000.00" / "50.000,00 €" según locale y moneda. Solo para mostrar. */
export function formatMinor(minor: number, currency: string, locale: string): string {
  const digits = currencyDigits(currency) ?? 2;
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(minor / 10 ** digits);
}

/** Valor para un campo de texto: decimales del locale y sin separador de miles ("50000.00"). */
export function toInputString(minor: number, locale: string, currency: string): string {
  const digits = currencyDigits(currency) ?? 2;
  const { decimalSeparator } = numberFormatFor(locale, digits);
  const scale = 10 ** digits;
  const whole = Math.trunc(Math.abs(minor) / scale);
  const fraction = String(Math.abs(minor) % scale).padStart(digits, '0');
  return `${minor < 0 ? '-' : ''}${whole}${digits > 0 ? decimalSeparator + fraction : ''}`;
}

/** Monedas que ofrece el selector: las comunes, más la que ya tenga el registro. */
export function currencyOptions(extra?: string): string[] {
  const list = FALLBACK_CURRENCIES.filter((code) => currencies().has(code));
  return extra && !list.includes(extra) ? [extra, ...list] : list;
}
