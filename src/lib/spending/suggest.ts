import { isCardPayment, addDays } from './statement';
import { paymentGroups } from './groups';

/** Lo mínimo de un movimiento para sugerir ajustes de corte. */
export interface SuggestRow {
  id: string;
  date: string;
  description: string;
  descriptionNorm: string;
  reference: string | null;
  cardId: string | null;
  chargeMinor: number;
  creditMinor: number;
  statementMonth: string | null;
}

/** Algo que se mueve de corte como una sola cosa: un cargo suelto o un pago agrupado completo. */
export interface MoveUnit {
  ids: string[];
  label: string;
  date: string;
  /** Lo que sube el pago del corte donde cuenta: cargos menos devoluciones de la unidad. */
  effectMinor: number;
}

/**
 * Unidades candidatas: cargos de los últimos `days` días de `[from, to]` que no se han movido a mano.
 * El banco arma el estado de cuenta por fecha de cargo y el CSV trae la de operación: lo que se operó en los últimos días de un
 * corte puede cobrarse en el siguiente.
 */
export function moveCandidates(rows: readonly SuggestRow[], window: { from: string; to: string }, days = 3): MoveUnit[] {
  const groups = paymentGroups(rows.map((row) => ({ key: row.id, cardKey: row.cardId, reference: row.reference, descriptionNorm: row.descriptionNorm, chargeMinor: row.chargeMinor, creditMinor: row.creditMinor })));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const hidden = new Set<string>();
  for (const group of groups.values()) for (const id of [...group.chargeKeys, ...group.creditKeys]) if (id !== group.principalKey) hidden.add(id);

  const near = (date: string) => date >= addDays(window.to, -(days - 1)) && date <= window.to;
  const units: MoveUnit[] = [];
  for (const row of rows) {
    if (hidden.has(row.id) || row.statementMonth !== null || !near(row.date)) continue;
    const group = groups.get(row.id);
    if (group) {
      const refunds = group.creditKeys.reduce((sum, id) => sum + (isCardPayment(byId.get(id)!.descriptionNorm) ? 0 : byId.get(id)!.creditMinor), 0);
      units.push({ ids: [...group.chargeKeys, ...group.creditKeys], label: row.description, date: row.date, effectMinor: group.totalMinor - refunds });
    } else if (row.chargeMinor > 0) {
      units.push({ ids: [row.id], label: row.description, date: row.date, effectMinor: row.chargeMinor });
    }
  }
  return units.filter((unit) => unit.effectMinor > 0);
}

/**
 * Busca el conjunto más pequeño de unidades cuya suma es exactamente `targetMinor` (la diferencia con el estado de cuenta).
 * Devuelve `null` si no hay ninguno; con muchas candidatas solo mira las `max` más cercanas al corte.
 */
export function findExactSubset(units: readonly MoveUnit[], targetMinor: number, max = 22): MoveUnit[] | null {
  if (targetMinor <= 0) return null;
  const pool = units.filter((unit) => unit.effectMinor <= targetMinor).slice(0, max);
  let reachable = new Map<number, MoveUnit[]>([[0, []]]);
  for (const unit of pool) {
    const next = new Map(reachable);
    for (const [sum, chosen] of reachable) {
      const total = sum + unit.effectMinor;
      if (total > targetMinor) continue;
      const existing = next.get(total);
      if (!existing || existing.length > chosen.length + 1) next.set(total, [...chosen, unit]);
    }
    reachable = next;
    if (reachable.size > 300_000) break;
  }
  const found = reachable.get(targetMinor);
  return found && found.length > 0 ? found : null;
}
