import { stripAccents } from './text';
import type { DateLocale } from './types';

const MONTHS: Record<DateLocale, string[]> = {
  es: ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'],
  en: ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'],
};

const TOKEN = /YYYY|YY|MMMM|MMM|MM|M|DD|D/g;

const TOKEN_PATTERN: Record<string, string> = {
  YYYY: '(\\d{4})',
  YY: '(\\d{2})',
  MMMM: '(\\p{L}+)',
  MMM: '(\\p{L}+)',
  MM: '(\\d{2})',
  M: '(\\d{1,2})',
  DD: '(\\d{2})',
  D: '(\\d{1,2})',
};

function isValidDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function pad(value: number, size = 2): string {
  return String(value).padStart(size, '0');
}

/** Interpreta una fecha según un formato por tokens y la devuelve como ISO (YYYY-MM-DD), o null. */
export function parseDate(raw: string, format: string, locale: DateLocale = 'es'): string | null {
  const tokens: string[] = [];
  const escaped = format.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const source = escaped.replace(TOKEN, (token) => {
    tokens.push(token);
    return TOKEN_PATTERN[token]!;
  });
  const match = new RegExp(`^${source}$`, 'u').exec(raw.trim());
  if (!match) return null;

  let year = NaN;
  let month = NaN;
  let day = NaN;
  tokens.forEach((token, index) => {
    const value = match[index + 1]!;
    if (token === 'YYYY') year = Number(value);
    else if (token === 'YY') year = 2000 + Number(value);
    else if (token === 'MMM' || token === 'MMMM') {
      const name = stripAccents(value).toUpperCase().slice(0, 3);
      month = MONTHS[locale].indexOf(name) + 1 || NaN;
    } else if (token === 'MM' || token === 'M') month = Number(value);
    else day = Number(value);
  });

  if (!isValidDate(year, month, day)) return null;
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

/** Suma meses a una fecha ISO; si el día no existe en el mes destino, usa el último día. */
export function addMonthsISO(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return `${pad(target.getUTCFullYear(), 4)}-${pad(target.getUTCMonth() + 1)}-${pad(Math.min(d, lastDay))}`;
}

/** Días entre dos fechas ISO (b - a). */
export function daysBetween(a: string, b: string): number {
  const toMs = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toMs(b) - toMs(a)) / 86_400_000);
}

/** `YYYY-MM-DD` que existe en el calendario (rechaza 2026-02-31). */
export function isValidISODate(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const date = new Date(`${iso}T00:00:00Z`);
  // Un mes 13 da "Invalid Date" (toISOString lanzaría); un 31 de febrero se desborda a marzo.
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(iso);
}
