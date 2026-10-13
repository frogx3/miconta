import { describe, expect, it } from 'vitest';
import type { SpendRow } from '../src/lib/spending/analysis';
import { matchPlanInstallments, type PlanLike } from '../src/lib/import/plans';
import { dueDateFor, isCardPayment, realCuts, sinceLastCut, summarizeStatement, type RecordedCutoff } from '../src/lib/spending/statement';

const cut = (cutoffDate: string, startDate: string | null = null): RecordedCutoff => ({ cutoffDate, startDate, officialPayMinor: null });

describe('cortes reales', () => {
  it('no inventa cortes: solo existen los capturados, del más antiguo al más reciente', () => {
    const cuts = realCuts([cut('2026-09-02'), cut('2026-08-04', '2026-07-02')], 4, 24);
    expect(cuts.map((c) => c.month)).toEqual(['2026-08', '2026-09']);
  });

  it('el inicio capturado manda; si no hay, es el día siguiente al corte real anterior', () => {
    const [aug, sep] = realCuts([cut('2026-08-04', '2026-07-02'), cut('2026-09-02')], 4, null);
    expect(aug).toMatchObject({ from: '2026-07-02', to: '2026-08-04' });
    // El banco cortó el 4 de agosto y el 2 de septiembre: septiembre empieza el 5 de agosto, no el estimado.
    expect(sep).toMatchObject({ from: '2026-08-05', to: '2026-09-02' });
  });

  it('solo el primer corte sin inicio se estima con el día de corte de la tarjeta', () => {
    expect(realCuts([cut('2026-08-04')], 4, null)[0]!.from).toBe('2026-07-05');
    expect(realCuts([cut('2026-08-04')], null, null)[0]!.from).toBe('0000-01-01');
  });

  it('el periodo en curso empieza el día después del último corte real', () => {
    expect(sinceLastCut(realCuts([cut('2026-08-04', '2026-07-02'), cut('2026-09-02')], 4, null))).toEqual({ from: '2026-09-03' });
    expect(sinceLastCut([])).toBeNull();
  });

  it('la fecha de pago cae en el mismo mes si su día es posterior al corte, y si no al siguiente', () => {
    expect(dueDateFor(24, '2026-09-04')).toBe('2026-09-24');
    expect(dueDateFor(2, '2026-09-04')).toBe('2026-10-02');
    expect(dueDateFor(null, '2026-09-04')).toBeNull();
  });
});

describe('pago para no generar intereses', () => {
  const row = (descriptionNorm: string, chargeMinor: number, creditMinor = 0): SpendRow => ({ date: '2026-07-10', descriptionNorm, chargeMinor, creditMinor, currency: 'MXN', categoryId: null, planId: null });
  // Estado de cuenta Banorte de agosto: cargos 25,654.29, abonos 32,857.18 (el pago del corte anterior y la compra de AutoZone abonada
  // al convertirla a meses) y pago para no generar intereses 21,237.29, con adeudo anterior de 28,440.18.
  const august = [row('SUPER', 2_525_429 + 40_000), row('AUTOZONE 9540 MERIDA', 0, 441_700), row('PAGO BANCA DIGITAL / SUCURSAL GRACIAS.', 0, 2_844_018)];

  it('reconoce los pagos a la tarjeta y deja fuera devoluciones y compras convertidas', () => {
    expect(isCardPayment('PAGO BANCA DIGITAL / SUCURSAL GRACIAS.')).toBe(true);
    expect(isCardPayment('PAGO RECIBIDO')).toBe(true);
    expect(isCardPayment('AUTOZONE 9540 MERIDA')).toBe(false);
    expect(isCardPayment('DEVOLUCION AMAZON')).toBe(false);
  });

  it('sin el adeudo anterior resta las devoluciones y supone el corte anterior pagado', () => {
    const summary = summarizeStatement(august, 20_000);
    expect(summary).toMatchObject({ chargesMinor: 2_565_429, creditsMinor: 3_285_718, refundsMinor: 441_700, payMinor: 2_123_729, payBasis: 'estimate' });
  });

  it('con el adeudo anterior calcula igual que el banco: adeudo + cargos − abonos', () => {
    const summary = summarizeStatement(august, 20_000, 2_844_018);
    expect(summary).toMatchObject({ payMinor: 2_123_729, payBasis: 'exact' });
    // Si el corte anterior no se pagó completo, el adeudo pendiente se suma.
    expect(summarizeStatement([row('SUPER', 100_000), row('PAGO RECIBIDO', 0, 50_000)], 20_000, 200_000).payMinor).toBe(250_000);
  });

  it('nunca es negativo', () => {
    expect(summarizeStatement([row('SUPER', 10_000), row('DEVOLUCION', 0, 50_000)], 20_000).payMinor).toBe(0);
  });
});

describe('emparejar mensualidades con diferencias de monto', () => {
  const plan = (over: Partial<PlanLike> = {}): PlanLike => ({ id: 'p', matchText: 'MAPFRE L COBRANZA', installmentAmountMinor: 95_785, totalInstallments: 12, paidInstallments: 11, firstChargeDate: '2025-09-19', status: 'active', ...over });
  const mov = (uniqueKey: string, descriptionNorm: string, chargeMinor: number, date: string) => ({ uniqueKey, date, descriptionNorm, chargeMinor });

  it('acepta los centavos que el banco ajusta en la última mensualidad (957.85 → 957.79)', () => {
    const { matches, missing } = matchPlanInstallments([plan()], [mov('m', 'MAPFRE L COBRANZA CIUDAD DE MEX MX', 95_779, '2026-08-19')], { amountToleranceMinor: 100, coverageEnd: '2026-09-04' });
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ installmentNo: 12, isFinal: true, amountDiffMinor: 6, movementAmountMinor: 95_779 });
    expect(missing).toEqual([]);
  });

  it('un pago con intereses admite hasta 5 % de diferencia: el interés baja con el saldo (549.82 → 548.05)', () => {
    const autozone = plan({ id: 'a', matchText: 'AUTOZONE 9540 MERIDA', installmentAmountMinor: 54_982, totalInstallments: 9, paidInstallments: 1, firstChargeDate: '2026-07-03', type: 'mci' });
    const rows = [mov('g', 'AUTOZONE 9540 MERIDA', 54_805, '2026-08-03')];
    expect(matchPlanInstallments([autozone], rows, { amountToleranceMinor: 100 }).matches).toHaveLength(1);
    // Un plan sin intereses con la misma diferencia no empareja: es otro cargo.
    expect(matchPlanInstallments([{ ...autozone, type: 'msi' }], rows, { amountToleranceMinor: 100 }).matches).toHaveLength(0);
  });

  it('no empareja un cargo muy distinto ni uno de otra fecha', () => {
    expect(matchPlanInstallments([plan()], [mov('m', 'MAPFRE L COBRANZA', 90_000, '2026-08-19')], { amountToleranceMinor: 100 }).matches).toHaveLength(0);
    expect(matchPlanInstallments([plan()], [mov('m', 'MAPFRE L COBRANZA', 95_785, '2026-09-19')], { amountToleranceMinor: 100 }).matches).toHaveLength(0);
  });

  it('con dos planes parecidos cada uno toma el cargo más cercano en monto', () => {
    const a = plan({ id: 'a', matchText: 'AMAZON A MESES', installmentAmountMinor: 25_000, totalInstallments: 6, paidInstallments: 1, firstChargeDate: '2026-07-06' });
    const b = { ...a, id: 'b', installmentAmountMinor: 25_050 };
    const rows = [mov('x', 'AMAZON A MESES', 25_050, '2026-08-06'), mov('y', 'AMAZON A MESES', 25_000, '2026-08-06')];
    const result = matchPlanInstallments([a, b], rows, { amountToleranceMinor: 100 }).matches;
    expect(result.map((m) => [m.planId, m.movementKey]).sort()).toEqual([['a', 'y'], ['b', 'x']]);
  });
});
