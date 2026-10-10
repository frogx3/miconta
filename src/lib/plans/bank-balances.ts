import { parseCsv } from '../import/csv';
import { daysBetween, parseDate } from '../import/dates';
import { parseInstallment, parseMoney } from '../import/money';
import { normalizeHeader } from '../import/text';

/**
 * CSV de "compras a meses" del portal del banco (sin intereses, con intereses; titular y adicional).
 * Traen lo que la app no puede deducir: el saldo pendiente real de cada plan.
 */

export interface BankPlanRow {
  /** Fecha de la compra; coincide con el primer cargo del plan. */
  date: string;
  description: string;
  originalMinor: number;
  pendingMinor: number;
  /** Intereses e IVA de la mensualidad, solo en los planes con intereses. */
  interestMinor: number;
  paymentMinor: number;
  current: number;
  total: number;
}

export type ParseResult = { ok: true; rows: BankPlanRow[]; skipped: number } | { ok: false; reason: 'empty' | 'columns' };

const MONEY = { decimalSeparator: '.', thousandsSeparator: ',', minorDigits: 2 } as const;

const COLUMNS = {
  date: 'fecha de la operacion',
  description: 'descripcion',
  original: 'monto original',
  pending: 'saldo pendiente',
  payment: 'pago requerido',
  number: 'num de pago',
} as const;
const INTEREST = ['intereses del periodo', 'iva de intereses del periodo'];

export function parseBankPlans(text: string): ParseResult {
  const table = parseCsv(text);
  if (table.length < 2) return { ok: false, reason: 'empty' };
  const header = table[0]!.map(normalizeHeader);
  const at = (name: string) => header.indexOf(name);
  const index = Object.fromEntries(Object.entries(COLUMNS).map(([key, name]) => [key, at(name)])) as Record<keyof typeof COLUMNS, number>;
  if (Object.values(index).some((position) => position < 0)) return { ok: false, reason: 'columns' };
  const interestAt = INTEREST.map(at).filter((position) => position >= 0);

  const rows: BankPlanRow[] = [];
  let skipped = 0;
  for (const cells of table.slice(1)) {
    const date = parseDate((cells[index.date] ?? '').trim(), 'DD-MMM-YYYY', 'es');
    const original = parseMoney(cells[index.original] ?? '', MONEY);
    const pending = parseMoney(cells[index.pending] ?? '', MONEY);
    const payment = parseMoney(cells[index.payment] ?? '', MONEY);
    const number = parseInstallment(cells[index.number] ?? '');
    const interest = interestAt.map((position) => parseMoney(cells[position] ?? '', MONEY) ?? 0).reduce((a, b) => a + b, 0);
    if (!date || original === null || pending === null || payment === null || !number) {
      skipped++;
      continue;
    }
    rows.push({ date, description: (cells[index.description] ?? '').trim(), originalMinor: original, pendingMinor: pending, interestMinor: interest, paymentMinor: payment, current: number.current, total: number.total });
  }
  return { ok: true, rows, skipped };
}

/** Lo que necesita un plan para emparejarse con una fila del banco. */
export interface MatchablePlan {
  id: string;
  name: string;
  status: string;
  totalInstallments: number;
  paidInstallments: number;
  installmentAmountMinor: number;
  firstChargeDate: string;
}

export interface BalanceMatch {
  planId: string;
  planName: string;
  row: BankPlanRow;
}

/** El banco redondea cada mensualidad por su lado: dos centavos de holgura. */
const CENT_TOLERANCE = 2;
/** El primer cargo de un plan se calcula desde la fecha del movimiento y puede diferir unos días de la fecha de compra. */
const DATE_TOLERANCE_DAYS = 5;

/**
 * Empareja cada fila del banco con un plan abierto: fecha de compra cercana al primer cargo, mismo total de
 * pagos, mismo número de pago y misma mensualidad (sin intereses). Uno a uno y por cercanía de fecha: dos planes
 * idénticos no consumen la misma fila. Las filas sin plan se devuelven aparte para que el usuario las vea.
 */
export function matchBankPlans(rows: readonly BankPlanRow[], plans: readonly MatchablePlan[]): { matches: BalanceMatch[]; unmatched: BankPlanRow[]; closed: BankPlanRow[] } {
  const open = plans.filter((plan) => plan.status === 'active' || plan.status === 'review');

  const candidates: { row: number; plan: number; distance: number }[] = [];
  rows.forEach((row, rowIndex) => {
    const installment = row.paymentMinor - row.interestMinor;
    open.forEach((plan, planIndex) => {
      if (plan.totalInstallments !== row.total || plan.paidInstallments !== row.current) return;
      if (Math.abs(plan.installmentAmountMinor - installment) > CENT_TOLERANCE) return;
      const distance = Math.abs(daysBetween(plan.firstChargeDate, row.date));
      if (distance <= DATE_TOLERANCE_DAYS) candidates.push({ row: rowIndex, plan: planIndex, distance });
    });
  });
  candidates.sort((a, b) => a.distance - b.distance || a.row - b.row || a.plan - b.plan);

  const takenRows = new Set<number>();
  const takenPlans = new Set<number>();
  const matches: BalanceMatch[] = [];
  for (const { row, plan } of candidates) {
    if (takenRows.has(row) || takenPlans.has(plan)) continue;
    takenRows.add(row);
    takenPlans.add(plan);
    matches.push({ planId: open[plan]!.id, planName: open[plan]!.name, row: rows[row]! });
  }

  const rest = rows.filter((_, index) => !takenRows.has(index));
  return { matches, unmatched: rest.filter((row) => row.pendingMinor !== 0), closed: rest.filter((row) => row.pendingMinor === 0) };
}
