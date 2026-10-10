import { and, asc, eq, sql } from 'drizzle-orm';
import { planTags, plans, tags } from '../../db/schema';
import type { Db } from '../auth/hooks';

/**
 * Etiquetas libres para planes ("casa", "viaje", "de Ana"). Son del espacio: se crean al usarlas por primera vez
 * (no hay un catálogo previo) y desaparecen cuando ningún plan las usa. Son clasificación, no un parámetro de la
 * deuda, por eso no generan eventos en el historial del plan.
 */

export const MAX_TAG_LENGTH = 30;
export const MAX_TAGS_PER_PLAN = 10;
export const MAX_TAGS_PER_WORKSPACE = 100;

export interface Tag {
  id: string;
  name: string;
}

export type TagNameResult = { ok: true; name: string } | { ok: false; code: 'required' | 'too_long' };

/** Espacios colapsados, sin extremos; se conserva cómo la escribió la persona. */
export function validateTagName(raw: unknown): TagNameResult {
  const name = (typeof raw === 'string' ? raw : '').replace(/\s+/g, ' ').trim();
  if (!name) return { ok: false, code: 'required' };
  if (name.length > MAX_TAG_LENGTH) return { ok: false, code: 'too_long' };
  return { ok: true, name };
}

/** "Casa" y "casa" son la misma etiqueta; "casa" y "cása" no. */
export const sameTagName = (a: string, b: string): boolean => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;

/** Etiquetas de cada plan del espacio, ordenadas por nombre. */
export async function tagsByPlan(db: Db, workspaceId: string): Promise<Map<string, Tag[]>> {
  const rows = await db
    .select({ planId: planTags.planId, id: tags.id, name: tags.name })
    .from(planTags)
    .innerJoin(tags, eq(tags.id, planTags.tagId))
    .innerJoin(plans, eq(plans.id, planTags.planId))
    .where(and(eq(tags.workspaceId, workspaceId), eq(plans.workspaceId, workspaceId)))
    .orderBy(asc(sql`lower(${tags.name})`));
  const byPlan = new Map<string, Tag[]>();
  for (const row of rows) byPlan.set(row.planId, [...(byPlan.get(row.planId) ?? []), { id: row.id, name: row.name }]);
  return byPlan;
}

/** Todas las etiquetas en uso del espacio, para sugerirlas y filtrar. */
export async function listTags(db: Db, workspaceId: string): Promise<Tag[]> {
  return db.select({ id: tags.id, name: tags.name }).from(tags).where(eq(tags.workspaceId, workspaceId)).orderBy(asc(sql`lower(${tags.name})`));
}

export type TagResult = { ok: true; tag: Tag } | { ok: false; reason: 'not_found' | 'too_many_on_plan' | 'too_many_in_workspace' };

/** Pone una etiqueta a un plan; la crea si no existe. Poner la misma dos veces no hace nada. */
export async function addTagToPlan(db: Db, workspaceId: string, planId: string, name: string): Promise<TagResult> {
  const [plan] = await db.select({ id: plans.id }).from(plans).where(and(eq(plans.id, planId), eq(plans.workspaceId, workspaceId))).limit(1);
  if (!plan) return { ok: false, reason: 'not_found' };

  const existing = await listTags(db, workspaceId);
  let tag = existing.find((entry) => sameTagName(entry.name, name));
  const onPlan = (await tagsByPlan(db, workspaceId)).get(planId) ?? [];
  if (tag && onPlan.some((entry) => entry.id === tag!.id)) return { ok: true, tag };
  if (onPlan.length >= MAX_TAGS_PER_PLAN) return { ok: false, reason: 'too_many_on_plan' };

  if (!tag) {
    if (existing.length >= MAX_TAGS_PER_WORKSPACE) return { ok: false, reason: 'too_many_in_workspace' };
    const [row] = await db.insert(tags).values({ workspaceId, name }).returning({ id: tags.id, name: tags.name });
    tag = row!;
  }
  await db.insert(planTags).values({ planId, tagId: tag.id }).onConflictDoNothing();
  return { ok: true, tag };
}

/** Quita una etiqueta de un plan; si ningún otro plan la usa, la etiqueta desaparece. */
export async function removeTagFromPlan(db: Db, workspaceId: string, planId: string, tagId: string): Promise<boolean> {
  const [link] = await db
    .select({ planId: planTags.planId })
    .from(planTags)
    .innerJoin(tags, eq(tags.id, planTags.tagId))
    .innerJoin(plans, eq(plans.id, planTags.planId))
    .where(and(eq(planTags.planId, planId), eq(planTags.tagId, tagId), eq(tags.workspaceId, workspaceId), eq(plans.workspaceId, workspaceId)))
    .limit(1);
  if (!link) return false;

  await db.delete(planTags).where(and(eq(planTags.planId, planId), eq(planTags.tagId, tagId)));
  const [still] = await db.select({ planId: planTags.planId }).from(planTags).where(eq(planTags.tagId, tagId)).limit(1);
  if (!still) await db.delete(tags).where(and(eq(tags.id, tagId), eq(tags.workspaceId, workspaceId)));
  return true;
}

/** Planes (de la lista dada) que llevan la etiqueta. */
export const plansWithTag = (byPlan: Map<string, Tag[]>, tagId: string): Set<string> =>
  new Set([...byPlan].filter(([, list]) => list.some((tag) => tag.id === tagId)).map(([planId]) => planId));

