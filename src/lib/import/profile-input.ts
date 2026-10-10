import type { DateLocale, ImportField, ImportProfile } from './types';

const FIELDS: ImportField[] = ['date', 'description', 'charge', 'credit', 'amount', 'reference', 'card'];
const DELIMITERS = ['auto', ',', ';', '\t'] as const;
const THOUSANDS = [',', '.', ' ', ''] as const;

/**
 * Patrón de referencia a partir de una etiqueta. El usuario nunca escribe la expresión regular:
 * una regex arbitraria ejecutada en el servidor podría colgar un Worker (backtracking catastrófico).
 */
export function referencePatternFromLabel(label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return `${escaped}\\s*[:#]?\\s*([A-Za-z0-9-]+)`;
}

export type ProfileInputError = 'invalid_profile' | 'invalid_date_format' | 'invalid_columns' | 'invalid_reference_label';

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const oneOf = <T extends string | number>(options: readonly T[], value: unknown): T | null => (options as readonly unknown[]).includes(value) ? (value as T) : null;

/** Valida el perfil que llega del navegador y lo reconstruye campo por campo (nada se copia tal cual). */
export function sanitizeProfile(raw: unknown): { ok: true; profile: ImportProfile } | { ok: false; error: ProfileInputError } {
  if (!isObject(raw)) return { ok: false, error: 'invalid_profile' };

  const delimiter = oneOf(DELIMITERS, raw.delimiter);
  const thousandsSeparator = oneOf(THOUSANDS, raw.thousandsSeparator);
  const decimalSeparator = oneOf(['.', ','] as const, raw.decimalSeparator);
  const dateLocale = oneOf(['es', 'en'] as const satisfies readonly DateLocale[], raw.dateLocale);
  const amountConvention = oneOf(['positive_is_charge', 'negative_is_charge'] as const, raw.amountConvention);
  const skipRows = typeof raw.skipRows === 'number' && Number.isInteger(raw.skipRows) && raw.skipRows >= 0 && raw.skipRows <= 20 ? raw.skipRows : null;
  const minorDigits = typeof raw.minorDigits === 'number' && Number.isInteger(raw.minorDigits) && raw.minorDigits >= 0 && raw.minorDigits <= 3 ? raw.minorDigits : null;
  if (!delimiter || thousandsSeparator === null || !decimalSeparator || !dateLocale || !amountConvention || skipRows === null || minorDigits === null) {
    return { ok: false, error: 'invalid_profile' };
  }
  if (thousandsSeparator === decimalSeparator) return { ok: false, error: 'invalid_profile' };

  const dateFormat = typeof raw.dateFormat === 'string' ? raw.dateFormat.trim() : '';
  const hasYear = /YYYY|YY/.test(dateFormat);
  const hasMonth = /MMMM|MMM|MM|M/.test(dateFormat);
  const hasDay = /DD|D/.test(dateFormat);
  if (dateFormat.length > 30 || !/^[A-Za-z0-9 /.\-]+$/.test(dateFormat) || !hasYear || !hasMonth || !hasDay) {
    return { ok: false, error: 'invalid_date_format' };
  }

  const columns: Partial<Record<ImportField, string>> = {};
  if (!isObject(raw.columns)) return { ok: false, error: 'invalid_columns' };
  for (const field of FIELDS) {
    const value = raw.columns[field];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string' || value.length > 120) return { ok: false, error: 'invalid_columns' };
    columns[field] = value;
  }

  let referenceLabel: string | null = null;
  if (typeof raw.referenceLabel === 'string' && raw.referenceLabel.trim() !== '') {
    referenceLabel = raw.referenceLabel.trim().replace(/\s+/g, ' ');
    if (referenceLabel.length > 30 || !/^[\p{L}\p{N} .#-]+$/u.test(referenceLabel)) return { ok: false, error: 'invalid_reference_label' };
  }

  return {
    ok: true,
    profile: {
      delimiter,
      skipRows,
      dateFormat,
      dateLocale,
      decimalSeparator,
      thousandsSeparator,
      minorDigits,
      columns,
      amountConvention,
      referenceLabel,
      referencePattern: referenceLabel ? referencePatternFromLabel(referenceLabel) : null,
      headerFingerprint: typeof raw.headerFingerprint === 'string' && raw.headerFingerprint.length <= 2000 ? raw.headerFingerprint : undefined,
    },
  };
}
