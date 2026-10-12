import { shiftMonth, isAnt, isFinance, isSpend, monthOf, type SpendRow } from './analysis';

/**
 * Vista "por corte": los movimientos de una tarjeta entre dos cortes, aunque caigan en meses
 * distintos. Es lo que el banco suma para decir cuánto pagar sin generar intereses.
 */

const pad = (value: number) => String(value).padStart(2, '0');

/** Fecha del corte de un mes (`YYYY-MM`); si el mes no tiene ese día (31 en febrero), el último día. */
export function cutoffInMonth(cutoffDay: number, month: string): string {
  const [year, number] = month.split('-').map(Number) as [number, number];
  const lastDay = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return `${month}-${pad(Math.min(cutoffDay, lastDay))}`;
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Corte real capturado a partir del estado de cuenta del banco. */
export interface RecordedCutoff {
  cutoffDate: string;
  /** Primer día del periodo cuando no es el siguiente al corte anterior (el CSV solo trae la fecha de operación, no la de cargo). */
  startDate: string | null;
  /** "Pago para no generar intereses" que dice el estado de cuenta, para conciliar. */
  officialPayMinor: number | null;
}

/** Cortes capturados, indexados por el mes (`YYYY-MM`) en que caen. */
export type CutoffRecords = ReadonlyMap<string, RecordedCutoff>;

export const recordsByMonth = (list: readonly RecordedCutoff[]): CutoffRecords => new Map(list.map((record) => [monthOf(record.cutoffDate), record]));

export interface StatementPeriod {
  /** Fecha del corte que cierra el periodo. */
  cutoff: string;
  /** Primer día del periodo (el día siguiente al corte anterior, salvo que se haya fijado otro). */
  from: string;
  /** Último día del periodo (el propio corte). */
  to: string;
  /** Fecha límite de pago, si la tarjeta tiene día de pago. */
  dueDate: string | null;
  /** El corte aún no llega: el periodo sigue abierto y sus cifras van cambiando. */
  open: boolean;
  /** El corte salió del estado de cuenta; si no, se estimó con el día de corte de la tarjeta. */
  recorded: RecordedCutoff | null;
}

const cutoffOf = (cutoffDay: number, month: string, records: CutoffRecords): string => records.get(month)?.cutoffDate ?? cutoffInMonth(cutoffDay, month);

/**
 * Periodo que cierra el corte del mes `month`. Los bancos no siempre cortan el mismo día (4-sep, 2-oct),
 * así que un corte capturado manda sobre el día de corte de la tarjeta, que solo se usa para estimar.
 */
export function statementPeriod(cutoffDay: number, paymentDueDay: number | null, month: string, todayISO: string, records: CutoffRecords = new Map()): StatementPeriod {
  const recorded = records.get(month) ?? null;
  const cutoff = cutoffOf(cutoffDay, month, records);
  const from = recorded?.startDate ?? addDays(cutoffOf(cutoffDay, shiftMonth(month, -1), records), 1);
  // El pago cae en el mismo mes del corte si su día es posterior; si no, al mes siguiente.
  const dueMonth = paymentDueDay !== null && paymentDueDay <= Number(cutoff.slice(8)) ? shiftMonth(month, 1) : month;
  return { cutoff, from, to: cutoff, dueDate: paymentDueDay === null ? null : cutoffInMonth(paymentDueDay, dueMonth), open: cutoff > todayISO, recorded };
}

/** Fecha límite de pago de un corte: el mismo mes si el día de pago es posterior al del corte, si no, el mes siguiente. */
export function dueDateFor(paymentDueDay: number | null, cutoff: string): string | null {
  if (paymentDueDay === null) return null;
  const month = cutoff.slice(0, 7);
  return cutoffInMonth(paymentDueDay, paymentDueDay <= Number(cutoff.slice(8)) ? shiftMonth(month, 1) : month);
}

/** Un corte real (capturado del estado de cuenta) con su periodo ya resuelto. */
export interface RealCut {
  /** Mes en que cierra; es el nombre del corte ("Corte Agosto" = el que cierra en agosto). */
  month: string;
  cutoff: string;
  from: string;
  to: string;
  dueDate: string | null;
  recorded: RecordedCutoff;
}

/**
 * Cortes reales de una cuenta, del más antiguo al más reciente. El primer día es el que se capturó o, si no, el día
 * siguiente al corte real anterior; solo el primer corte sin inicio capturado se estima con el día de corte de la
 * tarjeta (si no hay, abarca desde el principio). Nunca se inventan cortes que nadie capturó.
 */
export function realCuts(list: readonly RecordedCutoff[], cutoffDay: number | null, paymentDueDay: number | null): RealCut[] {
  const sorted = [...list].sort((a, b) => a.cutoffDate.localeCompare(b.cutoffDate));
  return sorted.map((record, index) => {
    const previous = sorted[index - 1];
    const month = monthOf(record.cutoffDate);
    const estimatedStart = cutoffDay !== null ? addDays(cutoffInMonth(cutoffDay, shiftMonth(month, -1)), 1) : '0000-01-01';
    return {
      month,
      cutoff: record.cutoffDate,
      from: record.startDate ?? (previous ? addDays(previous.cutoffDate, 1) : estimatedStart),
      to: record.cutoffDate,
      dueDate: dueDateFor(paymentDueDay, record.cutoffDate),
      recorded: record,
    };
  });
}

/** Lo que va desde el último corte real hasta hoy: el periodo en curso, sin fecha de cierre conocida. */
export function sinceLastCut(cuts: readonly RealCut[]): { from: string } | null {
  const last = cuts.at(-1);
  return last ? { from: addDays(last.cutoff, 1) } : null;
}

/** Mes del corte más reciente ya ocurrido, o el siguiente si `includeOpen`. */
export function currentCutoffMonth(cutoffDay: number, todayISO: string, includeOpen = false, records: CutoffRecords = new Map()): string {
  const thisMonth = monthOf(todayISO);
  const closed = cutoffOf(cutoffDay, thisMonth, records) <= todayISO ? thisMonth : shiftMonth(thisMonth, -1);
  return includeOpen ? shiftMonth(closed, 1) : closed;
}

export interface StatementRow extends SpendRow {
  cardId: string | null;
}

export interface PlanChargeTotal {
  planId: string;
  amountMinor: number;
  count: number;
}

export interface StatementSummary {
  /** Todo lo cargado en el periodo: lo que se debe pagar para no generar intereses (si el corte anterior se pagó completo). */
  chargesMinor: number;
  chargeCount: number;
  /** Abonos y pagos del periodo; no se restan porque incluyen el pago del corte anterior. */
  creditsMinor: number;
  planChargesMinor: number;
  byPlan: PlanChargeTotal[];
  spendMinor: number;
  spendCount: number;
  /** Intereses, IVA y comisiones: están en el total a pagar, pero no son gasto. */
  financeMinor: number;
  antMinor: number;
  antCount: number;
}

export function summarizeStatement(rows: readonly SpendRow[], thresholdMinor: number): StatementSummary {
  const sum = (list: readonly SpendRow[]) => list.reduce((total, row) => total + row.chargeMinor, 0);
  const charges = rows.filter((row) => row.chargeMinor > 0);
  const spend = rows.filter(isSpend);
  const finance = charges.filter(isFinance);
  const ant = spend.filter((row) => isAnt(row, thresholdMinor));
  const planRows = charges.filter((row) => row.planId !== null);

  const byPlan = new Map<string, PlanChargeTotal>();
  for (const row of planRows) {
    const entry = byPlan.get(row.planId!) ?? { planId: row.planId!, amountMinor: 0, count: 0 };
    entry.amountMinor += row.chargeMinor;
    entry.count++;
    byPlan.set(row.planId!, entry);
  }
  const planChargesMinor = sum(planRows);
  return {
    chargesMinor: sum(charges),
    chargeCount: charges.length,
    creditsMinor: rows.reduce((total, row) => total + row.creditMinor, 0),
    planChargesMinor,
    byPlan: [...byPlan.values()].sort((a, b) => b.amountMinor - a.amountMinor),
    spendMinor: sum(spend),
    spendCount: spend.length,
    financeMinor: sum(finance),
    antMinor: sum(ant),
    antCount: ant.length,
  };
}
