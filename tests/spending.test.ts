import { describe, expect, it } from 'vitest';
import {
  analyzeMonth, annualized, budgetStatus, isFinanceCharge, defaultAntThreshold, isAnt, lastMonths, shiftMonth, thresholdFor, trend, type SpendRow,
} from '../src/lib/spending/analysis';
import { matchCategory, mergeMerchantKeys, merchantKey, normalizePattern } from '../src/lib/spending/categorize';
import { currentCutoffMonth, cutoffInMonth, recordsByMonth, statementPeriod, summarizeStatement } from '../src/lib/spending/statement';
import { validateCategory, validateCutoff, validateRule, validateThreshold } from '../src/lib/spending/validation';

describe('reglas de categorización', () => {
  const rules = [
    { categoryId: 'super', pattern: 'OXXO' },
    { categoryId: 'gasolina', pattern: 'OXXO GAS' },
    { categoryId: 'subs', pattern: 'PAYPAL' },
  ];

  it('gana el patrón más largo (más específico)', () => {
    expect(matchCategory('OXXO GAS MERIDA', rules)).toBe('gasolina');
    expect(matchCategory('OXXOAMERICAS NORTE MERIDA YUC MX', rules)).toBe('super');
  });

  it('sin coincidencia devuelve null', () => {
    expect(matchCategory('TELMEX CARGO RECURR', rules)).toBeNull();
    expect(matchCategory('ALGO', [])).toBeNull();
  });

  it('a igual longitud el resultado es siempre el mismo', () => {
    const tied = [{ categoryId: 'b', pattern: 'ZZ' }, { categoryId: 'a', pattern: 'AB' }];
    expect(matchCategory('AB ZZ', tied)).toBe('a');
    expect(matchCategory('AB ZZ', [...tied].reverse())).toBe('a');
  });

  it('el patrón se normaliza como el concepto (acentos, mayúsculas, espacios)', () => {
    expect(normalizePattern('  café  del   Centro ')).toBe('CAFE DEL CENTRO');
  });

  it('un patrón con caracteres de regex se trata como texto literal', () => {
    expect(matchCategory('A+B', [{ categoryId: 'x', pattern: 'A+B' }])).toBe('x');
    expect(matchCategory('AAB', [{ categoryId: 'x', pattern: 'A+B' }])).toBeNull();
  });
});

describe('clave de comercio', () => {
  it.each([
    ['OXXOAMERICAS NORTE MERIDA YUC MX', 'OXXOAMERICAS'],
    ['OXXO CITTADELA MID MERIDA YUC MX', 'OXXO'],
    ['PAYPAL *IONOS INC CIUDAD DE MEX MX', 'IONOS'],
    ['PAY PAL*GODADDY COM CIUDAD DE MEX MX', 'GODADDY'],
    ['MERPAGO*EDUARDOFLORES CIUDAD DE MEX MX', 'EDUARDOFLORES'],
    ['BPK*MISCTDA ABARROTES CIUDAD DE MEX MX', 'MISCTDA'],
    ['T1 TELCEL PYRE CIUDAD DE MEX MX', 'T1 TELCEL'],
    ['EL AGUILA CIA SEG CC CIUDAD DE M', 'EL AGUILA'],
    ['GAS SERV SAN IDELFONSO OTHON P BLANC MX', 'GAS SERV'],
    ['AMAZON A MESES CIUDAD DE MEX MX', 'AMAZON'],
  ])('%s → %s', (description, expected) => {
    expect(merchantKey(description)).toBe(expected);
  });

  it('junta las variantes de un comercio en la clave más corta', () => {
    const grouped = mergeMerchantKeys(['OXXOAMERICAS', 'OXXO', 'OXXOLA', 'OXXOBOREAS', 'AMAZON', 'GAS SERV', 'GAS SERVICIOS']);
    expect([grouped.get('OXXOAMERICAS'), grouped.get('OXXOLA'), grouped.get('OXXOBOREAS'), grouped.get('OXXO')]).toEqual(['OXXO', 'OXXO', 'OXXO', 'OXXO']);
    expect(grouped.get('AMAZON')).toBe('AMAZON');
    // Las claves de varias palabras no absorben a otras.
    expect(grouped.get('GAS SERVICIOS')).toBe('GAS SERVICIOS');
  });

  it('no junta prefijos demasiado cortos', () => {
    const grouped = mergeMerchantKeys(['GAS', 'GASOLINERA']);
    expect(grouped.get('GASOLINERA')).toBe('GASOLINERA');
  });
});

describe('meses y umbral', () => {
  it('desplaza meses cruzando el año', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-10', -10)).toBe('2025-12');
  });

  it('da los últimos N meses en orden', () => {
    expect(lastMonths('2026-02', 4)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });

  it('el umbral por defecto es 200 unidades de la moneda', () => {
    expect(defaultAntThreshold('MXN')).toBe(20_000);
    expect(defaultAntThreshold('JPY')).toBe(200);
    expect(defaultAntThreshold('KWD')).toBe(200_000);
  });

  it('el umbral configurado solo vale para la moneda del espacio', () => {
    const workspace = { currency: 'MXN', thresholdMinor: 15_000 };
    expect(thresholdFor('MXN', workspace)).toBe(15_000);
    expect(thresholdFor('USD', workspace)).toBe(20_000);
    expect(thresholdFor('MXN', { currency: 'MXN', thresholdMinor: null })).toBe(20_000);
  });

  it('hormiga: cargo pequeño que no es de un plan', () => {
    expect(isAnt({ chargeMinor: 20_000, planId: null }, 20_000)).toBe(true);
    expect(isAnt({ chargeMinor: 20_001, planId: null }, 20_000)).toBe(false);
    expect(isAnt({ chargeMinor: 100, planId: 'p' }, 20_000)).toBe(false);
    expect(isAnt({ chargeMinor: 0, planId: null }, 20_000)).toBe(false);
  });
});

describe('análisis mensual', () => {
  const row = (over: Partial<SpendRow> & Pick<SpendRow, 'date' | 'chargeMinor'>): SpendRow => ({
    descriptionNorm: 'TIENDA', creditMinor: 0, currency: 'MXN', categoryId: null, planId: null, ...over,
  });
  const rows: SpendRow[] = [
    row({ date: '2026-09-02', chargeMinor: 15_000, descriptionNorm: 'OXXOAMERICAS NORTE MERIDA MX', categoryId: 'super' }),
    row({ date: '2026-09-05', chargeMinor: 8_000, descriptionNorm: 'OXXO CHENKU II MERIDA MX', categoryId: 'super' }),
    row({ date: '2026-09-09', chargeMinor: 12_000, descriptionNorm: 'PAYPAL *IONOS INC CDMX MX' }),
    row({ date: '2026-09-10', chargeMinor: 112_200, descriptionNorm: 'TELMEX CARGO RECURR', categoryId: 'servicios' }),
    row({ date: '2026-09-11', chargeMinor: 57_171, descriptionNorm: 'RUMAYA TRAVEL', planId: 'plan1' }),
    row({ date: '2026-09-12', chargeMinor: 0, creditMinor: 2_840_554, descriptionNorm: 'PAGO BANCA DIGITAL' }),
    row({ date: '2026-09-15', chargeMinor: 5_000, currency: 'USD' }),
    row({ date: '2026-10-01', chargeMinor: 9_000 }),
  ];
  const thresholds = (currency: string) => defaultAntThreshold(currency);
  const [mxn, usd] = analyzeMonth(rows, '2026-09', thresholds);

  it('separa por moneda sin mezclar', () => {
    expect([mxn!.currency, usd!.currency]).toEqual(['MXN', 'USD']);
    expect(usd!.spendMinor).toBe(5_000);
  });

  it('el gasto excluye abonos y cargos de planes, que se cuentan aparte', () => {
    expect(mxn!.spendMinor).toBe(15_000 + 8_000 + 12_000 + 112_200);
    expect(mxn!.spendCount).toBe(4);
    expect(mxn!.planChargesMinor).toBe(57_171);
  });

  it('calcula los gastos hormiga y su peso', () => {
    expect(mxn!.antMinor).toBe(15_000 + 8_000 + 12_000);
    expect(mxn!.antCount).toBe(3);
    expect(mxn!.antShare).toBeCloseTo(35_000 / 147_200, 6);
    expect(annualized(mxn!.antMinor)).toBe(35_000 * 12);
  });

  it('desglosa por categoría, con "sin categoría" aparte', () => {
    expect(mxn!.byCategory.map((c) => [c.categoryId, c.amountMinor, c.count, c.antMinor])).toEqual([
      ['servicios', 112_200, 1, 0],
      ['super', 23_000, 2, 23_000],
      [null, 12_000, 1, 12_000],
    ]);
    expect([mxn!.uncategorizedMinor, mxn!.uncategorizedCount]).toEqual([12_000, 1]);
  });

  it('agrupa a los comercios hormiga y calcula su promedio', () => {
    expect(mxn!.topAnt).toEqual([
      { key: 'OXXO', amountMinor: 23_000, count: 2, averageMinor: 11_500 },
      { key: 'IONOS', amountMinor: 12_000, count: 1, averageMinor: 12_000 },
    ]);
  });

  it('un mes sin movimientos no produce análisis', () => {
    expect(analyzeMonth(rows, '2026-08', thresholds)).toEqual([]);
  });

  it('la tendencia es continua: los meses vacíos salen en cero', () => {
    const result = trend(rows, ['2026-08', '2026-09', '2026-10'], thresholds);
    const mxnTrend = result.find((r) => r.currency === 'MXN')!.points;
    expect(mxnTrend.map((p) => [p.month, p.spendMinor, p.antMinor, p.antCount])).toEqual([
      ['2026-08', 0, 0, 0],
      ['2026-09', 147_200, 35_000, 3],
      ['2026-10', 9_000, 9_000, 1],
    ]);
  });
});

describe('validación', () => {
  it('categoría: nombre y color de la paleta', () => {
    expect(validateCategory({ name: '  Despensa  ', color: '#2563eb' })).toEqual({ ok: true, value: { name: 'Despensa', color: '#2563eb' } });
    expect(validateCategory({ name: 'X' })).toMatchObject({ ok: true, value: { color: null } });
    expect(validateCategory({ name: '', color: '#123456' })).toEqual({ ok: false, errors: [{ field: 'name', code: 'required' }, { field: 'color', code: 'invalid_color' }] });
    expect(validateCategory({ name: 'x'.repeat(41) })).toEqual({ ok: false, errors: [{ field: 'name', code: 'too_long' }] });
  });

  it('regla: patrón normalizado de 2 a 60 caracteres', () => {
    expect(validateRule({ pattern: ' oxxo ', categoryId: 'c1' })).toEqual({ ok: true, value: { pattern: 'OXXO', categoryId: 'c1' } });
    expect(validateRule({ pattern: 'a', categoryId: 'c1' })).toEqual({ ok: false, errors: [{ field: 'pattern', code: 'too_short' }] });
    expect(validateRule({ pattern: 'ok', categoryId: '' })).toEqual({ ok: false, errors: [{ field: 'categoryId', code: 'required' }] });
  });

  it('umbral: monto positivo en el formato del locale', () => {
    expect(validateThreshold('150.50', 'es-MX', 'MXN')).toEqual({ ok: true, value: 15_050 });
    expect(validateThreshold('150,50', 'es-AR', 'ARS')).toEqual({ ok: true, value: 15_050 });
    expect(validateThreshold('0', 'es-MX', 'MXN')).toEqual({ ok: false, errors: [{ field: 'antThreshold', code: 'invalid_amount' }] });
    expect(validateThreshold('', 'es-MX', 'MXN')).toEqual({ ok: false, errors: [{ field: 'antThreshold', code: 'required' }] });
  });
});

import { isMonth, monthBounds, resolveMonth } from '../src/lib/spending/analysis';

describe('mes de la URL', () => {
  it('acepta solo YYYY-MM válidos', () => {
    expect(['2026-09', '2026-13', '2026-00', '26-09', '2026-9', null, 'x'].map(isMonth)).toEqual([true, false, false, false, false, false, false]);
  });

  it('usa el pedido, si no el último con datos, si no el actual', () => {
    expect(resolveMonth('2026-05', '2026-09', '2026-10-08')).toBe('2026-05');
    expect(resolveMonth('basura', '2026-09', '2026-10-08')).toBe('2026-09');
    expect(resolveMonth(null, null, '2026-10-08')).toBe('2026-10');
  });

  it('los límites del mes ordenan bien como texto', () => {
    expect(monthBounds('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-31' });
    expect('2026-02-28' >= '2026-02-01' && '2026-02-28' <= '2026-02-31').toBe(true);
  });
});

describe('vista por corte', () => {
  const row = (date: string, chargeMinor: number, planId: string | null = null, creditMinor = 0): SpendRow => ({
    date, descriptionNorm: 'X', chargeMinor, creditMinor, currency: 'MXN', categoryId: null, planId,
  });

  it('el periodo va del día siguiente al corte anterior hasta el corte, cruzando meses', () => {
    const period = statementPeriod(20, 10, '2026-10', '2026-10-09');
    expect(period.open).toBe(true);
    expect(period.dueDate).toBe('2026-11-10');
    expect(period.from).toBe('2026-09-21');
    expect(period.to).toBe('2026-10-20');
  });

  it('la fecha de pago cae en el mes siguiente si su día no es posterior al corte', () => {
    expect(statementPeriod(20, 10, '2026-10', '2026-12-01').dueDate).toBe('2026-11-10');
    expect(statementPeriod(5, 25, '2026-10', '2026-12-01').dueDate).toBe('2026-10-25');
  });

  it('un corte del 31 cae en el último día de meses cortos', () => {
    expect(cutoffInMonth(31, '2026-02')).toBe('2026-02-28');
    expect(statementPeriod(31, null, '2026-03', '2026-12-01').from).toBe('2026-03-01');
  });

  it('el corte vigente es el último ocurrido', () => {
    expect(currentCutoffMonth(20, '2026-10-09')).toBe('2026-09');
    expect(currentCutoffMonth(20, '2026-10-20')).toBe('2026-10');
    expect(currentCutoffMonth(20, '2026-10-09', true)).toBe('2026-10');
  });

  it('suma cargos, planes, gastos y hormiga sin restar abonos', () => {
    const summary = summarizeStatement(
      [row('2026-09-25', 150_000, 'p1'), row('2026-10-02', 30_000, 'p1'), row('2026-10-03', 5_000), row('2026-10-04', 90_000), row('2026-10-05', 0, null, 40_000)],
      20_000,
    );
    expect(summary.chargesMinor).toBe(275_000);
    expect(summary.planChargesMinor).toBe(180_000);
    expect(summary.byPlan).toEqual([{ planId: 'p1', amountMinor: 180_000, count: 2 }]);
    expect(summary.spendMinor).toBe(95_000);
    expect(summary.antMinor).toBe(5_000);
    expect(summary.antCount).toBe(1);
    expect(summary.creditsMinor).toBe(40_000);
    expect(summary.financeMinor).toBe(0);
  });

  it('un corte real manda sobre el día de corte de la tarjeta (4-sep → 2-oct)', () => {
    const records = recordsByMonth([
      { cutoffDate: '2026-09-04', startDate: null, officialPayMinor: null },
      { cutoffDate: '2026-10-02', startDate: null, officialPayMinor: 2_530_572 },
    ]);
    const period = statementPeriod(4, 22, '2026-10', '2026-10-09', records);
    expect(period).toMatchObject({ from: '2026-09-05', to: '2026-10-02', dueDate: '2026-10-22', open: false });
    expect(period.recorded?.officialPayMinor).toBe(2_530_572);
    // Sin registro el mismo mes se estima con el día de la tarjeta.
    expect(statementPeriod(4, 22, '2026-10', '2026-10-09').to).toBe('2026-10-04');
  });

  it('un primer día propio adelanta el inicio del periodo', () => {
    const records = recordsByMonth([{ cutoffDate: '2026-10-02', startDate: '2026-09-03', officialPayMinor: null }]);
    expect(statementPeriod(4, 22, '2026-10', '2026-10-09', records).from).toBe('2026-09-03');
  });

  it('el corte vigente respeta los cortes reales', () => {
    const records = recordsByMonth([{ cutoffDate: '2026-10-12', startDate: null, officialPayMinor: null }]);
    // Hoy 9-oct: el corte real del 12 aún no llega aunque la tarjeta diga día 4.
    expect(currentCutoffMonth(4, '2026-10-09', false, records)).toBe('2026-09');
    expect(currentCutoffMonth(4, '2026-10-09')).toBe('2026-10');
  });
});

describe('validación del corte real', () => {
  const ok = { accountId: 'a1', cutoffDate: '2026-10-02', startDate: '', officialPay: '25,305.72' };

  it('acepta fecha, primer día vacío y monto en formato del locale', () => {
    expect(validateCutoff(ok, 'es-MX', 'MXN')).toEqual({ ok: true, value: { accountId: 'a1', cutoffDate: '2026-10-02', startDate: null, officialPayMinor: 2_530_572 } });
  });

  it('rechaza fechas imposibles, primer día posterior al corte y montos inválidos', () => {
    const result = validateCutoff({ ...ok, cutoffDate: '2026-02-31', startDate: '2026-10-03', officialPay: 'abc' }, 'es-MX', 'MXN');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.map((e) => `${e.field}:${e.code}`)).toEqual(['cutoffDate:invalid_date', 'officialPay:invalid_amount']);
    const range = validateCutoff({ ...ok, startDate: '2026-10-03' }, 'es-MX', 'MXN');
    expect(!range.ok && range.errors[0]).toEqual({ field: 'startDate', code: 'invalid_range' });
  });
});

describe('intereses, IVA y comisiones', () => {
  it('reconoce los renglones financieros del estado de cuenta de Banorte', () => {
    for (const text of ['INTERESES SUJETOS A IVA', 'INTERESES NO SUJETOS A IVA', 'IVA SOBRE INTERESES DB', '16.00 % IVA SOBRE COMISIONES E INTERESES', 'COMISION ANUALIDAD']) {
      expect(isFinanceCharge(text), text).toBe(true);
    }
    for (const text of ['OXXOAMERICAS NORTE MERIDA', 'AUTOZONE 9540 MERIDA', 'PAYPAL *INTERESTING', 'COMISARIATO LA ESQUINA']) {
      expect(isFinanceCharge(text), text).toBe(false);
    }
  });

  it('no cuentan como gasto ni como hormiga, pero sí en el total a pagar', () => {
    const fin = (descriptionNorm: string, chargeMinor: number): SpendRow => ({ date: '2026-09-03', descriptionNorm, chargeMinor, creditMinor: 0, currency: 'MXN', categoryId: null, planId: null });
    const rows = [fin('INTERESES NO SUJETOS A IVA', 401), fin('IVA SOBRE INTERESES DB', 962), fin('OXXO NORTE', 15_800)];
    const summary = summarizeStatement(rows, 20_000);
    expect(summary).toMatchObject({ chargesMinor: 17_163, financeMinor: 1_363, spendMinor: 15_800, antMinor: 15_800, antCount: 1 });
    const month = analyzeMonth(rows, '2026-09', () => 20_000)[0]!;
    expect(month).toMatchObject({ financeMinor: 1_363, spendMinor: 15_800, antCount: 1 });
  });
});

describe('presupuestos por categoría', () => {
  it('estado según lo gastado: ok, aviso desde el 80 % y excedido', () => {
    expect(budgetStatus(5_000, 10_000)).toEqual({ ratio: 0.5, state: 'ok', remainingMinor: 5_000 });
    expect(budgetStatus(8_000, 10_000).state).toBe('warn');
    expect(budgetStatus(10_000, 10_000).state).toBe('warn');
    expect(budgetStatus(10_001, 10_000)).toMatchObject({ state: 'over', remainingMinor: -1 });
    expect(budgetStatus(0, 10_000).state).toBe('ok');
  });

  it('el presupuesto se escribe en el formato del locale; vacío lo quita; ausente no lo toca', () => {
    const money = { locale: 'es-MX', currency: 'MXN' };
    expect(validateCategory({ name: 'Super', color: '', budget: '3,500.50' }, money)).toEqual({ ok: true, value: { name: 'Super', color: null, budgetMinor: 350_050 } });
    expect(validateCategory({ name: 'Super', budget: '  ' }, money)).toEqual({ ok: true, value: { name: 'Super', color: null, budgetMinor: null } });
    expect(validateCategory({ name: 'Super' }, money)).toEqual({ ok: true, value: { name: 'Super', color: null } });
    expect(validateCategory({ name: 'Super' })).toEqual({ ok: true, value: { name: 'Super', color: null } });
  });

  it('rechaza presupuestos que no son un monto positivo', () => {
    const money = { locale: 'es-MX', currency: 'MXN' };
    for (const budget of ['abc', '0', '-5', '1.2.3']) {
      expect(validateCategory({ name: 'Super', budget }, money), budget).toEqual({ ok: false, errors: [{ field: 'budget', code: 'invalid_amount' }] });
    }
    // Sin moneda no se puede interpretar el monto.
    expect(validateCategory({ name: 'Super', budget: '100' }).ok).toBe(false);
  });
});
