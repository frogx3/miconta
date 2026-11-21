import type { PreviewResult } from './service';
import type { StatementComparison } from '../statements/compare';

/** Un cuadrito por renglón del archivo, en el orden en que viene; el color dice qué pasará con él. */
export type CsvTile = 'new' | 'duplicate' | 'installment' | 'possiblePlan' | 'error';
/** Un cuadrito por renglón del estado de cuenta (más lo que sobra en Don Bigo, aparte). */
export type StatementTile = 'matched' | 'missing' | 'changed' | 'planDiffers' | 'planMissing' | 'extra';

export function countTiles<T extends string>(tiles: readonly T[]): Partial<Record<T, number>> {
  const counts: Partial<Record<T, number>> = {};
  for (const tile of tiles) counts[tile] = (counts[tile] ?? 0) + 1;
  return counts;
}

/**
 * Renglones del CSV. Los renglones de un pago agrupado (intereses, IVA, compra original) van dentro de su principal,
 * igual que en la tabla de movimientos; los errores van al final porque no tienen movimiento.
 */
export function csvTiles(preview: Pick<PreviewResult, 'movements' | 'planMatches' | 'errors'>): CsvTile[] {
  const matched = new Set(preview.planMatches.map((match) => match.movementKey));
  const tiles = preview.movements
    .filter((m) => m.group?.role !== 'member' && m.group?.role !== 'credit')
    .map((m): CsvTile => (m.status === 'duplicate' ? 'duplicate' : matched.has(m.key) ? 'installment' : m.hints.length > 0 ? 'possiblePlan' : 'new'));
  return [...tiles, ...preview.errors.map((): CsvTile => 'error')];
}

/** Renglones del estado de cuenta contra Don Bigo, del más común al más raro. */
export function statementTiles(c: StatementComparison): StatementTile[] {
  const repeat = (tile: StatementTile, n: number) => Array<StatementTile>(n).fill(tile);
  return [
    ...repeat('matched', c.matched.length + c.plans.matched.length),
    ...repeat('missing', c.missing.length),
    ...repeat('changed', c.changed.length),
    ...repeat('planDiffers', c.plans.differs.length),
    ...repeat('planMissing', c.plans.missing.length),
    ...repeat('extra', c.extra.length),
  ];
}
