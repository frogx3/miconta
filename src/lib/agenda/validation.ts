import { isValidISODate } from '../import/dates';
import { currencyDigits, parseMoneyInput } from '../money-format';

export const ITEM_KINDS = ['payable', 'receivable'] as const;
export const RECURRENCES = ['none', 'monthly', 'biweekly'] as const;
export const CARD_PAYMENT_ACTIONS = ['adjust', 'done', 'cancel'] as const;

export interface AgendaFieldError {
  field: string;
  code: 'required' | 'too_long' | 'invalid' | 'positive';
}

interface MoneyContext {
  locale: string;
  currency: string;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const asInput = (value: unknown): string => (typeof value === 'number' ? String(value) : text(value));
const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T => (list as readonly unknown[]).includes(value);

/** Monto escrito por la persona en unidades menores; `positive` exige > 0. Agrega el error y devuelve null si no sirve. */
function amountField(raw: unknown, ctx: MoneyContext, errors: AgendaFieldError[], positive: boolean): number | null {
  const input = asInput(raw);
  if (!input) return errors.push({ field: 'amount', code: 'required' }), null;
  const minor = currencyDigits(ctx.currency) !== null ? parseMoneyInput(input, ctx.locale, ctx.currency) : null;
  if (minor === null) return errors.push({ field: 'amount', code: 'invalid' }), null;
  if (positive && minor <= 0) return errors.push({ field: 'amount', code: 'positive' }), null;
  return minor;
}

function dateField(raw: unknown, errors: AgendaFieldError[]): string | null {
  const input = text(raw);
  if (!input) return errors.push({ field: 'dueDate', code: 'required' }), null;
  if (!isValidISODate(input)) return errors.push({ field: 'dueDate', code: 'invalid' }), null;
  return input;
}

export interface ItemValues {
  kind: (typeof ITEM_KINDS)[number];
  description: string;
  amountMinor: number;
  dueDate: string;
  recurrence: (typeof RECURRENCES)[number];
}

/** Pago o cobro capturado a mano. Sin repetición indicada, es de una sola vez. */
export function validateItem(raw: Record<string, unknown>, ctx: MoneyContext): { ok: true; value: ItemValues } | { ok: false; errors: AgendaFieldError[] } {
  const errors: AgendaFieldError[] = [];
  if (!oneOf(ITEM_KINDS, raw.kind)) errors.push({ field: 'kind', code: 'invalid' });

  const description = text(raw.description).replace(/\s+/g, ' ');
  if (!description) errors.push({ field: 'description', code: 'required' });
  else if (description.length > 120) errors.push({ field: 'description', code: 'too_long' });

  const amountMinor = amountField(raw.amount, ctx, errors, true);
  const dueDate = dateField(raw.dueDate, errors);
  const recurrence = raw.recurrence === undefined || raw.recurrence === null || raw.recurrence === '' ? 'none' : raw.recurrence;
  if (!oneOf(RECURRENCES, recurrence)) errors.push({ field: 'recurrence', code: 'invalid' });

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { kind: raw.kind as ItemValues['kind'], description, amountMinor: amountMinor!, dueDate: dueDate!, recurrence: recurrence as ItemValues['recurrence'] } };
}

export interface BalanceValues {
  cardId: string | null;
  label: string | null;
  /** Puede ser 0 o negativo (sobregiro). */
  amountMinor: number;
}

/** Saldo de una tarjeta de débito (`cardId`) o renglón libre (`label`). */
export function validateBalance(raw: Record<string, unknown>, ctx: MoneyContext): { ok: true; value: BalanceValues } | { ok: false; errors: AgendaFieldError[] } {
  const errors: AgendaFieldError[] = [];
  const cardId = text(raw.cardId) || null;
  const label = cardId ? null : text(raw.label).replace(/\s+/g, ' ');
  if (label !== null) {
    if (!label) errors.push({ field: 'label', code: 'required' });
    else if (label.length > 60) errors.push({ field: 'label', code: 'too_long' });
  }
  const amountMinor = amountField(raw.amount, ctx, errors, false);
  return errors.length ? { ok: false, errors } : { ok: true, value: { cardId, label, amountMinor: amountMinor! } };
}

export interface CardPaymentValues {
  dueDate: string;
  action: (typeof CARD_PAYMENT_ACTIONS)[number];
  amountMinor?: number;
}

/** Acción sobre un pago de tarjeta sugerido; ajustar exige monto, pagar y cancelar lo aceptan opcional. */
export function validateCardPayment(raw: Record<string, unknown>, ctx: MoneyContext): { ok: true; value: CardPaymentValues } | { ok: false; errors: AgendaFieldError[] } {
  const errors: AgendaFieldError[] = [];
  const action = raw.action;
  if (!oneOf(CARD_PAYMENT_ACTIONS, action)) errors.push({ field: 'action', code: 'invalid' });
  const dueDate = dateField(raw.dueDate, errors);
  const amountMinor = action === 'adjust' || asInput(raw.amount) ? amountField(raw.amount, ctx, errors, true) : null;
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { dueDate: dueDate!, action: action as CardPaymentValues['action'], ...(amountMinor !== null ? { amountMinor } : {}) } };
}
