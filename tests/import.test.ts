import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  addMonthsISO,
  dedupeMovements,
  detectProfile,
  extractReference,
  matchPlanInstallments,
  naturalEndDate,
  parseCard,
  parseCsv,
  parseDate,
  parseImport,
  parseInstallment,
  parseMoney,
  planHints,
  remainingBalanceMinor,
  type ImportProfile,
  type PlanLike,
} from '../src/lib/import';

const sample = readFileSync(new URL('./fixtures/movements-sample.csv', import.meta.url), 'utf8');
const money = { decimalSeparator: '.', thousandsSeparator: ',', minorDigits: 2 } as const;

describe('primitivas', () => {
  it('parsea montos a unidades menores sin floats', () => {
    expect(parseMoney('$3,027.00', money)).toBe(302700);
    expect(parseMoney('995.15', money)).toBe(99515);
    expect(parseMoney('0', money)).toBe(0);
    expect(parseMoney('(12.50)', money)).toBe(-1250);
    expect(parseMoney('1.234,56', { decimalSeparator: ',', thousandsSeparator: '.', minorDigits: 2 })).toBe(123456);
    expect(parseMoney('12.345', money)).toBeNull();
    expect(parseMoney('abc', money)).toBeNull();
  });

  it('parsea fechas con distintos formatos y meses en español', () => {
    expect(parseDate('02/10/2026', 'DD/MM/YYYY')).toBe('2026-10-02');
    expect(parseDate('30-JUN-2026', 'DD-MMM-YYYY', 'es')).toBe('2026-06-30');
    expect(parseDate('3 sept 2026', 'D MMM YYYY', 'es')).toBe('2026-09-03');
    expect(parseDate('31/02/2026', 'DD/MM/YYYY')).toBeNull();
    expect(parseDate('30/09/2026', 'MM/DD/YYYY')).toBeNull();
  });

  it('suma meses respetando fin de mes', () => {
    expect(addMonthsISO('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsISO('2026-06-30', 3)).toBe('2026-09-30');
  });

  it('interpreta número de pago y plástico', () => {
    expect(parseInstallment('04/12')).toEqual({ current: 4, total: 12 });
    expect(parseInstallment('13/12')).toBeNull();
    expect(parseCard('Titular ***4172')).toEqual({ last4: '4172', kind: 'primary' });
    expect(parseCard('Adicional ***2455')).toEqual({ last4: '2455', kind: 'additional' });
  });

  it('parsea CSV con BOM, comillas y CRLF', () => {
    const rows = parseCsv('﻿"a","b, c"\r\n"1","dice ""hola"""\r\n\r\n');
    expect(rows).toEqual([
      ['a', 'b, c'],
      ['1', 'dice "hola"'],
    ]);
  });

  it('extrae la referencia del concepto', () => {
    expect(extractReference('GAS SERV   OTHON MX Referencia 7465', 'Referencia\\s*([A-Za-z0-9-]+)')).toEqual({
      description: 'GAS SERV OTHON MX',
      reference: '7465',
    });
    expect(extractReference('SIN REFERENCIA AQUI', 'Ref#\\s*(\\d+)')).toEqual({ description: 'SIN REFERENCIA AQUI', reference: null });
  });
});

describe('perfil detectado para el CSV del portal', () => {
  const detected = detectProfile(sample);

  it('mapea columnas por nombre de encabezado', () => {
    expect(detected.profile.columns).toEqual({
      date: 'Fecha',
      description: 'Concepto',
      charge: 'Cargo',
      credit: 'Abono',
      card: 'Tarjeta',
    });
    expect(detected.unmappedRequired).toEqual([]);
  });

  it('detecta formato de fecha, decimales y referencia dentro del concepto', () => {
    expect(detected.profile.dateFormat).toBe('DD/MM/YYYY');
    expect(detected.ambiguousDateFormats).toEqual([]);
    expect(detected.profile.decimalSeparator).toBe('.');
    expect(detected.referenceInDescription).toBe(true);
  });
});

describe('importación de movimientos', () => {
  const profile = detectProfile(sample).profile;

  it('lee los 105 movimientos sin errores', async () => {
    const result = await parseImport(sample, profile);
    expect(result.errors).toEqual([]);
    expect(result.missingFields).toEqual([]);
    expect(result.headerChanged).toBe(false);
    expect(result.movements).toHaveLength(105);
    expect(result.movements.filter((m) => m.cardKind === 'primary')).toHaveLength(78);
    expect(result.movements.filter((m) => m.cardKind === 'additional')).toHaveLength(27);
  });

  it('separa concepto, referencia, cargo y abono', async () => {
    const { movements } = await parseImport(sample, profile);
    expect(movements[0]).toMatchObject({
      date: '2026-10-02',
      description: 'GAS SERV SAN IDELFONSO OTHON P BLANC MX',
      reference: '74657656275011773788752',
      chargeMinor: 99515,
      creditMinor: 0,
      cardLast4: '4172',
    });
    const payment = movements.find((m) => m.creditMinor > 0)!;
    expect(payment).toMatchObject({ description: 'PAGO BANCA DIGITAL / SUCURSAL GRACIAS.', creditMinor: 2840554, chargeMinor: 0 });
    const tax = movements.find((m) => m.description === 'PAGO DE IMPUESTO FEDERAL')!;
    expect(tax.reference).toBe('VT261480114000010000003');
  });

  it('distingue los dos cobros iguales de EDO YUCSAF por su referencia', async () => {
    const { movements } = await parseImport(sample, profile);
    const edo = movements.filter((m) => m.descriptionNorm.startsWith('EDO YUCSAF'));
    expect(edo).toHaveLength(2);
    expect(new Set(edo.map((m) => m.uniqueKey)).size).toBe(2);
    expect(edo.every((m) => m.occurrence === 1)).toBe(true);
  });

  it('asigna ocurrencia cuando no hay referencia que distinga filas idénticas', async () => {
    const csv = 'Fecha,Concepto,Abono,Cargo,Tarjeta\n01/10/2026,TIENDA,0,10.00,Titular ***1\n01/10/2026,TIENDA,0,10.00,Titular ***1\n';
    const result = await parseImport(csv, { ...profile, referencePattern: null });
    expect(result.movements.map((m) => m.occurrence)).toEqual([1, 2]);
    expect(new Set(result.movements.map((m) => m.uniqueKey)).size).toBe(2);
  });

  it('las llaves son únicas en todo el archivo (incluidas las 4 filas con la misma referencia)', async () => {
    const { movements } = await parseImport(sample, profile);
    expect(new Set(movements.map((m) => m.uniqueKey)).size).toBe(movements.length);
  });

  it('una segunda carga del mismo archivo no crea nada nuevo', async () => {
    const first = await parseImport(sample, profile);
    const again = await parseImport(sample, profile);
    const { fresh, duplicates } = dedupeMovements(again.movements, new Set(first.movements.map((m) => m.uniqueKey)));
    expect(fresh).toHaveLength(0);
    expect(duplicates).toHaveLength(105);
  });

  it('la llave no depende del orden de columnas', async () => {
    const reordered = 'Tarjeta,Cargo,Abono,Concepto,Fecha\nTitular ***4172,995.15,0,GAS SERV SAN IDELFONSO OTHON P BLANC MX Referencia 74657656275011773788752,02/10/2026\n';
    const [movement] = (await parseImport(reordered, profile)).movements;
    const [original] = (await parseImport(sample, profile)).movements;
    expect(movement!.uniqueKey).toBe(original!.uniqueKey);
  });

  it('reporta errores por fila y campos faltantes', async () => {
    const bad = 'Fecha,Concepto,Abono,Cargo,Tarjeta\n31/02/2026,X,0,1,T ***1\n01/10/2026,Y,0,abc,T ***1\n01/10/2026,Z,0,0,T ***1\n';
    const result = await parseImport(bad, profile);
    expect(result.movements).toHaveLength(0);
    expect(result.errors.map((e) => [e.line, e.field])).toEqual([
      [2, 'date'],
      [3, 'charge'],
      [4, 'row'],
    ]);

    const missing = await parseImport('Fecha,Detalle\n01/10/2026,X\n', profile);
    expect(missing.missingFields).toContain('description');
    expect(missing.headerChanged).toBe(true);
  });

  it('soporta una columna de monto con signo y referencia propia', async () => {
    const csv = 'Date;Details;Amount;Ref\n2026-10-01;Cafe;-45,50;A1\n2026-10-02;Refund;20,00;A2\n';
    const custom: ImportProfile = {
      ...profile,
      delimiter: 'auto',
      dateFormat: 'YYYY-MM-DD',
      decimalSeparator: ',',
      thousandsSeparator: '.',
      amountConvention: 'negative_is_charge',
      referencePattern: null,
      columns: { date: 'Date', description: 'Details', amount: 'Amount', reference: 'Ref' },
      headerFingerprint: undefined,
    };
    const { movements, errors } = await parseImport(csv, custom);
    expect(errors).toEqual([]);
    expect(movements.map((m) => [m.chargeMinor, m.creditMinor, m.reference])).toEqual([
      [4550, 0, 'A1'],
      [0, 2000, 'A2'],
    ]);
  });
});

describe('emparejamiento de mensualidades con planes', () => {
  const plan = (p: Partial<PlanLike> & Pick<PlanLike, 'id' | 'matchText' | 'installmentAmountMinor' | 'firstChargeDate'>): PlanLike => ({
    totalInstallments: 12,
    paidInstallments: 0,
    status: 'active',
    ...p,
  });
  const plans: PlanLike[] = [
    plan({ id: 'edo-1', matchText: 'EDO YUCSAF', installmentAmountMinor: 25225, firstChargeDate: '2026-06-30', paidInstallments: 3 }),
    plan({ id: 'edo-2', matchText: 'EDO YUCSAF', installmentAmountMinor: 25225, firstChargeDate: '2026-06-30', paidInstallments: 3 }),
    plan({ id: 'aguila', matchText: 'EL AGUILA CIA SEG', installmentAmountMinor: 90236, firstChargeDate: '2026-07-03', paidInstallments: 2 }),
    plan({ id: 'rumaya', matchText: 'RUMAYA TRAVEL', installmentAmountMinor: 57171, firstChargeDate: '2026-09-08' }),
    plan({ id: 'mapfre', matchText: 'MAPFRE', installmentAmountMinor: 112312, firstChargeDate: '2026-09-08' }),
    plan({ id: 'gym', matchText: 'GIMNASIO', installmentAmountMinor: 50000, firstChargeDate: '2026-08-15', paidInstallments: 1 }),
  ];

  it('empareja cada plan con su cargo, uno a uno, y detecta el faltante', async () => {
    const { movements } = await parseImport(sample, detectProfile(sample).profile);
    const { matches, missing } = matchPlanInstallments(plans, movements, { coverageEnd: '2026-10-02' });

    const byPlan = Object.fromEntries(matches.map((m) => [m.planId, m]));
    expect(Object.keys(byPlan).sort()).toEqual(['aguila', 'edo-1', 'edo-2', 'mapfre', 'rumaya']);
    expect(byPlan['edo-1']!.installmentNo).toBe(4);
    expect(byPlan['edo-1']!.movementKey).not.toBe(byPlan['edo-2']!.movementKey);
    expect(byPlan['aguila']).toMatchObject({ installmentNo: 3, expectedDate: '2026-09-03', daysOffset: 3 });
    expect(byPlan['rumaya']).toMatchObject({ installmentNo: 1, daysOffset: 0 });

    expect(missing).toEqual([{ planId: 'gym', installmentNo: 2, expectedDate: '2026-09-15' }]);
  });

  it('no empareja si el monto difiere o el plan ya terminó', async () => {
    const { movements } = await parseImport(sample, detectProfile(sample).profile);
    const wrongAmount = plan({ id: 'x', matchText: 'MAPFRE', installmentAmountMinor: 100000, firstChargeDate: '2026-09-08' });
    const finished = plan({ id: 'y', matchText: 'MAPFRE', installmentAmountMinor: 112312, firstChargeDate: '2026-09-08', paidInstallments: 12 });
    expect(matchPlanInstallments([wrongAmount, finished], movements).matches).toEqual([]);
  });

  it('marca la última mensualidad como final', () => {
    const last = plan({ id: 'z', matchText: 'TIENDA', installmentAmountMinor: 1000, firstChargeDate: '2026-01-10', totalInstallments: 3, paidInstallments: 2 });
    const movement = { uniqueKey: 'k', date: '2026-03-10', descriptionNorm: 'TIENDA MX', chargeMinor: 1000 };
    expect(matchPlanInstallments([last], [movement]).matches[0]).toMatchObject({ installmentNo: 3, isFinal: true });
  });

  it('calcula fecha natural de liquidación y saldo restante', () => {
    const aguila = plans.find((p) => p.id === 'aguila')!;
    expect(naturalEndDate(aguila)).toBe('2027-06-03');
    expect(remainingBalanceMinor(aguila)).toBe(10 * 90236);
  });
});

describe('pistas para el asistente de primera carga', () => {
  it('detecta cargos que comparten referencia con intereses y conceptos "A MESES"', async () => {
    const { movements } = await parseImport(sample, detectProfile(sample).profile);
    const hints = planHints(movements);
    const autozone = movements.find((m) => m.descriptionNorm.startsWith('AUTOZONE'))!;
    expect(hints.get(autozone.uniqueKey)).toEqual(['shares_reference_with_interest']);
    const amazonMeses = movements.filter((m) => m.descriptionNorm === 'AMAZON A MESES CIUDAD DE MEX MX');
    expect(amazonMeses.length).toBeGreaterThan(0);
    expect(amazonMeses.every((m) => hints.get(m.uniqueKey)?.includes('installments_in_description'))).toBe(true);
    const interest = movements.find((m) => m.descriptionNorm === 'INTERESES SUJETOS A IVA')!;
    expect(hints.has(interest.uniqueKey)).toBe(false);
  });
});
