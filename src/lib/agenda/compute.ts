import { addDays, cutoffInMonth } from '../spending/statement';
import { monthOf, shiftMonth } from '../spending/analysis';

export type Recurrence = 'none' | 'monthly' | 'biweekly';

export interface Entry {
  key: string;
  kind: 'payable' | 'receivable';
  description: string;
  amountMinor: number;
  currency: string;
  dueDate: string;
  status: 'pending' | 'done' | 'cancelled';
  suggested: boolean;
  /** Ocurrencia futura de una serie que aún no existe como registro. */
  projected?: boolean;
}

/** Siguiente fecha de una serie. `anchorDay` es el día del primer registro (31 → 28 → 31 no se encoge). */
export function nextDueDate(dueDate: string, recurrence: Exclude<Recurrence, 'none'>, anchorDay: number): string {
  if (recurrence === 'biweekly') return addDays(dueDate, 15);
  return cutoffInMonth(anchorDay, shiftMonth(monthOf(dueDate), 1));
}

export interface SeriesItem {
  key: string;
  kind: Entry['kind'];
  description: string;
  amountMinor: number;
  currency: string;
  dueDate: string;
  status: Entry['status'];
  recurrence: Recurrence;
  anchorDay: number;
}

/**
 * Ocurrencias siguientes de cada serie hasta `through` (inclusive). Recibe solo la última ocurrencia de cada serie
 * (la que aún no tiene hijo); las que no están pendientes o no se repiten no proyectan nada.
 */
export function projectRecurring(series: SeriesItem[], through: string): Entry[] {
  const out: Entry[] = [];
  for (const item of series) {
    if (item.status !== 'pending' || item.recurrence === 'none') continue;
    for (let date = nextDueDate(item.dueDate, item.recurrence, item.anchorDay); date <= through; date = nextDueDate(date, item.recurrence, item.anchorDay)) {
      out.push({ key: `proj:${item.key}:${date}`, kind: item.kind, description: item.description, amountMinor: item.amountMinor, currency: item.currency, dueDate: date, status: 'pending', suggested: false, projected: true });
    }
  }
  return out;
}

export interface DayPoint {
  date: string;
  balanceMinor: number;
  entries: Entry[];
}

export type StrategyLine =
  | { kind: 'short'; date: string; shortMinor: number; payable: string | null; nextReceivable: { description: string; amountMinor: number; date: string } | null }
  | { kind: 'overdue_receivable'; description: string; amountMinor: number; date: string }
  | { kind: 'ok'; biggest: { description: string; amountMinor: number; date: string } | null };

export interface MonthResult {
  currency: string;
  availableMinor: number;
  receivableMinor: number;
  payableMinor: number;
  resultMinor: number;
  days: DayPoint[];
  strategy: StrategyLine[];
}

const daysInMonth = (month: string): number => {
  const [year, number] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(year, number, 0)).getUTCDate();
};

export function monthResult(input: { month: string; todayISO: string; availableMinor: number; currency: string; entries: Entry[] }): MonthResult {
  const { month, todayISO, availableMinor, currency } = input;
  const isCurrent = monthOf(todayISO) === month;
  const first = `${month}-01`;
  const mine = input.entries.filter((e) => e.currency === currency);

  // Fecha efectiva: en el mes actual, lo vencido y lo de hoy se aplican hoy.
  const effective = (e: Entry) => (isCurrent && e.dueDate < todayISO ? todayISO : e.dueDate);
  // Cuenta en el mes: los del mes y, solo en el mes actual, los vencidos de meses anteriores.
  const counted = mine.filter((e) => e.status === 'pending' && (monthOf(e.dueDate) === month || (isCurrent && e.dueDate < first)));

  const receivableMinor = counted.filter((e) => e.kind === 'receivable').reduce((s, e) => s + e.amountMinor, 0);
  const payableMinor = counted.filter((e) => e.kind === 'payable').reduce((s, e) => s + e.amountMinor, 0);

  const startDay = isCurrent ? todayISO : first;
  let balance = availableMinor;
  const days: DayPoint[] = [];
  for (let n = 1; n <= daysInMonth(month); n++) {
    const date = `${month}-${String(n).padStart(2, '0')}`;
    if (date >= startDay) {
      for (const e of counted) if (effective(e) === date) balance += e.kind === 'receivable' ? e.amountMinor : -e.amountMinor;
    }
    // Los vencidos se muestran en el día de hoy; los hechos/cancelados solo se muestran.
    const shown = mine.filter((e) => (e.status === 'pending' ? counted.includes(e) && effective(e) === date : e.dueDate === date));
    days.push({ date, balanceMinor: balance, entries: shown });
  }

  const strategy: StrategyLine[] = [];
  // Antes de startDay el saldo es solo el disponible inicial: no cuenta como "primer día corto".
  const negative = days.find((d) => d.date >= startDay && d.balanceMinor < 0);
  if (negative) {
    // Intra-día no hay orden: "el pago más grande del día" hace de el que hunde el saldo; sin pagos ese día = arrastre negativo.
    const payable = negative.entries.filter((e) => e.kind === 'payable' && e.status === 'pending').sort((a, b) => b.amountMinor - a.amountMinor)[0];
    const next = counted
      .filter((e) => e.kind === 'receivable' && effective(e) > negative.date)
      .sort((a, b) => effective(a).localeCompare(effective(b)))[0];
    strategy.push({
      kind: 'short',
      date: negative.date,
      shortMinor: -negative.balanceMinor,
      payable: payable?.description ?? null,
      nextReceivable: next ? { description: next.description, amountMinor: next.amountMinor, date: effective(next) } : null,
    });
  }
  mine
    .filter((e) => e.kind === 'receivable' && e.status === 'pending' && e.dueDate < todayISO && counted.includes(e))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .slice(0, 2)
    .forEach((e) => strategy.push({ kind: 'overdue_receivable', description: e.description, amountMinor: e.amountMinor, date: e.dueDate }));
  if (!negative) {
    // Lo más grande por pagar aún en el mes (empate: la fecha más temprana).
    const big = counted.filter((e) => e.kind === 'payable').sort((a, b) => b.amountMinor - a.amountMinor || effective(a).localeCompare(effective(b)))[0];
    strategy.unshift({ kind: 'ok', biggest: big ? { description: big.description, amountMinor: big.amountMinor, date: effective(big) } : null });
  }

  return { currency, availableMinor, receivableMinor, payableMinor, resultMinor: availableMinor + receivableMinor - payableMinor, days, strategy };
}

/**
 * Resultado por moneda del mes visible. Mes actual y pasado: disponible = saldos. Mes futuro: se encadena
 * desde el mes actual con el saldo proyectado al cierre de cada mes.
 */
export function monthResults(input: { month: string; todayISO: string; balances: { currency: string; amountMinor: number }[]; entries: Entry[] }): MonthResult[] {
  const current = monthOf(input.todayISO);
  const first = `${input.month}-01`;
  // Solo monedas con saldo o con algo pendiente que cuente en el mes visible (no un USD viejo ya hecho).
  const counts = (e: Entry) => e.status === 'pending' && (monthOf(e.dueDate) === input.month || (input.month === current && e.dueDate < first));
  const currencies = [...new Set([...input.balances.map((b) => b.currency), ...input.entries.filter(counts).map((e) => e.currency)])].sort();
  return currencies.map((currency) => {
    let available = input.balances.filter((b) => b.currency === currency).reduce((s, b) => s + b.amountMinor, 0);
    let result = monthResult({ month: input.month > current ? current : input.month, todayISO: input.todayISO, availableMinor: available, currency, entries: input.entries });
    for (let m = shiftMonth(current, 1); m <= input.month; m = shiftMonth(m, 1)) {
      available = result.days[result.days.length - 1]!.balanceMinor;
      result = monthResult({ month: m, todayISO: input.todayISO, availableMinor: available, currency, entries: input.entries });
    }
    return result;
  });
}
