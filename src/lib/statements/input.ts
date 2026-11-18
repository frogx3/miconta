import { isValidISODate } from '../import/dates';
import type { BankPlanRow } from '../plans/bank-balances';
import type { StatementMovement } from './compare';

/**
 * Lo que manda el navegador después de que la persona eligió tablas, columnas y completó lo ilegible. Es entrada
 * no confiable: aquí se valida todo antes de comparar.
 */
export interface StatementInput {
  accountId: string;
  period: { start: string; cutoff: string; dueDate: string | null };
  totals: { chargesMinor: number; creditsMinor: number } | null;
  movements: StatementMovement[];
  plans: BankPlanRow[];
}

const MAX_ROWS = 2_000;
const MAX_MINOR = 1_000_000_000_00;

const isDate = (value: unknown): value is string => typeof value === 'string' && isValidISODate(value);
const isMinor = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_MINOR;
const text = (value: unknown, max: number) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

export function validateStatementInput(raw: unknown): { ok: true; value: StatementInput } | { ok: false; field: string } {
  const body = record(raw);
  if (!body || typeof body.accountId !== 'string' || !body.accountId) return { ok: false, field: 'accountId' };

  const period = record(body.period);
  if (!period || !isDate(period.start) || !isDate(period.cutoff) || period.start > period.cutoff) return { ok: false, field: 'period' };
  const dueDate = period.dueDate === null || period.dueDate === undefined || period.dueDate === '' ? null : period.dueDate;
  if (dueDate !== null && !isDate(dueDate)) return { ok: false, field: 'period' };

  let totals: StatementInput['totals'] = null;
  if (body.totals !== null && body.totals !== undefined) {
    const t = record(body.totals);
    if (!t || !isMinor(t.chargesMinor) || !isMinor(t.creditsMinor)) return { ok: false, field: 'totals' };
    totals = { chargesMinor: t.chargesMinor, creditsMinor: t.creditsMinor };
  }

  const list = (value: unknown) => (Array.isArray(value) ? value : null);
  const rawMovements = list(body.movements ?? []);
  const rawPlans = list(body.plans ?? []);
  if (!rawMovements || !rawPlans || rawMovements.length + rawPlans.length === 0 || rawMovements.length + rawPlans.length > MAX_ROWS) return { ok: false, field: 'rows' };

  const movements: StatementMovement[] = [];
  for (const item of rawMovements) {
    const m = record(item);
    const last4 = m?.last4 === null || m?.last4 === undefined || m?.last4 === '' ? null : m.last4;
    if (!m || !isDate(m.date) || !isMinor(m.chargeMinor) || !isMinor(m.creditMinor) || (last4 !== null && !(typeof last4 === 'string' && /^\d{4}$/.test(last4)))) return { ok: false, field: 'movements' };
    if (m.chargeMinor > 0 && m.creditMinor > 0) return { ok: false, field: 'movements' };
    movements.push({ date: m.date, postedDate: isDate(m.postedDate) ? m.postedDate : null, description: text(m.description, 200), chargeMinor: m.chargeMinor, creditMinor: m.creditMinor, last4 });
  }

  const plans: BankPlanRow[] = [];
  for (const item of rawPlans) {
    const p = record(item);
    if (!p || !isDate(p.date) || ![p.originalMinor, p.pendingMinor, p.interestMinor, p.paymentMinor].every(isMinor)) return { ok: false, field: 'plans' };
    const { current, total } = p;
    if (!Number.isSafeInteger(current) || !Number.isSafeInteger(total) || (current as number) < 1 || (current as number) > (total as number) || (total as number) > 120) return { ok: false, field: 'plans' };
    plans.push({
      date: p.date, description: text(p.description, 200), originalMinor: p.originalMinor as number, pendingMinor: p.pendingMinor as number,
      interestMinor: p.interestMinor as number, paymentMinor: p.paymentMinor as number, current: current as number, total: total as number,
    });
  }

  return { ok: true, value: { accountId: body.accountId, period: { start: period.start, cutoff: period.cutoff, dueDate }, totals, movements, plans } };
}
