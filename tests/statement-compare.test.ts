import { describe, expect, it } from 'vitest';
import { bankIdFromText } from '../src/lib/banks';
import { hasFeature } from '../src/lib/membership';
import type { MatchablePlan } from '../src/lib/plans/bank-balances';
import { compareStatement, type ExistingMovement, type ExtractedStatement, type StatementMovement } from '../src/lib/statements/compare';

const mov = (date: string, description: string, chargeMinor: number, last4: string | null = '4172', creditMinor = 0): StatementMovement => ({
  date, postedDate: null, description, chargeMinor, creditMinor, last4,
});
const have = (id: string, date: string, description: string, chargeMinor: number, last4: string | null = '4172', creditMinor = 0): ExistingMovement => ({
  id, date, description, chargeMinor, creditMinor, last4,
});
const statement = (movements: StatementMovement[], extra: Partial<ExtractedStatement> = {}): ExtractedStatement => ({
  bankId: 'banorte', currency: 'MXN', period: { start: '2026-10-03', cutoff: '2026-11-04', dueDate: '2026-11-24' }, totals: null, movements, plans: [], ...extra,
});
const none = { movements: [], plans: [], cutoff: null };

describe('comparador de estados de cuenta', () => {
  it('empareja por monto, tarjeta y fecha cercana, y separa faltantes y sobrantes', () => {
    const result = compareStatement(
      statement([mov('2026-10-05', 'OXXO MERIDA', 4_550), mov('2026-10-06', 'AMAZON MX', 129_900), mov('2026-10-20', 'PAGO RECIBIDO', 0, '4172', 500_000)]),
      { ...none, movements: [have('a', '2026-10-07', 'OXXO MERIDA CENTRO', 4_550), have('b', '2026-10-21', 'SU PAGO GRACIAS', 0, null, 500_000), have('c', '2026-10-15', 'NETFLIX', 21_900)] },
    );
    expect(result.matched.map((pair) => pair.existing.id)).toEqual(['b', 'a']);
    expect(result.missing.map((m) => m.description)).toEqual(['AMAZON MX']);
    expect(result.extra.map((m) => m.id)).toEqual(['c']);
    expect(result.changed).toEqual([]);
  });

  it('no empareja otra tarjeta ni fechas lejanas, y prefiere la descripción parecida', () => {
    const result = compareStatement(statement([mov('2026-10-05', 'UBER TRIP', 8_000, '2455'), mov('2026-10-10', 'STARBUCKS', 9_500)]), {
      ...none,
      movements: [have('otra', '2026-10-05', 'UBER TRIP', 8_000, '4172'), have('lejos', '2026-10-20', 'STARBUCKS', 9_500), have('x', '2026-10-10', 'CINEPOLIS', 9_500), have('y', '2026-10-10', 'STARBUCKS COFFEE', 9_500)],
    });
    expect(result.matched.map((pair) => pair.existing.id)).toEqual(['y']);
    expect(result.missing.map((m) => m.description)).toEqual(['UBER TRIP']);
  });

  it('detecta el mismo movimiento con otro monto', () => {
    const result = compareStatement(statement([mov('2026-10-08', 'GASOLINERA PEMEX 123', 85_000)]), { ...none, movements: [have('g', '2026-10-08', 'GASOLINERA PEMEX', 80_000)] });
    expect(result.changed).toHaveLength(1);
    expect(result.missing).toEqual([]);
    expect(result.extra).toEqual([]);
  });

  it('se comprueba contra los totales impresos', () => {
    const movements = [mov('2026-10-05', 'A', 1_000), mov('2026-10-06', 'B', 0, '4172', 300)];
    expect(compareStatement(statement(movements, { totals: { chargesMinor: 1_000, creditsMinor: 300 } }), none).totalsOk).toBe(true);
    expect(compareStatement(statement(movements, { totals: { chargesMinor: 1_001, creditsMinor: 300 } }), none).totalsOk).toBe(false);
    expect(compareStatement(statement(movements), none).totalsOk).toBeNull();
  });

  it('compara planes: iguales, con otro número de pago y faltantes', () => {
    const plan = (id: string, firstChargeDate: string, total: number, paid: number, amount: number): MatchablePlan => ({
      id, name: id, status: 'active', totalInstallments: total, paidInstallments: paid, installmentAmountMinor: amount, firstChargeDate,
    });
    const row = (date: string, total: number, current: number, payment: number) => ({ date, description: 'X', originalMinor: payment * total, pendingMinor: payment * (total - current), interestMinor: 0, paymentMinor: payment, current, total });
    const result = compareStatement(statement([], { plans: [row('2026-06-30', 12, 5, 25_225), row('2026-07-06', 6, 6, 10_000), row('2026-09-08', 12, 2, 112_312)] }), {
      ...none,
      plans: [plan('igual', '2026-06-30', 12, 5, 25_225), plan('atrasado', '2026-07-06', 6, 3, 10_000)],
    });
    expect(result.plans.matched.map((m) => m.planId)).toEqual(['igual']);
    expect(result.plans.differs).toMatchObject([{ planId: 'atrasado', paidInstallments: 3, row: { current: 6 } }]);
    expect(result.plans.missing.map((r) => r.date)).toEqual(['2026-09-08']);
  });

  it('avisa si el corte o la fecha límite no coinciden con los capturados', () => {
    expect(compareStatement(statement([]), { ...none, cutoff: { date: '2026-11-04', dueDate: '2026-11-24' } }).cutoffDiffers).toBe(false);
    expect(compareStatement(statement([]), { ...none, cutoff: { date: '2026-11-04', dueDate: '2026-11-22' } }).cutoffDiffers).toBe(true);
    expect(compareStatement(statement([]), none).cutoffDiffers).toBeNull();
  });
});

describe('catálogo de bancos y niveles', () => {
  it('deduce el banco desde el nombre escrito', () => {
    expect(['Mi Banorte', 'Citibanamex', 'BBVA Bancomer', 'Banjército', 'Plata'].map(bankIdFromText)).toEqual(['banorte', 'banamex', 'bbva', 'banjercito', 'other']);
  });

  it('la IA solo está en Premium; el MCP desde Profesional', () => {
    expect([hasFeature('standard', 'mcp'), hasFeature('professional', 'mcp'), hasFeature('professional', 'ai'), hasFeature('premium', 'ai')]).toEqual([false, true, false, true]);
  });
});
