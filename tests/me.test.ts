import { describe, expect, it } from 'vitest';
import { csvRow, decimal } from '../src/lib/me/backup';
import { duePayables } from '../src/lib/agenda/month';
import type { Entry } from '../src/lib/agenda/compute';
import { isPermanent, NO_EXPIRY } from '../src/lib/members/roles';

describe('respaldo CSV', () => {
  it('escribe montos en decimal según la moneda', () => {
    expect(decimal(123456, 'MXN')).toBe('1234.56');
    expect(decimal(5, 'MXN')).toBe('0.05');
    expect(decimal(-250, 'USD')).toBe('-2.50');
    expect(decimal(1500, 'JPY')).toBe('1500');
  });

  it('escapa comillas, comas y saltos, y neutraliza fórmulas', () => {
    expect(csvRow(['a', 'b,c', 'di "x"', null, 3])).toBe('a,"b,c","di ""x""",,3');
    expect(csvRow(['=HYPERLINK("x")', '+1', '@SUM', '-2', 'línea\nnueva'])).toBe(`"'=HYPERLINK(""x"")",'+1,'@SUM,'-2,"línea\nnueva"`);
    // Los números (montos) no llevan apóstrofo aunque sean negativos.
    expect(csvRow([-2])).toBe('-2');
  });
});

describe('avisos del día', () => {
  const entry = (over: Partial<Entry>): Entry => ({ key: 'k', kind: 'payable', description: 'Luz', amountMinor: 100, currency: 'MXN', dueDate: '2026-11-06', status: 'pending', suggested: false, ...over });

  it('separa lo de hoy y lo vencido; ignora cobros, hechos y proyecciones', () => {
    const due = duePayables(
      [
        entry({ key: 'hoy' }),
        entry({ key: 'vencido-2', dueDate: '2026-11-03' }),
        entry({ key: 'vencido-1', dueDate: '2026-10-30' }),
        entry({ key: 'cobro', kind: 'receivable' }),
        entry({ key: 'hecho', status: 'done' }),
        entry({ key: 'proyectado', projected: true }),
        entry({ key: 'futuro', dueDate: '2026-11-07' }),
      ],
      '2026-11-06',
    );
    expect(due.today.map((e) => e.key)).toEqual(['hoy']);
    expect(due.overdue.map((e) => e.key)).toEqual(['vencido-1', 'vencido-2']);
  });
});

describe('invitación permanente', () => {
  it('se reconoce por su vencimiento lejano', () => {
    expect(isPermanent(NO_EXPIRY)).toBe(true);
    expect(isPermanent(new Date(Date.now() + 30 * 86_400_000))).toBe(false);
  });
});
