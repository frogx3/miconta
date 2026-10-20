import { currencyDigits, parseMoneyInput } from '../money-format';
import { isValidISODate } from '../import/dates';
import { normalizePattern } from './categorize';

/** Colores que ofrece el selector; se guardan como hex. */
export const CATEGORY_COLORS = ['#0f6b4f', '#2563eb', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#64748b'] as const;

export interface SpendingFieldError {
  field: string;
  code: 'required' | 'too_long' | 'too_short' | 'invalid_color' | 'invalid_amount' | 'invalid_category' | 'invalid_date' | 'invalid_range' | 'invalid_card' | 'invalid_kind';
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

export interface CategoryValues {
  name: string;
  color: string | null;
  /** `undefined` = no tocar el presupuesto; `null` = quitarlo. */
  budgetMinor?: number | null;
}

/**
 * Categoría: nombre y color; el presupuesto mensual es opcional y se escribe en el formato del locale. Vacío lo quita.
 * Si la petición no trae el campo `budget`, el presupuesto no cambia.
 */
export function validateCategory(
  raw: Record<string, unknown>,
  money?: { locale: string; currency: string },
): { ok: true; value: CategoryValues } | { ok: false; errors: SpendingFieldError[] } {
  const errors: SpendingFieldError[] = [];
  const name = text(raw.name).replace(/\s+/g, ' ');
  if (!name) errors.push({ field: 'name', code: 'required' });
  else if (name.length > 40) errors.push({ field: 'name', code: 'too_long' });

  const color = text(raw.color);
  if (color && !(CATEGORY_COLORS as readonly string[]).includes(color)) errors.push({ field: 'color', code: 'invalid_color' });

  let budgetMinor: number | null | undefined;
  if ('budget' in raw) {
    const input = typeof raw.budget === 'number' ? String(raw.budget) : text(raw.budget);
    if (!input) budgetMinor = null;
    else {
      const parsed = money && currencyDigits(money.currency) !== null ? parseMoneyInput(input, money.locale, money.currency) : null;
      if (parsed === null || parsed <= 0) errors.push({ field: 'budget', code: 'invalid_amount' });
      else budgetMinor = parsed;
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, value: { name, color: color || null, ...(budgetMinor !== undefined ? { budgetMinor } : {}) } };
}

export function validateRule(raw: Record<string, unknown>): { ok: true; value: { pattern: string; categoryId: string } } | { ok: false; errors: SpendingFieldError[] } {
  const errors: SpendingFieldError[] = [];
  const pattern = normalizePattern(text(raw.pattern));
  if (!pattern) errors.push({ field: 'pattern', code: 'required' });
  else if (pattern.length < 2) errors.push({ field: 'pattern', code: 'too_short' });
  else if (pattern.length > 60) errors.push({ field: 'pattern', code: 'too_long' });

  const categoryId = text(raw.categoryId);
  if (!categoryId) errors.push({ field: 'categoryId', code: 'required' });

  return errors.length ? { ok: false, errors } : { ok: true, value: { pattern, categoryId } };
}

/** Umbral de gasto hormiga escrito en el formato del locale, en unidades menores de la moneda. */
export function validateThreshold(raw: unknown, locale: string, currency: string): { ok: true; value: number } | { ok: false; errors: SpendingFieldError[] } {
  const input = typeof raw === 'number' ? String(raw) : text(raw);
  if (!input) return { ok: false, errors: [{ field: 'antThreshold', code: 'required' }] };
  const parsed = currencyDigits(currency) === null ? null : parseMoneyInput(input, locale, currency);
  return parsed === null || parsed <= 0 ? { ok: false, errors: [{ field: 'antThreshold', code: 'invalid_amount' }] } : { ok: true, value: parsed };
}

export interface CutoffValues {
  accountId: string;
  cutoffDate: string;
  startDate: string | null;
  officialPayMinor: number | null;
}

/** Corte real capturado del estado de cuenta: fecha de corte, primer día opcional y monto oficial opcional. */
export function validateCutoff(raw: Record<string, unknown>, locale: string, currency: string): { ok: true; value: CutoffValues } | { ok: false; errors: SpendingFieldError[] } {
  const errors: SpendingFieldError[] = [];
  const accountId = text(raw.accountId);
  if (!accountId) errors.push({ field: 'accountId', code: 'required' });

  const cutoffDate = text(raw.cutoffDate);
  if (!cutoffDate) errors.push({ field: 'cutoffDate', code: 'required' });
  else if (!isValidISODate(cutoffDate)) errors.push({ field: 'cutoffDate', code: 'invalid_date' });

  const startDate = text(raw.startDate);
  if (startDate && !isValidISODate(startDate)) errors.push({ field: 'startDate', code: 'invalid_date' });
  else if (startDate && cutoffDate && isValidISODate(cutoffDate) && startDate > cutoffDate) errors.push({ field: 'startDate', code: 'invalid_range' });

  const payInput = typeof raw.officialPay === 'number' ? String(raw.officialPay) : text(raw.officialPay);
  let officialPayMinor: number | null = null;
  if (payInput) {
    officialPayMinor = currencyDigits(currency) === null ? null : parseMoneyInput(payInput, locale, currency);
    if (officialPayMinor === null || officialPayMinor < 0) errors.push({ field: 'officialPay', code: 'invalid_amount' });
  }

  return errors.length ? { ok: false, errors } : { ok: true, value: { accountId, cutoffDate, startDate: startDate || null, officialPayMinor } };
}

export interface MovementValues {
  cardId: string;
  date: string;
  description: string;
  kind: 'charge' | 'credit';
  /** El monto se interpreta con la moneda de la tarjeta, por eso llega como texto hasta conocerla. */
  amountInput: string;
  categoryId: string | null;
  newCategory: string | null;
}

/** Movimiento capturado a mano; el monto se termina de validar con la moneda de la tarjeta (`parseMovementAmount`). */
export function validateMovement(raw: Record<string, unknown>): { ok: true; value: MovementValues } | { ok: false; errors: SpendingFieldError[] } {
  const errors: SpendingFieldError[] = [];
  const cardId = text(raw.cardId);
  if (!cardId) errors.push({ field: 'cardId', code: 'invalid_card' });
  const date = text(raw.date);
  if (!isValidISODate(date)) errors.push({ field: 'date', code: 'invalid_date' });
  const description = text(raw.description).replace(/\s+/g, ' ');
  if (!description) errors.push({ field: 'description', code: 'required' });
  else if (description.length > 120) errors.push({ field: 'description', code: 'too_long' });
  const kind = raw.kind === 'charge' || raw.kind === 'credit' ? raw.kind : null;
  if (!kind) errors.push({ field: 'kind', code: 'invalid_kind' });
  const amountInput = typeof raw.amount === 'number' ? String(raw.amount) : text(raw.amount);
  if (!amountInput) errors.push({ field: 'amount', code: 'required' });
  const newCategory = text(raw.newCategory).replace(/\s+/g, ' ');
  if (newCategory.length > 40) errors.push({ field: 'newCategory', code: 'too_long' });
  return errors.length
    ? { ok: false, errors }
    : { ok: true, value: { cardId, date, description, kind: kind!, amountInput, categoryId: text(raw.categoryId) || null, newCategory: newCategory || null } };
}

export function parseMovementAmount(input: string, locale: string, currency: string): number | null {
  const minor = currencyDigits(currency) === null ? null : parseMoneyInput(input, locale, currency);
  return minor !== null && minor > 0 ? minor : null;
}
