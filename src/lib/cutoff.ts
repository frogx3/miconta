import { addMonthsISO } from './import/dates';

const pad = (value: number) => String(value).padStart(2, '0');

/**
 * Último corte ocurrido hasta `todayISO` según el día de corte de la tarjeta.
 * Si el mes no tiene ese día (31 en febrero), el corte cae en el último día del mes.
 */
export function lastCutoffDate(cutoffDay: number, todayISO: string): string {
  const [year, month] = todayISO.split('-').map(Number) as [number, number];
  const inMonth = (y: number, m: number) => {
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return `${y}-${pad(m)}-${pad(Math.min(cutoffDay, lastDay))}`;
  };
  const candidate = inMonth(year, month);
  if (candidate <= todayISO) return candidate;
  const previous = addMonthsISO(`${year}-${pad(month)}-01`, -1);
  const [py, pm] = previous.split('-').map(Number) as [number, number];
  return inMonth(py, pm);
}
