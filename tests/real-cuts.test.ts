import { describe, expect, it } from 'vitest';
import type { SpendRow } from '../src/lib/spending/analysis';
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
