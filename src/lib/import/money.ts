export interface NumberFormat {
  decimalSeparator: '.' | ',';
  thousandsSeparator: ',' | '.' | ' ' | '';
  minorDigits: number;
}

/**
 * Convierte "$3,027.00" a unidades menores enteras (302700). Sin floats.
 * Acepta símbolo de moneda, negativos con "-" o entre paréntesis. Devuelve null si es inválido.
 */
export function parseMoney(raw: string, format: NumberFormat): number | null {
  let value = raw.trim();
  if (value === '') return null;

  const negative = /^\(.*\)$/.test(value) || value.startsWith('-') || value.endsWith('-');
  value = value.replace(/[()\-\s ]/g, '');
  if (format.thousandsSeparator && format.thousandsSeparator.trim() !== '') {
    value = value.split(format.thousandsSeparator).join('');
  }
  value = value.replace(/[^\d.,]/g, '');
  if (value === '') return null;

  const parts = value.split(format.decimalSeparator);
  if (parts.length > 2) return null;
  const whole = parts[0]!;
  const fraction = parts[1] ?? '';
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(fraction)) return null;
  if (fraction.length > format.minorDigits) return null;
  if (whole === '' && fraction === '') return null;

  const minor = Number(whole || '0') * 10 ** format.minorDigits + Number(fraction.padEnd(format.minorDigits, '0') || '0');
  if (!Number.isSafeInteger(minor)) return null;
  return negative ? -minor : minor;
}

/** "1.50%" -> 150 (puntos base). */
export function parsePercentBp(raw: string, format: Pick<NumberFormat, 'decimalSeparator' | 'thousandsSeparator'>): number | null {
  return parseMoney(raw.replace('%', ''), { ...format, minorDigits: 2 });
}

/** "04/12", "4 de 12" -> { current: 4, total: 12 } */
export function parseInstallment(raw: string): { current: number; total: number } | null {
  const match = /^\s*(\d+)\s*(?:\/|de|of)\s*(\d+)\s*$/i.exec(raw);
  if (!match) return null;
  const current = Number(match[1]);
  const total = Number(match[2]);
  if (total < 1 || current < 1 || current > total) return null;
  return { current, total };
}
