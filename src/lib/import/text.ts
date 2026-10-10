export function stripAccents(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '');
}

/** Descripción comparable: sin acentos, mayúsculas, espacios colapsados. */
export function normalizeDescription(value: string): string {
  return stripAccents(value).toUpperCase().replace(/\s+/g, ' ').trim();
}

/** Encabezado comparable: "Núm. de pago" -> "num de pago". */
export function normalizeHeader(value: string): string {
  return stripAccents(value)
    .toLowerCase()
    .replace(/#/g, ' num ')
    .replace(/[.°º]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
