import { parseCsv } from './csv';
import { parseDate } from './dates';
import { normalizeHeader } from './text';
import { DEFAULT_REFERENCE_PATTERN, type DateLocale, type ImportField, type ImportProfile } from './types';

/** Sinónimos de encabezados (ya normalizados) para sugerir el mapeo automáticamente. */
const HEADER_SYNONYMS: Record<ImportField, string[]> = {
  date: ['fecha de la operacion', 'fecha de operacion', 'fecha operacion', 'fecha de compra', 'fecha', 'transaction date', 'date'],
  description: ['concepto', 'descripcion', 'detalle', 'comercio', 'description', 'merchant', 'details'],
  charge: ['cargo', 'cargos', 'debito', 'retiro', 'charge', 'debit'],
  credit: ['abono', 'abonos', 'credito', 'deposito', 'credit', 'payment'],
  amount: ['monto', 'importe', 'amount'],
  reference: ['referencia', 'num de referencia', 'numero de referencia', 'folio', 'reference', 'ref'],
  card: ['tarjeta', 'plastico', 'card', 'cuenta'],
};

const DATE_FORMAT_CANDIDATES = [
  'DD-MMM-YYYY',
  'DD/MMM/YYYY',
  'DD MMM YYYY',
  'D MMM YYYY',
  'YYYY-MM-DD',
  'DD/MM/YYYY',
  'DD-MM-YYYY',
  'DD/MM/YY',
  'MM/DD/YYYY',
];

export function headerFingerprint(headers: string[]): string {
  return headers.map(normalizeHeader).sort().join('|');
}

export function suggestColumnMapping(headers: string[]): Partial<Record<ImportField, string>> {
  const columns: Partial<Record<ImportField, string>> = {};
  const used = new Set<string>();
  for (const field of Object.keys(HEADER_SYNONYMS) as ImportField[]) {
    for (const synonym of HEADER_SYNONYMS[field]) {
      const header = headers.find((h) => !used.has(h) && normalizeHeader(h) === synonym);
      if (header) {
        columns[field] = header;
        used.add(header);
        break;
      }
    }
  }
  // Con cargo/abono separados, una columna "monto" genérica sobra.
  if (columns.charge || columns.credit) delete columns.amount;
  return columns;
}

/** Heurística de decimales: el último separador seguido de exactamente 2 dígitos es el decimal. */
function detectNumberFormat(samples: string[]): Pick<ImportProfile, 'decimalSeparator' | 'thousandsSeparator'> {
  let dotDecimal = 0;
  let commaDecimal = 0;
  for (const sample of samples) {
    const last = Math.max(sample.lastIndexOf('.'), sample.lastIndexOf(','));
    if (last === -1) continue;
    const after = sample.slice(last + 1).replace(/\D/g, '');
    if (after.length === 3) continue; // ambiguo: podría ser separador de miles
    if (sample[last] === '.') dotDecimal++;
    else commaDecimal++;
  }
  return commaDecimal > dotDecimal
    ? { decimalSeparator: ',', thousandsSeparator: '.' }
    : { decimalSeparator: '.', thousandsSeparator: ',' };
}

export interface DetectedProfile {
  profile: ImportProfile;
  /** Otros formatos de fecha que también interpretan todas las muestras (p. ej. DD/MM vs MM/DD). */
  ambiguousDateFormats: string[];
  /** Campos obligatorios sin columna asignada. */
  unmappedRequired: ImportField[];
  /** La referencia viene dentro del concepto y se extraerá de ahí. */
  referenceInDescription: boolean;
}

/** Propone un perfil a partir del contenido del archivo; el usuario lo revisa en el editor. */
export function detectProfile(text: string, locale: DateLocale = 'es'): DetectedProfile {
  const table = parseCsv(text);
  const headers = table[0] ?? [];
  const body = table.slice(1, 41);
  const columns = suggestColumnMapping(headers);
  const column = (field: ImportField) => {
    const index = columns[field] ? headers.indexOf(columns[field]!) : -1;
    return index >= 0 ? body.map((row) => row[index] ?? '').filter((v) => v.trim() !== '') : [];
  };

  const dateSamples = column('date');
  const matching = dateSamples.length
    ? DATE_FORMAT_CANDIDATES.filter((format) => dateSamples.every((s) => parseDate(s, format, locale) !== null))
    : [];

  const amountSamples = [...column('charge'), ...column('credit'), ...column('amount')];

  const referenceRegex = new RegExp(DEFAULT_REFERENCE_PATTERN, 'i');
  const descriptions = column('description');
  const referenceInDescription =
    !columns.reference && descriptions.length > 0 && descriptions.filter((d) => referenceRegex.test(d)).length / descriptions.length >= 0.5;

  const unmappedRequired = (['date', 'description'] as ImportField[]).filter((field) => !columns[field]);
  if (!columns.charge && !columns.credit && !columns.amount) unmappedRequired.push('charge');

  return {
    profile: {
      delimiter: 'auto',
      skipRows: 0,
      dateFormat: matching[0] ?? 'DD/MM/YYYY',
      dateLocale: locale,
      ...detectNumberFormat(amountSamples),
      minorDigits: 2,
      columns,
      amountConvention: 'positive_is_charge',
      referencePattern: referenceInDescription ? DEFAULT_REFERENCE_PATTERN : null,
      referenceLabel: referenceInDescription ? 'Referencia' : null,
      headerFingerprint: headerFingerprint(headers),
    },
    ambiguousDateFormats: matching.slice(1),
    unmappedRequired,
    referenceInDescription,
  };
}
