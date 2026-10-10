import { normalizeDescription } from '../import/text';

export interface Rule {
  categoryId: string;
  /** Texto normalizado (mayúsculas, sin acentos) que debe estar contenido en el concepto. */
  pattern: string;
}

/** Los patrones se guardan normalizados, igual que el concepto de los movimientos. */
export const normalizePattern = (raw: string): string => normalizeDescription(raw);

/**
 * Categoría de un movimiento según las reglas. Solo subcadenas, nunca expresiones regulares.
 * Gana el patrón más largo (el más específico); a igual longitud, el alfabéticamente menor, para que
 * el resultado sea siempre el mismo.
 */
export function matchCategory(descriptionNorm: string, rules: readonly Rule[]): string | null {
  let best: Rule | null = null;
  for (const rule of rules) {
    if (!rule.pattern || !descriptionNorm.includes(rule.pattern)) continue;
    if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.pattern < best.pattern)) {
      best = rule;
    }
  }
  return best?.categoryId ?? null;
}

/** Prefijos de procesadores de pago: lo que importa es el comercio que viene después del asterisco. */
const PROCESSOR_PREFIX = /^(?:PAY ?PAL|MERPAGO|MERCADO ?PAGO|BPK|SMARTPY|STRIPE|CLIP|SQ|TST)\s*\*\s*/;

/**
 * Clave de comercio de un concepto normalizado: la primera palabra, o las dos primeras si la primera
 * es muy corta ("EL AGUILA", "T1 TELCEL"). Sirve para sugerir el texto de una regla y para agrupar.
 */
export function merchantKey(descriptionNorm: string): string {
  const cleaned = descriptionNorm.replace(PROCESSOR_PREFIX, '').replace(/\s+MX$/, '').trim();
  const [first, second] = cleaned.split(/\s+/);
  if (!first) return descriptionNorm;
  return first.length < 4 && second ? `${first} ${second}` : first;
}

/**
 * Junta variantes de un mismo comercio: una clave de una sola palabra (≥ 4 letras) absorbe a las que
 * empiezan con ella (OXXO ← OXXOAMERICAS, OXXOLA, OXXOBOREAS). Devuelve clave → grupo.
 */
export function mergeMerchantKeys(keys: Iterable<string>): Map<string, string> {
  const sorted = [...new Set(keys)].sort((a, b) => a.length - b.length || a.localeCompare(b));
  const groups: string[] = [];
  const grouped = new Map<string, string>();
  for (const key of sorted) {
    const parent = groups.find((group) => group.length >= 4 && !group.includes(' ') && key.startsWith(group));
    if (parent) grouped.set(key, parent);
    else {
      groups.push(key);
      grouped.set(key, key);
    }
  }
  return grouped;
}
