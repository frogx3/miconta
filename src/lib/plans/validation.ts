import { currencyDigits, numberFormatFor, parseMoneyInput } from '../money-format';
import { parsePercentBp } from '../import/money';
import { addMonthsISO, isValidISODate } from '../import/dates';

export const PLAN_TYPES = ['msi', 'mci', 'fixed'] as const;
export type PlanTypeValue = (typeof PLAN_TYPES)[number];

export type PlanErrorCode =
  | 'required'
  | 'too_long'
  | 'invalid_kind'
  | 'invalid_amount'
  | 'invalid_integer'
  | 'invalid_installments'
  | 'current_exceeds_total'
  | 'invalid_rate'
  | 'invalid_date';
export interface PlanFieldError {
  field: string;
  code: PlanErrorCode;
}

/** Un plan que el usuario define a partir de un movimiento del CSV en la primera carga. */
export interface PlanDraft {
  movementKey: string;
  type: PlanTypeValue;
  name: string;
  matchText: string;
  installmentAmountMinor: number;
  totalInstallments: number;
  /** Mensualidades ya cobradas, incluida la del movimiento que se vincula. */
  currentInstallment: number;
  totalAmountMinor: number;
  interestRateBp: number;
  firstChargeDate: string;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '');

function integer(raw: unknown, field: string, errors: PlanFieldError[]): number {
  const value = text(raw);
  if (!/^\d{1,3}$/.test(value)) {
    errors.push({ field, code: value === '' ? 'required' : 'invalid_integer' });
    return NaN;
  }
  return Number(value);
}

/**
 * Valida un plan propuesto por el usuario. Importes y tasa se leen con el formato de su locale.
 * Para MSI la tasa siempre es 0; si no se indica el total, se calcula como mensualidad × plazo.
 * La fecha del primer cargo se deduce de la del movimiento y del número de pago en que va.
 */
export function validatePlanDraft(
  raw: Record<string, unknown>,
  context: { locale: string; currency: string; movementDate: string },
): { ok: true; value: PlanDraft } | { ok: false; errors: PlanFieldError[] } {
  const errors: PlanFieldError[] = [];

  const type = (PLAN_TYPES as readonly string[]).includes(raw.type as string) ? (raw.type as PlanTypeValue) : null;
  if (!type) errors.push({ field: 'type', code: 'invalid_kind' });

  const name = text(raw.name);
  if (!name) errors.push({ field: 'name', code: 'required' });
  else if (name.length > 80) errors.push({ field: 'name', code: 'too_long' });

  const matchText = text(raw.matchText);
  if (!matchText) errors.push({ field: 'matchText', code: 'required' });
  else if (matchText.length > 120) errors.push({ field: 'matchText', code: 'too_long' });

  const digits = currencyDigits(context.currency);
  const money = (value: unknown, field: string, optional: boolean): number | null => {
    const raw = text(value);
    if (raw === '' && optional) return null;
    const parsed = digits === null ? null : parseMoneyInput(raw, context.locale, context.currency);
    if (parsed === null || parsed <= 0) {
      errors.push({ field, code: raw === '' ? 'required' : 'invalid_amount' });
      return null;
    }
    return parsed;
  };

  const installmentAmountMinor = money(raw.installmentAmount, 'installmentAmount', false);
  const totalInstallments = integer(raw.totalInstallments, 'totalInstallments', errors);
  const currentInstallment = integer(raw.currentInstallment, 'currentInstallment', errors);
  if (totalInstallments < 2 || totalInstallments > 120) errors.push({ field: 'totalInstallments', code: 'invalid_installments' });
  else if (currentInstallment < 1) errors.push({ field: 'currentInstallment', code: 'invalid_installments' });
  else if (currentInstallment > totalInstallments) errors.push({ field: 'currentInstallment', code: 'current_exceeds_total' });

  const totalGiven = money(raw.totalAmount, 'totalAmount', true);

  let interestRateBp = 0;
  const rateRaw = text(raw.interestRate);
  if (type && type !== 'msi' && rateRaw !== '') {
    const parsed = parsePercentBp(rateRaw, numberFormatFor(context.locale, 2));
    if (parsed === null || parsed < 0 || parsed > 100_000) errors.push({ field: 'interestRate', code: 'invalid_rate' });
    else interestRateBp = parsed;
  }

  if (errors.length > 0 || !type || installmentAmountMinor === null) return { ok: false, errors };
  return {
    ok: true,
    value: {
      movementKey: text(raw.movementKey),
      type,
      name,
      matchText,
      installmentAmountMinor,
      totalInstallments,
      currentInstallment,
      totalAmountMinor: totalGiven ?? installmentAmountMinor * totalInstallments,
      interestRateBp,
      firstChargeDate: addMonthsISO(context.movementDate, -(currentInstallment - 1)),
    },
  };
}

/** Parámetros de un plan editados a mano. Todo es editable; el comentario es opcional. */
export interface PlanEdit {
  name: string;
  matchText: string;
  type: PlanTypeValue;
  installmentAmountMinor: number;
  totalInstallments: number;
  paidInstallments: number;
  totalAmountMinor: number;
  interestRateBp: number;
  firstChargeDate: string;
  comment: string | null;
}

/**
 * Valida la edición manual de un plan. A diferencia de la alta, aquí el número de pagos realizados
 * puede ser 0 y el plazo 1 (p. ej. tras un abono anticipado que lo acorta). Para MSI la tasa es 0.
 */
export function validatePlanEdit(
  raw: Record<string, unknown>,
  context: { locale: string; currency: string },
): { ok: true; value: PlanEdit } | { ok: false; errors: PlanFieldError[] } {
  const errors: PlanFieldError[] = [];

  const type = (PLAN_TYPES as readonly string[]).includes(raw.type as string) ? (raw.type as PlanTypeValue) : null;
  if (!type) errors.push({ field: 'type', code: 'invalid_kind' });

  const name = text(raw.name);
  if (!name) errors.push({ field: 'name', code: 'required' });
  else if (name.length > 80) errors.push({ field: 'name', code: 'too_long' });

  const matchText = text(raw.matchText);
  if (!matchText) errors.push({ field: 'matchText', code: 'required' });
  else if (matchText.length > 120) errors.push({ field: 'matchText', code: 'too_long' });

  const money = (value: unknown, field: string): number | null => {
    const input = text(value);
    const parsed = currencyDigits(context.currency) === null ? null : parseMoneyInput(input, context.locale, context.currency);
    if (parsed === null || parsed <= 0) {
      errors.push({ field, code: input === '' ? 'required' : 'invalid_amount' });
      return null;
    }
    return parsed;
  };
  const installmentAmountMinor = money(raw.installmentAmount, 'installmentAmount');
  const totalAmountMinor = money(raw.totalAmount, 'totalAmount');

  const totalInstallments = integer(raw.totalInstallments, 'totalInstallments', errors);
  const paidInstallments = integer(raw.paidInstallments, 'paidInstallments', errors);
  if (totalInstallments < 1 || totalInstallments > 120) errors.push({ field: 'totalInstallments', code: 'invalid_installments' });
  else if (paidInstallments > totalInstallments) errors.push({ field: 'paidInstallments', code: 'current_exceeds_total' });

  const firstChargeDate = text(raw.firstChargeDate);
  if (!firstChargeDate) errors.push({ field: 'firstChargeDate', code: 'required' });
  else if (!isValidISODate(firstChargeDate)) errors.push({ field: 'firstChargeDate', code: 'invalid_date' });

  let interestRateBp = 0;
  const rateRaw = text(raw.interestRate);
  if (type && type !== 'msi' && rateRaw !== '') {
    const parsed = parsePercentBp(rateRaw, numberFormatFor(context.locale, 2));
    if (parsed === null || parsed < 0 || parsed > 100_000) errors.push({ field: 'interestRate', code: 'invalid_rate' });
    else interestRateBp = parsed;
  }

  const comment = text(raw.comment);
  if (comment.length > 500) errors.push({ field: 'comment', code: 'too_long' });

  if (errors.length > 0 || !type || installmentAmountMinor === null || totalAmountMinor === null) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name,
      matchText,
      type,
      installmentAmountMinor,
      totalInstallments,
      paidInstallments,
      totalAmountMinor,
      interestRateBp,
      firstChargeDate,
      comment: comment || null,
    },
  };
}
