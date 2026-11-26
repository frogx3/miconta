import { describe, expect, it } from 'vitest';
import { buildCutSections, dashboardMonths, lineUsage, selectMonth, type DashboardAccount } from '../src/lib/dashboard/build';
import type { SpendRow } from '../src/lib/spending/analysis';
import type { RealCut } from '../src/lib/spending/statement';

const cut = (month: string, officialPayMinor: number | null = null): RealCut => ({
  month,
  cutoff: `${month}-04`,
  from: `${month}-01`,
  to: `${month}-04`,
  dueDate: `${month}-24`,
  recorded: { cutoffDate: `${month}-04`, startDate: null, officialPayMinor },
});

const row = (chargeMinor: number, extra: Partial<SpendRow> = {}): SpendRow => ({
  date: '2026-11-02',
  descriptionNorm: 'OXXO',
  chargeMinor,
  creditMinor: 0,
  currency: 'MXN',
  categoryId: null,
  planId: null,
  ...extra,
});

const account = (id: string, cuts: RealCut[], rows: Record<string, SpendRow[]>, extra: Partial<DashboardAccount> = {}): DashboardAccount => ({
  accountId: id,
  accountName: id,
  last4: '1234',
  tone: 'navy',
  creditLimitMinor: null,
  currency: 'MXN',
  cutoffDay: 4,
  paymentDueDay: 24,
  cuts,
  rowsByMonth: new Map(Object.entries(rows)),
  openRows: [],
  plansRemainingMinor: 0,
  ...extra,
});

describe('meses de corte de la portada', () => {
  it('une los cortes de todas las cuentas y elige el pedido o el más reciente', () => {
    const months = dashboardMonths([{ cuts: [cut('2026-09'), cut('2026-11')] }, { cuts: [cut('2026-10'), cut('2026-11')] }]);
    expect(months).toEqual(['2026-09', '2026-10', '2026-11']);
    expect(selectMonth(months, null)).toEqual({ month: '2026-11', prev: '2026-10', next: null, window: ['2026-09', '2026-10', '2026-11'] });
    expect(selectMonth(months, '2026-10')).toMatchObject({ month: '2026-10', prev: '2026-09', next: '2026-11', window: ['2026-09', '2026-10'] });
    expect(selectMonth(months, '2030-01').month).toBe('2026-11');
    expect(selectMonth([], null)).toEqual({ month: null, prev: null, next: null, window: [] });
  });

  it('la ventana es de máximo 6 cortes', () => {
    const months = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];
    expect(selectMonth(months, '2026-08').window).toEqual(months.slice(2));
  });
});

describe('secciones del corte', () => {
  const groceries = 'cat-super';
  const a = account('Banorte', [cut('2026-10'), cut('2026-11', 1_500_00)], {
    '2026-10': [row(400_00, { categoryId: groceries }), row(50_00)],
    '2026-11': [row(1_000_00, { planId: 'p1' }), row(600_00, { categoryId: groceries }), row(80_00), row(30_00, { descriptionNorm: 'INTERESES' })],
  });
  const b = account('Nu', [cut('2026-11')], { '2026-11': [row(200_00, { categoryId: groceries }), row(45_00)] }, { tone: 'gold' });
  const selection = selectMonth(dashboardMonths([a, b]), null);
  const sections = buildCutSections([a, b], selection, 'MXN', 100_00)!;

  it('usa el pago del estado de cuenta si se capturó y si no lo estima', () => {
    expect(sections.cards).toEqual([
      { accountId: 'Banorte', accountName: 'Banorte', last4: '1234', tone: 'navy', dueDate: '2026-11-24', payMinor: 1_500_00, basis: 'official', planChargesMinor: 1_000_00 },
      { accountId: 'Nu', accountName: 'Nu', last4: '1234', tone: 'gold', dueDate: '2026-11-24', payMinor: 245_00, basis: 'estimate', planChargesMinor: 0 },
    ]);
    expect(sections.payTotalMinor).toBe(1_745_00);
  });

  it('suma el gasto de todas las cuentas y lo compara con el promedio de la ventana', () => {
    // Noviembre: súper 600 + 200; sin categoría 80 + 45. Octubre: súper 400, sin categoría 50.
    expect(sections.spendMinor).toBe(925_00);
    expect(sections.categories).toEqual([
      { categoryId: groceries, amountMinor: 800_00, averageMinor: 600_00 },
      { categoryId: null, amountMinor: 125_00, averageMinor: 87_50 },
    ]);
  });

  it('el historial separa mensualidades, compras y hormiga; los intereses no son gasto', () => {
    expect(sections.history).toEqual([
      { month: '2026-10', planMinor: 0, purchasesMinor: 400_00, antMinor: 50_00 },
      { month: '2026-11', planMinor: 1_000_00, purchasesMinor: 800_00, antMinor: 125_00 },
    ]);
    expect(sections.ant).toMatchObject({ amountMinor: 125_00, count: 2, yearlyMinor: 1_500_00 });
  });

  it('sin cortes no hay secciones', () => {
    expect(buildCutSections([], selectMonth([], null), 'MXN', 100_00)).toBeNull();
  });
});

describe('uso de línea', () => {
  it('suma saldo de planes y cargos del corte en curso que no son mensualidades; omite cuentas sin límite', () => {
    const usage = lineUsage([
      account('Banorte', [], {}, { creditLimitMinor: 10_000_00, plansRemainingMinor: 3_000_00, openRows: [row(500_00), row(700_00, { planId: 'p1' }), row(0, { creditMinor: 900_00 })] }),
      account('Nu', [], {}, { creditLimitMinor: 1_000_00, plansRemainingMinor: 900_00 }),
      account('Sin límite', [], {}, { plansRemainingMinor: 5_000_00 }),
    ]);
    expect(usage.map((line) => [line.accountName, line.plansMinor, line.openChargesMinor, line.share])).toEqual([
      ['Nu', 900_00, 0, 0.9],
      ['Banorte', 3_000_00, 500_00, 0.35],
    ]);
  });
});
