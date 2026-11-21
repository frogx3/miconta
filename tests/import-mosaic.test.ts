import { describe, expect, it } from 'vitest';
import { countTiles, csvTiles, statementTiles } from '../src/lib/import/mosaic';
import type { PreviewMovement } from '../src/lib/import/service';
import type { StatementComparison } from '../src/lib/statements/compare';

const mov = (key: string, extra: Partial<PreviewMovement> = {}): PreviewMovement => ({
  key, line: 1, date: '2026-11-03', description: key, reference: null, chargeMinor: 100, creditMinor: 0, chargeInput: '1.00',
  cardLast4: '4821', cardKind: null, status: 'new', hints: [], group: null, ...extra,
});

describe('mosaico del archivo', () => {
  it('un cuadrito por renglón: mensualidad gana a la pista de plan, y los renglones de un pago agrupado no cuentan aparte', () => {
    const tiles = csvTiles({
      movements: [
        mov('a'),
        mov('b', { status: 'duplicate' }),
        mov('c', { hints: ['installments_in_description'] }),
        mov('d', { hints: ['installments_in_description'] }),
        mov('e', { group: { role: 'principal', totalMinor: 300, totalInput: '3.00', items: 3 } }),
        mov('f', { group: { role: 'member', principalKey: 'e' } }),
        mov('g', { group: { role: 'credit', principalKey: 'e' } }),
      ],
      planMatches: [{ movementKey: 'd' }] as never,
      errors: [{ line: 9, message: 'x' }] as never,
    });
    expect(tiles).toEqual(['new', 'duplicate', 'possiblePlan', 'installment', 'new', 'error']);
    expect(countTiles(tiles)).toEqual({ new: 2, duplicate: 1, possiblePlan: 1, installment: 1, error: 1 });
  });

  it('el estado de cuenta: coinciden movimientos y planes, y cada diferencia tiene su color', () => {
    const c = {
      totalsOk: true, cutoffDiffers: false,
      matched: [{}, {}], changed: [{}], missing: [{}, {}, {}], extra: [{}],
      plans: { matched: [{}], differs: [{}], missing: [] },
    } as unknown as StatementComparison;
    expect(countTiles(statementTiles(c))).toEqual({ matched: 3, missing: 3, changed: 1, planDiffers: 1, extra: 1 });
  });
});
