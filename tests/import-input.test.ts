import { describe, expect, it } from 'vitest';
import { lastCutoffDate } from '../src/lib/cutoff';
import { detectProfile, parseImport } from '../src/lib/import';
import { referencePatternFromLabel, sanitizeProfile } from '../src/lib/import/profile-input';
import { validatePlanDraft } from '../src/lib/plans/validation';

const goodProfile = {
  delimiter: 'auto',
  skipRows: 0,
  dateFormat: 'DD/MM/YYYY',
  dateLocale: 'es',
  decimalSeparator: '.',
  thousandsSeparator: ',',
  minorDigits: 2,
  columns: { date: 'Fecha', description: 'Concepto', charge: 'Cargo', credit: 'Abono', card: 'Tarjeta' },
  amountConvention: 'positive_is_charge',
  referenceLabel: 'Referencia',
};

describe('perfil recibido del navegador', () => {
  it('lo reconstruye y deriva el patrón de referencia de la etiqueta', () => {
    const result = sanitizeProfile(goodProfile);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.profile.referencePattern).toBe(referencePatternFromLabel('Referencia'));
      expect(result.profile.columns.charge).toBe('Cargo');
    }
  });

  it('ignora cualquier patrón regex enviado por el cliente', () => {
    const result = sanitizeProfile({ ...goodProfile, referenceLabel: null, referencePattern: '(a+)+$' });
    expect(result.ok && result.profile.referencePattern).toBeNull();
  });

  it('el patrón generado extrae la referencia del concepto', async () => {
    const detected = detectProfile('Fecha,Concepto,Abono,Cargo,Tarjeta\n01/10/2026,TIENDA MX Folio AB-12,0,10.00,Titular ***1\n');
    const sanitized = sanitizeProfile({ ...detected.profile, referenceLabel: 'Folio' });
    expect(sanitized.ok).toBe(true);
    if (sanitized.ok) {
      const { movements } = await parseImport('Fecha,Concepto,Abono,Cargo,Tarjeta\n01/10/2026,TIENDA MX Folio AB-12,0,10.00,Titular ***1\n', sanitized.profile);
      expect(movements[0]).toMatchObject({ description: 'TIENDA MX', reference: 'AB-12' });
    }
  });

  it('escapa caracteres especiales de la etiqueta', () => {
    expect(new RegExp(referencePatternFromLabel('N° Ref.'), 'i').exec('X N° Ref. 99')?.[1]).toBe('99');
    expect(new RegExp(referencePatternFromLabel('a+b'), 'i').test('aab 5')).toBe(false);
  });

  it('rechaza valores fuera de rango o mal formados', () => {
    expect(sanitizeProfile(null)).toEqual({ ok: false, error: 'invalid_profile' });
    expect(sanitizeProfile({ ...goodProfile, delimiter: '|' })).toEqual({ ok: false, error: 'invalid_profile' });
    expect(sanitizeProfile({ ...goodProfile, skipRows: 99 })).toEqual({ ok: false, error: 'invalid_profile' });
    expect(sanitizeProfile({ ...goodProfile, decimalSeparator: '.', thousandsSeparator: '.' })).toEqual({ ok: false, error: 'invalid_profile' });
    expect(sanitizeProfile({ ...goodProfile, dateFormat: 'DD/MM' })).toEqual({ ok: false, error: 'invalid_date_format' });
    expect(sanitizeProfile({ ...goodProfile, dateFormat: 'DD/MM/YYYY;' })).toEqual({ ok: false, error: 'invalid_date_format' });
    expect(sanitizeProfile({ ...goodProfile, columns: 'x' })).toEqual({ ok: false, error: 'invalid_columns' });
    expect(sanitizeProfile({ ...goodProfile, referenceLabel: '(a+)+' })).toEqual({ ok: false, error: 'invalid_reference_label' });
  });
});

describe('sugerencia del último corte', () => {
  it('toma el corte de este mes si ya pasó, o el del mes anterior si no', () => {
    expect(lastCutoffDate(5, '2026-10-08')).toBe('2026-10-05');
    expect(lastCutoffDate(15, '2026-10-08')).toBe('2026-09-15');
    expect(lastCutoffDate(8, '2026-10-08')).toBe('2026-10-08');
    expect(lastCutoffDate(20, '2026-01-10')).toBe('2025-12-20');
  });

  it('ajusta al último día de meses cortos', () => {
    expect(lastCutoffDate(31, '2026-03-01')).toBe('2026-02-28');
    expect(lastCutoffDate(31, '2026-03-31')).toBe('2026-03-31');
  });
});

describe('validación de planes', () => {
  const ctx = { locale: 'es-MX', currency: 'MXN', movementDate: '2026-09-30' };
  const base = { movementKey: 'k#1', type: 'msi', name: 'Impuesto vehicular', matchText: 'EDO YUCSAF', installmentAmount: '252.25', totalInstallments: '12', currentInstallment: '4' };

  it('calcula total, tasa 0 para MSI y la fecha del primer cargo', () => {
    expect(validatePlanDraft(base, ctx)).toEqual({
      ok: true,
      value: {
        movementKey: 'k#1',
        type: 'msi',
        name: 'Impuesto vehicular',
        matchText: 'EDO YUCSAF',
        installmentAmountMinor: 25_225,
        totalInstallments: 12,
        currentInstallment: 4,
        totalAmountMinor: 25_225 * 12,
        interestRateBp: 0,
        firstChargeDate: '2026-06-30',
      },
    });
  });

  it('respeta el total indicado y lee la tasa en meses con intereses', () => {
    const result = validatePlanDraft({ ...base, type: 'mci', totalAmount: '3,027.00', interestRate: '24.5' }, ctx);
    expect(result).toMatchObject({ ok: true, value: { totalAmountMinor: 302_700, interestRateBp: 2450 } });
  });

  it('para MSI ignora la tasa enviada', () => {
    expect(validatePlanDraft({ ...base, interestRate: '30' }, ctx)).toMatchObject({ ok: true, value: { interestRateBp: 0 } });
  });

  it('la fecha del primer cargo respeta fin de mes', () => {
    const result = validatePlanDraft({ ...base, currentInstallment: '2' }, { ...ctx, movementDate: '2026-03-31' });
    expect(result).toMatchObject({ ok: true, value: { firstChargeDate: '2026-02-28' } });
  });

  it('reporta errores por campo', () => {
    const result = validatePlanDraft({ type: 'x', name: '', matchText: '', installmentAmount: '0', totalInstallments: '1', currentInstallment: '' }, ctx);
    expect(result).toEqual({
      ok: false,
      errors: [
        { field: 'type', code: 'invalid_kind' },
        { field: 'name', code: 'required' },
        { field: 'matchText', code: 'required' },
        { field: 'installmentAmount', code: 'invalid_amount' },
        { field: 'currentInstallment', code: 'required' },
        { field: 'totalInstallments', code: 'invalid_installments' },
      ],
    });
  });

  it('el pago actual no puede superar el plazo', () => {
    expect(validatePlanDraft({ ...base, currentInstallment: '13' }, ctx)).toEqual({
      ok: false,
      errors: [{ field: 'currentInstallment', code: 'current_exceeds_total' }],
    });
  });
});
