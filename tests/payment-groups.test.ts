import { describe, expect, it } from 'vitest';
import { groupedMemberKeys, paymentGroups, type GroupableRow } from '../src/lib/spending/groups';

const row = (key: string, descriptionNorm: string, chargeMinor: number, creditMinor = 0, reference: string | null = 'R1', cardKey: string | null = 'c1'): GroupableRow => ({
  key,
  cardKey,
  reference,
  descriptionNorm,
  chargeMinor,
  creditMinor,
});

const autozone = [
  row('i', 'INTERESES SUJETOS A IVA', 8098),
  row('v', 'IVA SOBRE INTERESES DB', 1296),
  row('p', 'AUTOZONE 9540 MERIDA', 45588),
  row('a', 'AUTOZONE 9540 MERIDA', 0, 441700),
];

describe('pagos agrupados por referencia', () => {
  it('une el pago requerido, los intereses y el IVA, y deja la compra original como abono', () => {
    const groups = paymentGroups(autozone);
    expect([...groups.keys()]).toEqual(['p']);
    const group = groups.get('p')!;
    expect(group.totalMinor).toBe(54982);
    expect(group.financeMinor).toBe(9394);
    expect(group.chargeKeys.sort()).toEqual(['i', 'p', 'v']);
    expect(group.creditKeys).toEqual(['a']);
    expect(groupedMemberKeys(groups)).toEqual(new Set(['i', 'v', 'a']));
  });

  it('sin intereses no hay grupo, aunque compartan referencia', () => {
    expect(paymentGroups([row('p', 'AMAZON', 1000), row('q', 'AMAZON', 2000)]).size).toBe(0);
  });

  it('solo intereses, sin cargo principal, no es un grupo', () => {
    expect(paymentGroups([row('i', 'INTERESES SUJETOS A IVA', 100), row('v', 'IVA SOBRE INTERESES DB', 16)]).size).toBe(0);
  });

  it('con más de un cargo no financiero no adivina cuál es el principal', () => {
    expect(paymentGroups([...autozone, row('x', 'OTRO COMERCIO', 500)]).size).toBe(0);
  });

  it('no mezcla tarjetas ni referencias distintas, ni filas sin referencia', () => {
    expect(paymentGroups([row('i', 'INTERESES', 100, 0, 'R1', 'c1'), row('p', 'COMERCIO', 500, 0, 'R1', 'c2')]).size).toBe(0);
    expect(paymentGroups([row('i', 'INTERESES', 100, 0, 'R1'), row('p', 'COMERCIO', 500, 0, 'R2')]).size).toBe(0);
    expect(paymentGroups([row('i', 'INTERESES', 100, 0, null), row('p', 'COMERCIO', 500, 0, null)]).size).toBe(0);
  });

  it('detecta varios grupos independientes', () => {
    const second = [row('i2', 'INTERESES', 50, 0, 'R2'), row('p2', 'OTRO', 300, 0, 'R2')];
    expect([...paymentGroups([...autozone, ...second]).keys()].sort()).toEqual(['p', 'p2']);
  });
});
