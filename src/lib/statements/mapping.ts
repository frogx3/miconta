import { parseDate } from '../import/dates';
import { parseInstallment, parseMoney } from '../import/money';
import { normalizeHeader } from '../import/text';
import type { DateLocale } from '../import/types';
import type { BankPlanRow } from '../plans/bank-balances';
import type { StatementMovement } from './compare';
import type { DetectedTable } from './tables';

/**
 * De una tabla elegida por la persona a movimientos o planes. Las sugerencias de tipo y columnas solo llegan ya
 * marcadas en la pantalla: la persona las confirma o cambia. Lo que no se pudo leer queda como renglón a completar.
 */

export type TableKind = 'movements' | 'plans';
export const MOVEMENT_FIELDS = ['date', 'postedDate', 'description', 'amount', 'sign', 'charge', 'credit'] as const;
export const PLAN_FIELDS = ['date', 'description', 'original', 'pending', 'payment', 'number', 'interest', 'interestTax'] as const;
export type MovementField = (typeof MOVEMENT_FIELDS)[number];
export type PlanField = (typeof PLAN_FIELDS)[number];
/** Campo → índice de columna (-1 = ninguna). */
export type Columns<F extends string> = Record<F, number>;

export const DATE_FORMATS: readonly { format: string; locale: DateLocale }[] = [
  { format: 'DD-MMM-YYYY', locale: 'es' },
  { format: 'DD-MMM-YYYY', locale: 'en' },
  { format: 'DD/MMM/YYYY', locale: 'es' },
  { format: 'DD MMM YYYY', locale: 'es' },
  { format: 'DD MMM YYYY', locale: 'en' },
  { format: 'DD/MM/YYYY', locale: 'es' },
  { format: 'DD/MM/YY', locale: 'es' },
  { format: 'DD-MM-YYYY', locale: 'es' },
  { format: 'MM/DD/YYYY', locale: 'en' },
  { format: 'YYYY-MM-DD', locale: 'es' },
];

const MONEY = { decimalSeparator: '.', thousandsSeparator: ',', minorDigits: 2 } as const;
const money = (raw: string | undefined) => (raw ? parseMoney(raw.replace(/\bCR\b/i, ''), MONEY) : null);
/** Algunos PDF (Plata) escriben el menos tipográfico (−, U+2212) o un guion largo en vez de "-". */
const plainMinus = (raw: string) => raw.replace(/[\u2212\u2013\u2014]/g, '-');
const looksMoney = (raw: string) => /^[+-]?\s*\$?\s*[+-]?[\d,]+\.\d{2}(\s*CR)?$/i.test(plainMinus(raw).trim());
/** "n de m"; Plata pone "0 de 12" a una compra cuyo primer pago aún no se registra. */
const installmentOf = (raw: string) => {
  const match = /^\s*0\s*(?:\/|de|of)\s*(\d+)\s*$/i.exec(raw);
  return match && Number(match[1]) >= 1 ? { current: 0, total: Number(match[1]) } : parseInstallment(raw);
};
const looksInstallment = (raw: string) => installmentOf(raw) !== null;
const looksSign = (raw: string) => /^[+-]$/.test(plainMinus(raw).trim());

/** Formato de fecha que lee más celdas de la columna de fecha. */
export function guessDateFormat(values: readonly string[]): number {
  let best = 0;
  let bestCount = -1;
  DATE_FORMATS.forEach(({ format, locale }, i) => {
    const count = values.filter((v) => parseDate(v, format, locale)).length;
    if (count > bestCount) [best, bestCount] = [i, count];
  });
  return best;
}

const share = (table: DetectedTable, column: number, test: (raw: string) => boolean) => {
  const filled = table.rows.map((row) => row[column] ?? '').filter(Boolean);
  return filled.length ? filled.filter(test).length / filled.length : 0;
};
const columnIndexes = (table: DetectedTable) => [...Array(table.header.length).keys()];

/** Planes si el título habla de meses (y no de "no a meses") o si hay columna de "n de m" con varios montos. */
export function guessKind(table: DetectedTable): TableKind {
  // El título a veces queda como subtítulo (Plata: "Compras y cargos diferidos a meses sin intereses").
  const title = normalizeHeader(`${table.title ?? ''} ${table.subtitle ?? ''} ${table.header.join(' ')}`);
  if (/\bmeses\b/.test(title) && !/no a meses/.test(title)) return 'plans';
  const moneyColumns = columnIndexes(table).filter((i) => share(table, i, looksMoney) > 0.6).length;
  return moneyColumns >= 3 && columnIndexes(table).some((i) => share(table, i, looksInstallment) > 0.6) ? 'plans' : 'movements';
}

/** Columnas sugeridas: por el texto del encabezado y, si no hay encabezado legible, por el contenido. */
export function guessColumns(table: DetectedTable, kind: 'movements'): Columns<MovementField>;
export function guessColumns(table: DetectedTable, kind: 'plans'): Columns<PlanField>;
export function guessColumns(table: DetectedTable, kind: TableKind): Columns<MovementField> | Columns<PlanField> {
  const header = table.header.map(normalizeHeader);
  const all = columnIndexes(table);
  const byHeader = (pattern: RegExp, skip: number[] = []) => header.findIndex((h, i) => pattern.test(h) && !skip.includes(i));
  const dates = all.filter((i) => share(table, i, (v) => DATE_FORMATS.some((f) => parseDate(v, f.format, f.locale))) > 0.6);
  const moneys = all.filter((i) => share(table, i, looksMoney) > 0.6);
  const installment = all.find((i) => share(table, i, looksInstallment) > 0.6) ?? -1;
  const used = new Set<number>();
  const pick = (index: number) => (index >= 0 && !used.has(index) ? (used.add(index), index) : -1);
  const firstFree = (list: number[]) => list.find((i) => !used.has(i)) ?? -1;
  // Descripción: la columna de texto con más letras que no es fecha, monto ni plazo.
  const description = () => {
    const text = all.filter((i) => !used.has(i) && !dates.includes(i) && !moneys.includes(i) && i !== installment);
    const letters = (i: number) => table.rows.reduce((sum, row) => sum + (row[i]?.replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ]/g, '').length ?? 0), 0);
    return text.sort((a, b) => letters(b) - letters(a))[0] ?? -1;
  };

  if (kind === 'movements') {
    const date = pick(byHeader(/operacion|transaction|^fecha$|^date$/) >= 0 ? byHeader(/operacion|transaction|^fecha$|^date$/) : firstFree(dates));
    const postedDate = pick(byHeader(/fecha de cargo|posting|post date/) >= 0 ? byHeader(/fecha de cargo|posting|post date/) : firstFree(dates));
    const charge = pick(byHeader(/^cargos?$|^debit|^charges?$/));
    const credit = pick(byHeader(/^abonos?$|^credits?$|^payments?$/));
    const amount = charge >= 0 || credit >= 0 ? -1 : pick(byHeader(/^monto$|importe|amount/) >= 0 ? byHeader(/^monto$|importe|amount/) : moneys[moneys.length - 1] ?? -1);
    const sign = pick(all.find((i) => share(table, i, looksSign) > 0.6) ?? -1);
    return { date, postedDate, description: pick(byHeader(/descripcion|concepto|description|detalle/) >= 0 ? byHeader(/descripcion|concepto|description|detalle/) : description()), amount, sign, charge, credit };
  }

  const date = pick(byHeader(/operacion|fecha|date/) >= 0 ? byHeader(/operacion|fecha|date/) : firstFree(dates));
  const number = pick(byHeader(/num.* pago|pago num|installment/) >= 0 ? byHeader(/num.* pago|pago num|installment/) : installment);
  const [m0, m1, m2] = moneys.filter((i) => !used.has(i));
  const original = pick(byHeader(/original/) >= 0 ? byHeader(/original/) : m0 ?? -1);
  const pending = pick(byHeader(/pendiente|pending|balance/) >= 0 ? byHeader(/pendiente|pending|balance/) : m1 ?? -1);
  const interestTax = pick(byHeader(/^iva/));
  const interest = pick(byHeader(/^intereses/));
  const payment = pick(byHeader(/pago requerido|requerido|payment|mensualidad/) >= 0 ? byHeader(/pago requerido|requerido|payment|mensualidad/) : firstFree([m2 ?? -1, ...moneys]));
  return { date, description: pick(byHeader(/descripcion|concepto|description/) >= 0 ? byHeader(/descripcion|concepto|description/) : description()), original, pending, payment, number, interest, interestTax };
}

/** Terminación de tarjeta en el subtítulo ("Tarjeta adicional XXXX XXXX XXXX 2455"). */
export const last4From = (subtitle: string | null) => /(\d{4})\s*$/.exec(subtitle ?? '')?.[1] ?? null;

/** Lo que la persona ve y puede corregir de un renglón; `value` es null si falta algo. */
export interface MovementDraft {
  date: string;
  description: string;
  /** Monto escrito tal cual (sin signo). */
  amount: string;
  isCredit: boolean;
  value: StatementMovement | null;
}

export function draftMovement(cells: readonly string[], columns: Columns<MovementField>, dateFormat: number, last4: string | null): MovementDraft {
  const raw = (field: MovementField) => (columns[field] >= 0 ? (cells[columns[field]] ?? '').trim() : '');
  const cell = (field: MovementField) => (field === 'date' || field === 'postedDate' || field === 'description' ? raw(field) : plainMinus(raw(field)));
  const { format, locale } = DATE_FORMATS[dateFormat]!;
  let amount = '';
  let isCredit = false;
  if (columns.charge >= 0 || columns.credit >= 0) {
    const credit = money(cell('credit'));
    isCredit = credit !== null && credit !== 0;
    amount = isCredit ? cell('credit') : cell('charge');
  } else {
    amount = cell('amount');
    isCredit = /-|\bCR\b/i.test(amount) || cell('sign') === '-';
  }
  return finishMovement({ date: parseDate(cell('date'), format, locale) ?? '', description: cell('description'), amount: amount.replace(/[+-]|\bCR\b/gi, '').trim(), isCredit, value: null }, parseDate(cell('postedDate'), format, locale), last4);
}

/** Recalcula `value` con lo que la persona capturó o corrigió. */
export function finishMovement(draft: MovementDraft, postedDate: string | null, last4: string | null): MovementDraft {
  const minor = money(draft.amount);
  // Un renglón en $0.00 (reversa de bonificación) es válido: también está en el CSV.
  const ok = Boolean(draft.date) && Boolean(draft.description) && minor !== null && minor >= 0;
  return {
    ...draft,
    value: ok ? { date: draft.date, postedDate, description: draft.description, chargeMinor: draft.isCredit ? 0 : minor!, creditMinor: draft.isCredit ? minor! : 0, last4 } : null,
  };
}

export function planRow(cells: readonly string[], columns: Columns<PlanField>, dateFormat: number): BankPlanRow | null {
  const cell = (field: PlanField) => (columns[field] >= 0 ? (cells[columns[field]] ?? '').trim() : '');
  const { format, locale } = DATE_FORMATS[dateFormat]!;
  const date = parseDate(cell('date'), format, locale);
  const [original, pending, payment] = [money(cell('original')), money(cell('pending')), money(cell('payment'))];
  const number = installmentOf(cell('number'));
  if (!date || original === null || pending === null || payment === null || !number) return null;
  const interest = (money(cell('interest')) ?? 0) + (money(cell('interestTax')) ?? 0);
  return { date, description: cell('description'), originalMinor: original, pendingMinor: pending, interestMinor: interest, paymentMinor: payment, current: number.current, total: number.total };
}
