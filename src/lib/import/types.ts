export type ImportField =
  | 'date'
  | 'description'
  | 'charge'
  | 'credit' // "Abono": pagos a la tarjeta y devoluciones
  | 'amount' // alternativa: una sola columna con signo
  | 'reference'
  | 'card'; // tarjeta (terminación): "Titular ***4172"

export type DateLocale = 'es' | 'en';

/** Referencia al estilo "Referencia 74657656275011773788752" dentro del concepto. */
export const DEFAULT_REFERENCE_PATTERN = 'Referencia\\s*[:#]?\\s*([A-Za-z0-9-]+)';

/**
 * Perfil de importación de una tarjeta: describe cómo leer el CSV de su banco.
 * `columns` mapea campo del sistema -> encabezado del CSV; la búsqueda es por
 * nombre de encabezado (normalizado), nunca por posición.
 */
export interface ImportProfile {
  delimiter: 'auto' | ',' | ';' | '\t';
  /** Filas a omitir antes del encabezado. */
  skipRows: number;
  /** Tokens: YYYY YY MMMM MMM MM M DD D. Ej: "DD/MM/YYYY". */
  dateFormat: string;
  dateLocale: DateLocale;
  decimalSeparator: '.' | ',';
  thousandsSeparator: ',' | '.' | ' ' | '';
  /** Decimales de la moneda (2 para MXN/USD, 0 para JPY). */
  minorDigits: number;
  columns: Partial<Record<ImportField, string>>;
  /** Con columna `amount` única: qué signo representa un cargo. */
  amountConvention: 'positive_is_charge' | 'negative_is_charge';
  /**
   * Si no hay columna `reference`, se extrae del concepto con esta expresión regular
   * (el primer grupo de captura es la referencia). `null` desactiva la extracción.
   */
  referencePattern: string | null;
  /** Etiqueta que antecede a la referencia en el concepto ("Referencia", "Folio"); de ella sale `referencePattern`. */
  referenceLabel?: string | null;
  /** Encabezados normalizados y ordenados; detecta cambios de formato del banco. */
  headerFingerprint?: string;
}

export type CardKind = 'primary' | 'additional';

/** Un movimiento ya interpretado y normalizado, listo para deduplicar y guardar. */
export interface NormalizedMovement {
  /** Línea en el archivo (1-based), para mensajes de error y vista previa. */
  line: number;
  date: string; // ISO YYYY-MM-DD
  /** Concepto limpio, sin la referencia. */
  description: string;
  descriptionNorm: string;
  reference: string | null;
  chargeMinor: number;
  creditMinor: number;
  cardLast4: string | null;
  cardKind: CardKind | null;
  /** Hash de tarjeta + fecha + concepto + referencia + cargo + abono. */
  baseHash: string;
  /** Posición entre filas idénticas del mismo archivo (1, 2, ...). */
  occurrence: number;
  /** `${baseHash}#${occurrence}`: único por tarjeta/cuenta. */
  uniqueKey: string;
}

export interface RowError {
  line: number;
  field: ImportField | 'row';
  message: string;
  raw?: string;
}

export type PlanType = 'msi' | 'mci' | 'fixed';
export type PlanStatus = 'active' | 'completed_natural' | 'settled_manual' | 'review';
