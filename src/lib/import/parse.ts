import { parseCsv } from './csv';
import { parseDate } from './dates';
import { parseMoney } from './money';
import { headerFingerprint } from './profile';
import { normalizeDescription, normalizeHeader } from './text';
import type { CardKind, ImportField, ImportProfile, NormalizedMovement, RowError } from './types';

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Separa la referencia del concepto. Devuelve el concepto limpio y la referencia (o null). */
export function extractReference(description: string, pattern: string): { description: string; reference: string | null } {
  const collapse = (value: string) => value.replace(/\s+/g, ' ').trim();
  const match = new RegExp(pattern, 'i').exec(description);
  if (!match) return { description: collapse(description), reference: null };
  const reference = (match[1] ?? match[0]).trim();
  const cleaned = collapse(`${description.slice(0, match.index)} ${description.slice(match.index + match[0].length)}`);
  return { description: cleaned, reference: reference || null };
}

/** "Titular ***4172" -> { last4: "4172", kind: "primary" } */
export function parseCard(raw: string): { last4: string; kind: CardKind | null } | null {
  const digits = /(\d{4})\D*$/.exec(raw.trim());
  if (!digits) return null;
  const kind: CardKind | null = /adicional|additional/i.test(raw)
    ? 'additional'
    : /titular|principal|primary|holder/i.test(raw)
      ? 'primary'
      : null;
  return { last4: digits[1]!, kind };
}

export interface ParseResult {
  movements: NormalizedMovement[];
  errors: RowError[];
  /** Campos mapeados cuyo encabezado no existe en el archivo, o campos obligatorios sin mapear. */
  missingFields: ImportField[];
  /** Los encabezados del archivo ya no coinciden con los que tenía el perfil al guardarse. */
  headerChanged: boolean;
}

export async function parseImport(text: string, profile: ImportProfile): Promise<ParseResult> {
  const table = parseCsv(text, profile.delimiter).slice(profile.skipRows);
  const headers = table[0] ?? [];
  const body = table.slice(1);
  const result: ParseResult = {
    movements: [],
    errors: [],
    missingFields: [],
    headerChanged: !!profile.headerFingerprint && profile.headerFingerprint !== headerFingerprint(headers),
  };

  const indexByHeader = new Map<string, number>();
  headers.forEach((header, index) => {
    const key = normalizeHeader(header);
    if (!indexByHeader.has(key)) indexByHeader.set(key, index);
  });
  const indexOf = (field: ImportField): number => {
    const header = profile.columns[field];
    return header === undefined ? -1 : (indexByHeader.get(normalizeHeader(header)) ?? -1);
  };

  const idx = Object.fromEntries(
    (['date', 'description', 'charge', 'credit', 'amount', 'reference', 'card'] as ImportField[]).map((f) => [f, indexOf(f)]),
  ) as Record<ImportField, number>;

  for (const [field, header] of Object.entries(profile.columns) as [ImportField, string][]) {
    if (header && idx[field] === -1) result.missingFields.push(field);
  }
  if (idx.date === -1 && !result.missingFields.includes('date')) result.missingFields.push('date');
  if (idx.description === -1 && !result.missingFields.includes('description')) result.missingFields.push('description');
  if (idx.charge === -1 && idx.credit === -1 && idx.amount === -1 && !result.missingFields.includes('charge')) {
    result.missingFields.push('charge');
  }
  if (result.missingFields.length > 0) return result;

  const numberFormat = {
    decimalSeparator: profile.decimalSeparator,
    thousandsSeparator: profile.thousandsSeparator,
    minorDigits: profile.minorDigits,
  };
  const referenceField = idx.reference !== -1;

  const parsed: Omit<NormalizedMovement, 'baseHash' | 'occurrence' | 'uniqueKey'>[] = [];
  body.forEach((cells, rowIndex) => {
    const line = profile.skipRows + rowIndex + 2;
    const cell = (field: ImportField) => (idx[field] === -1 ? '' : (cells[idx[field]] ?? '').trim());
    const fail = (field: RowError['field'], message: string, raw?: string) => result.errors.push({ line, field, message, raw });

    const date = parseDate(cell('date'), profile.dateFormat, profile.dateLocale);
    if (!date) return fail('date', `Fecha inválida para el formato ${profile.dateFormat}`, cell('date'));

    const rawDescription = cell('description');
    if (!rawDescription) return fail('description', 'Concepto vacío');

    let chargeMinor = 0;
    let creditMinor = 0;
    if (idx.amount !== -1 && idx.charge === -1 && idx.credit === -1) {
      const amount = parseMoney(cell('amount'), numberFormat);
      if (amount === null) return fail('amount', 'Monto inválido', cell('amount'));
      const isCharge = profile.amountConvention === 'positive_is_charge' ? amount >= 0 : amount <= 0;
      if (isCharge) chargeMinor = Math.abs(amount);
      else creditMinor = Math.abs(amount);
    } else {
      const charge = idx.charge === -1 || cell('charge') === '' ? 0 : parseMoney(cell('charge'), numberFormat);
      const credit = idx.credit === -1 || cell('credit') === '' ? 0 : parseMoney(cell('credit'), numberFormat);
      if (charge === null) return fail('charge', 'Cargo inválido', cell('charge'));
      if (credit === null) return fail('credit', 'Abono inválido', cell('credit'));
      // Un cargo negativo es un abono, y viceversa.
      chargeMinor = Math.max(charge, 0) + Math.max(-credit, 0);
      creditMinor = Math.max(credit, 0) + Math.max(-charge, 0);
    }
    if (chargeMinor === 0 && creditMinor === 0) return fail('row', 'Movimiento sin monto');
    if (chargeMinor > 0 && creditMinor > 0) return fail('row', 'Cargo y abono en la misma fila');

    let description = rawDescription.replace(/\s+/g, ' ').trim();
    let reference: string | null = null;
    if (referenceField) {
      reference = cell('reference') || null;
    } else if (profile.referencePattern) {
      try {
        ({ description, reference } = extractReference(rawDescription, profile.referencePattern));
      } catch {
        return fail('row', 'Patrón de referencia inválido');
      }
    }

    const card = idx.card === -1 ? null : parseCard(cell('card'));
    parsed.push({
      line,
      date,
      description,
      descriptionNorm: normalizeDescription(description),
      reference,
      chargeMinor,
      creditMinor,
      cardLast4: card?.last4 ?? null,
      cardKind: card?.kind ?? null,
    });
  });

  const seen = new Map<string, number>();
  for (const movement of parsed) {
    const canonical = [
      movement.cardLast4 ?? '',
      movement.date,
      movement.descriptionNorm,
      movement.reference ?? '',
      movement.chargeMinor,
      movement.creditMinor,
    ].join('|');
    const baseHash = await sha256Hex(canonical);
    const occurrence = (seen.get(baseHash) ?? 0) + 1;
    seen.set(baseHash, occurrence);
    result.movements.push({ ...movement, baseHash, occurrence, uniqueKey: `${baseHash}#${occurrence}` });
  }
  return result;
}

/** Separa los movimientos ya guardados (por llave) de los nuevos; sirve para cargas con rangos traslapados. */
export function dedupeMovements<T extends Pick<NormalizedMovement, 'uniqueKey'>>(
  incoming: T[],
  existingKeys: ReadonlySet<string>,
): { fresh: T[]; duplicates: T[] } {
  const fresh: T[] = [];
  const duplicates: T[] = [];
  for (const movement of incoming) (existingKeys.has(movement.uniqueKey) ? duplicates : fresh).push(movement);
  return { fresh, duplicates };
}
