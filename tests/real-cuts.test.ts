import { describe, expect, it } from 'vitest';
import { dueDateFor, realCuts, sinceLastCut, type RecordedCutoff } from '../src/lib/spending/statement';

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
