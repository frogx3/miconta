/**
 * Niveles de membresía y qué incluye cada uno (docs/plan-de-actualizacion.md §2). El código pregunta por una
 * función (`hasFeature(tier, 'mcp')`), nunca por el nivel: así cambiar qué incluye cada nivel es editar este mapa.
 * Los límites del nivel Estándar y el cobro llegan en la Fase 4; hoy todos los espacios son Profesional.
 */
export const TIERS = ['standard', 'professional', 'premium'] as const;
export type Tier = (typeof TIERS)[number];

export type Feature = 'pdf_statements' | 'api' | 'mcp' | 'purchase_connectors' | 'ai';

const FEATURES: Record<Tier, readonly Feature[]> = {
  standard: [],
  professional: ['pdf_statements', 'api', 'mcp', 'purchase_connectors'],
  premium: ['pdf_statements', 'api', 'mcp', 'purchase_connectors', 'ai'],
};

export const hasFeature = (tier: Tier, feature: Feature): boolean => FEATURES[tier].includes(feature);
