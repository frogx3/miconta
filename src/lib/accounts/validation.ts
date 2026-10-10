import { currencyDigits, parseMoneyInput } from '../money-format';

export const CARD_KINDS = ['credit', 'debit'] as const;
export type CardKindValue = (typeof CARD_KINDS)[number];

export type ValidationCode = 'required' | 'too_long' | 'invalid_kind' | 'invalid_currency' | 'invalid_amount' | 'invalid_day' | 'invalid_digits';
export interface FieldError {
  field: string;
  code: ValidationCode;
}

/** Cuenta: lo que el banco identifica con un ID de cliente. */
export interface AccountInput {
  name: string;
  bank: string;
  customerId: string | null;
}

/** Tarjeta: un solo plástico (físico o digital) de una cuenta. */
export interface CardInput {
  kind: CardKindValue;
  isDigital: boolean;
  last4: string;
  label: string | null;
  currency: string;
  creditLimitMinor: number | null;
  cutoffDay: number | null;
  paymentDueDay: number | null;
}

type Result<T> = { ok: true; value: T } | { ok: false; errors: FieldError[] };

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const oneOf = <T extends string>(options: readonly T[], value: unknown): T | null => ((options as readonly string[]).includes(value as string) ? (value as T) : null);

function optionalDay(value: unknown, field: string, errors: FieldError[]): number | null {
  const raw = typeof value === 'number' ? String(value) : text(value);
  if (raw === '') return null;
  const day = /^\d{1,2}$/.test(raw) ? Number(raw) : NaN;
  if (!(day >= 1 && day <= 31)) {
    errors.push({ field, code: 'invalid_day' });
    return null;
  }
  return day;
}

export function validateAccountInput(raw: Record<string, unknown>): Result<AccountInput> {
  const errors: FieldError[] = [];

  const name = text(raw.name);
  if (!name) errors.push({ field: 'name', code: 'required' });
  else if (name.length > 60) errors.push({ field: 'name', code: 'too_long' });

  const bank = text(raw.bank);
  if (!bank) errors.push({ field: 'bank', code: 'required' });
  else if (bank.length > 60) errors.push({ field: 'bank', code: 'too_long' });

  const customerId = text(raw.customerId);
  if (customerId.length > 40) errors.push({ field: 'customerId', code: 'too_long' });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { name, bank, customerId: customerId || null } };
}

/**
 * Valida y normaliza una tarjeta. `locale` define cómo se interpreta el límite de crédito
 * ("50,000.00" en es-MX, "50.000,00" en es-ES). En tarjetas de crédito el día de corte es obligatorio.
 */
export function validateCardInput(raw: Record<string, unknown>, locale: string): Result<CardInput> {
  const errors: FieldError[] = [];

  const kind = oneOf(CARD_KINDS, raw.kind);
  if (!kind) errors.push({ field: 'kind', code: 'invalid_kind' });

  const isDigital = raw.isDigital === true || raw.isDigital === 'true' || raw.isDigital === 'on';

  const last4 = text(raw.last4);
  if (!last4) errors.push({ field: 'last4', code: 'required' });
  else if (!/^\d{4}$/.test(last4)) errors.push({ field: 'last4', code: 'invalid_digits' });

  const label = text(raw.label);
  if (label.length > 40) errors.push({ field: 'label', code: 'too_long' });

  const currency = text(raw.currency).toUpperCase();
  if (currencyDigits(currency) === null) errors.push({ field: 'currency', code: 'invalid_currency' });

  let creditLimitMinor: number | null = null;
  const limitRaw = typeof raw.creditLimit === 'number' ? String(raw.creditLimit) : text(raw.creditLimit);
  if (kind === 'credit' && limitRaw !== '') {
    const parsed = parseMoneyInput(limitRaw, locale, currency);
    if (parsed === null || parsed <= 0) errors.push({ field: 'creditLimit', code: 'invalid_amount' });
    else creditLimitMinor = parsed;
  }

  const cutoffDay = optionalDay(raw.cutoffDay, 'cutoffDay', errors);
  if (kind === 'credit' && cutoffDay === null && !errors.some((e) => e.field === 'cutoffDay')) {
    errors.push({ field: 'cutoffDay', code: 'required' });
  }
  const paymentDueDay = optionalDay(raw.paymentDueDay, 'paymentDueDay', errors);

  if (errors.length > 0 || !kind) return { ok: false, errors };
  return {
    ok: true,
    value: {
      kind,
      isDigital,
      last4,
      label: label || null,
      currency,
      creditLimitMinor,
      cutoffDay: kind === 'credit' ? cutoffDay : null,
      paymentDueDay: kind === 'credit' ? paymentDueDay : null,
    },
  };
}
