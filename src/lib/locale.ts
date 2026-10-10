export const SUPPORTED_LOCALES = ['es-MX', 'es', 'en'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'es-MX';

/** Moneda por defecto según la región del locale. Cada cuenta puede definir la suya. */
const CURRENCY_BY_REGION: Record<string, string> = {
  MX: 'MXN',
  US: 'USD',
  CA: 'CAD',
  GB: 'GBP',
  ES: 'EUR',
  FR: 'EUR',
  DE: 'EUR',
  IT: 'EUR',
  PT: 'EUR',
  AR: 'ARS',
  CL: 'CLP',
  CO: 'COP',
  PE: 'PEN',
  UY: 'UYU',
  BR: 'BRL',
  CR: 'CRC',
  GT: 'GTQ',
  DO: 'DOP',
  PA: 'PAB',
};

export function defaultCurrencyForLocale(locale: string): string {
  const region = locale.split('-')[1]?.toUpperCase();
  return (region && CURRENCY_BY_REGION[region]) || 'USD';
}

export function isSupportedLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/** Elige el mejor locale soportado a partir de `Accept-Language`; cae en es-MX. */
export function resolveLocale(acceptLanguage: string | null | undefined): Locale {
  const requested = (acceptLanguage ?? '')
    .split(',')
    .map((part) => part.split(';')[0]!.trim())
    .filter(Boolean);
  for (const tag of requested) {
    if (isSupportedLocale(tag)) return tag;
    const language = tag.split('-')[0]!.toLowerCase();
    if (language === 'es') return tag.toLowerCase() === 'es-mx' ? 'es-MX' : 'es';
    if (language === 'en') return 'en';
  }
  return DEFAULT_LOCALE;
}
