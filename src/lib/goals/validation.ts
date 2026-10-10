import { isValidISODate } from '../import/dates';
import { currencyDigits, parseMoneyInput } from '../money-format';

export const GOAL_TYPES = ['debt_free', 'payoff_plan', 'ant_spend', 'savings'] as const;
export type GoalType = (typeof GOAL_TYPES)[number];

export const isGoalType = (value: unknown): value is GoalType => (GOAL_TYPES as readonly unknown[]).includes(value);

export interface GoalFieldError {
  field: string;
  code: 'required' | 'too_long' | 'invalid_amount' | 'invalid_date' | 'date_past' | 'invalid_type' | 'invalid_plan';
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const asInput = (value: unknown): string => (typeof value === 'number' ? String(value) : text(value));

interface MoneyContext {
  locale: string;
  currency: string;
  todayISO: string;
}

function parseAmount(raw: unknown, ctx: MoneyContext, { allowNegative = false } = {}): number | null {
  const input = asInput(raw);
  const minor = input && currencyDigits(ctx.currency) !== null ? parseMoneyInput(input, ctx.locale, ctx.currency) : null;
  if (minor === null || minor === 0 || (!allowNegative && minor < 0)) return null;
  return minor;
}

export interface GoalValues {
  type: GoalType;
  name: string;
  targetDate: string | null;
  targetAmountMinor: number | null;
  planId: string | null;
}

/**
 * Meta nueva. Qué campos hacen falta depende del tipo: libre de pagos y liquidar un plan piden fecha (y el plan);
 * hormiga pide el tope mensual; ahorro pide el monto y, opcionalmente, la fecha.
 */
export function validateGoal(raw: Record<string, unknown>, ctx: MoneyContext): { ok: true; value: GoalValues } | { ok: false; errors: GoalFieldError[] } {
  const errors: GoalFieldError[] = [];
  if (!isGoalType(raw.type)) return { ok: false, errors: [{ field: 'type', code: 'invalid_type' }] };
  const type = raw.type;

  const name = text(raw.name).replace(/\s+/g, ' ');
  if (!name) errors.push({ field: 'name', code: 'required' });
  else if (name.length > 60) errors.push({ field: 'name', code: 'too_long' });

  const dateInput = text(raw.targetDate);
  const needsDate = type === 'debt_free' || type === 'payoff_plan';
  const usesDate = needsDate || type === 'savings';
  let targetDate: string | null = null;
  if (usesDate) {
    if (!dateInput) {
      if (needsDate) errors.push({ field: 'targetDate', code: 'required' });
    } else if (!isValidISODate(dateInput)) errors.push({ field: 'targetDate', code: 'invalid_date' });
    else if (dateInput < ctx.todayISO) errors.push({ field: 'targetDate', code: 'date_past' });
    else targetDate = dateInput;
  }

  let targetAmountMinor: number | null = null;
  if (type === 'ant_spend' || type === 'savings') {
    const amount = parseAmount(raw.targetAmount, ctx);
    if (!asInput(raw.targetAmount)) errors.push({ field: 'targetAmount', code: 'required' });
    else if (amount === null) errors.push({ field: 'targetAmount', code: 'invalid_amount' });
    else targetAmountMinor = amount;
  }

  const planId = type === 'payoff_plan' ? text(raw.planId) : '';
  if (type === 'payoff_plan' && !planId) errors.push({ field: 'planId', code: 'required' });

  return errors.length ? { ok: false, errors } : { ok: true, value: { type, name, targetDate, targetAmountMinor, planId: planId || null } };
}

export interface GoalEdit {
  name: string;
  targetDate: string | null;
  targetAmountMinor: number | null;
}

/** Edición de una meta existente: el tipo y el plan no cambian; la fecha puede quedar en el pasado (la meta se marca vencida). */
export function validateGoalEdit(raw: Record<string, unknown>, type: GoalType, ctx: MoneyContext): { ok: true; value: GoalEdit } | { ok: false; errors: GoalFieldError[] } {
  const errors: GoalFieldError[] = [];
  const name = text(raw.name).replace(/\s+/g, ' ');
  if (!name) errors.push({ field: 'name', code: 'required' });
  else if (name.length > 60) errors.push({ field: 'name', code: 'too_long' });

  let targetDate: string | null = null;
  const dateInput = text(raw.targetDate);
  if (type !== 'ant_spend') {
    if (!dateInput) {
      if (type !== 'savings') errors.push({ field: 'targetDate', code: 'required' });
    } else if (!isValidISODate(dateInput)) errors.push({ field: 'targetDate', code: 'invalid_date' });
    else targetDate = dateInput;
  }

  let targetAmountMinor: number | null = null;
  if (type === 'ant_spend' || type === 'savings') {
    const amount = parseAmount(raw.targetAmount, ctx);
    if (!asInput(raw.targetAmount)) errors.push({ field: 'targetAmount', code: 'required' });
    else if (amount === null) errors.push({ field: 'targetAmount', code: 'invalid_amount' });
    else targetAmountMinor = amount;
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: { name, targetDate, targetAmountMinor } };
}

export interface EntryValues {
  amountMinor: number;
  date: string;
  note: string | null;
}

/** Aporte (positivo) o retiro (negativo) de una meta de ahorro; la fecha por defecto es hoy. */
export function validateEntry(raw: Record<string, unknown>, ctx: MoneyContext): { ok: true; value: EntryValues } | { ok: false; errors: GoalFieldError[] } {
  const errors: GoalFieldError[] = [];
  const amount = parseAmount(raw.amount, ctx, { allowNegative: true });
  if (!asInput(raw.amount)) errors.push({ field: 'amount', code: 'required' });
  else if (amount === null) errors.push({ field: 'amount', code: 'invalid_amount' });

  const dateInput = text(raw.date) || ctx.todayISO;
  if (!isValidISODate(dateInput)) errors.push({ field: 'date', code: 'invalid_date' });
  else if (dateInput > ctx.todayISO) errors.push({ field: 'date', code: 'date_past' });

  const note = text(raw.note);
  if (note.length > 120) errors.push({ field: 'note', code: 'too_long' });
  return errors.length ? { ok: false, errors } : { ok: true, value: { amountMinor: amount!, date: dateInput, note: note || null } };
}
