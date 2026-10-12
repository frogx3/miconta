/** Fecha de calendario (ISO `YYYY-MM-DD`) en el formato del locale. Sin zona horaria: es un día, no un instante. */
export function formatDate(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
}

/** `YYYY-MM` como "oct 2026" según el locale. */
export function formatMonth(month: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`));
}

/** Mes con su nombre completo y el año, sin preposiciones ("Octubre 2026"), con la inicial en mayúscula. */
export function formatMonthLong(month: string, locale: string): string {
  const date = new Date(`${month}-01T00:00:00Z`);
  const name = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' }).format(date);
  return `${name.charAt(0).toLocaleUpperCase(locale)}${name.slice(1)} ${month.slice(0, 4)}`;
}

/** Puntos base a porcentaje legible: 2450 → "24.5%". */
export function formatRate(bp: number, locale: string): string {
  return `${new Intl.NumberFormat(locale, { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(bp / 100)}%`;
}

/** Hoy en ISO (UTC), para los cálculos de calendario del servidor. */
export const todayISO = (): string => new Date().toISOString().slice(0, 10);
