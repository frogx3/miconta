import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { accounts, cards, categories, categoryRules, movements, statementCutoffs, workspaces } from '../../db/schema';
import type { Db } from '../auth/hooks';
import { normalizeDescription } from '../import/text';
import { matchCategory, type Rule } from './categorize';
import type { SpendRow } from './analysis';

/**
 * Todas las funciones reciben el `workspaceId` y lo aplican en cada consulta. D1 admite como máximo
 * 100 parámetros por consulta, por eso las listas de ids se procesan en bloques.
 */
const CHUNK = 90;
const chunks = <T>(items: readonly T[]): T[][] => Array.from({ length: Math.ceil(items.length / CHUNK) }, (_, i) => items.slice(i * CHUNK, (i + 1) * CHUNK));
const batch = (db: Db, statements: BatchItem<'sqlite'>[]) => db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);

// ── Categorías ────────────────────────────────────────────────────────────────────────────────

export type Category = typeof categories.$inferSelect;
export interface CategoryWithCount extends Category {
  movementCount: number;
}

export async function listCategories(db: Db, workspaceId: string): Promise<CategoryWithCount[]> {
  const rows = await db.select().from(categories).where(eq(categories.workspaceId, workspaceId)).orderBy(asc(categories.name));
  const counts = await db
    .select({ categoryId: movements.categoryId, n: sql<number>`count(*)` })
    .from(movements)
    .where(eq(movements.workspaceId, workspaceId))
    .groupBy(movements.categoryId);
  const byId = new Map(counts.map((c) => [c.categoryId, c.n]));
  return rows.map((category) => ({ ...category, movementCount: byId.get(category.id) ?? 0 }));
}

const sameName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;

export type CategoryResult = { ok: true; id: string } | { ok: false; reason: 'duplicate' | 'not_found' };

export async function createCategory(db: Db, workspaceId: string, input: { name: string; color: string | null; budgetMinor?: number | null }): Promise<CategoryResult> {
  const existing = await db.select({ name: categories.name }).from(categories).where(eq(categories.workspaceId, workspaceId));
  if (existing.some((c) => sameName(c.name, input.name))) return { ok: false, reason: 'duplicate' };
  const [row] = await db.insert(categories).values({ workspaceId, ...input }).returning({ id: categories.id });
  return { ok: true, id: row!.id };
}

export async function updateCategory(db: Db, workspaceId: string, categoryId: string, input: { name: string; color: string | null; budgetMinor?: number | null }): Promise<CategoryResult> {
  const all = await db.select({ id: categories.id, name: categories.name }).from(categories).where(eq(categories.workspaceId, workspaceId));
  if (!all.some((c) => c.id === categoryId)) return { ok: false, reason: 'not_found' };
  if (all.some((c) => c.id !== categoryId && sameName(c.name, input.name))) return { ok: false, reason: 'duplicate' };
  await db.update(categories).set(input).where(and(eq(categories.id, categoryId), eq(categories.workspaceId, workspaceId)));
  return { ok: true, id: categoryId };
}

/**
 * Elimina una categoría: sus movimientos quedan sin categoría y sus reglas se borran. Es solo
 * clasificación; los movimientos en sí no se tocan.
 */
export async function deleteCategory(db: Db, workspaceId: string, categoryId: string): Promise<boolean> {
  const [found] = await db.select({ id: categories.id }).from(categories).where(and(eq(categories.id, categoryId), eq(categories.workspaceId, workspaceId))).limit(1);
  if (!found) return false;
  await batch(db, [
    db.update(movements).set({ categoryId: null }).where(and(eq(movements.workspaceId, workspaceId), eq(movements.categoryId, categoryId))),
    db.delete(categoryRules).where(and(eq(categoryRules.workspaceId, workspaceId), eq(categoryRules.categoryId, categoryId))),
    db.delete(categories).where(and(eq(categories.id, categoryId), eq(categories.workspaceId, workspaceId))),
  ]);
  return true;
}

/** Crea las categorías sugeridas que aún no existan (por nombre). Devuelve cuántas creó. */
export async function seedCategories(db: Db, workspaceId: string, defaults: { name: string; color: string }[]): Promise<number> {
  const existing = await db.select({ name: categories.name }).from(categories).where(eq(categories.workspaceId, workspaceId));
  const missing = defaults.filter((d) => !existing.some((c) => sameName(c.name, d.name)));
  if (missing.length === 0) return 0;
  await db.insert(categories).values(missing.map((d) => ({ workspaceId, name: d.name, color: d.color })));
  return missing.length;
}

// ── Reglas ────────────────────────────────────────────────────────────────────────────────────

export interface RuleRow {
  id: string;
  pattern: string;
  categoryId: string;
  categoryName: string;
  categoryColor: string | null;
}

export async function listRules(db: Db, workspaceId: string): Promise<RuleRow[]> {
  return db
    .select({ id: categoryRules.id, pattern: categoryRules.pattern, categoryId: categoryRules.categoryId, categoryName: categories.name, categoryColor: categories.color })
    .from(categoryRules)
    .innerJoin(categories, eq(categories.id, categoryRules.categoryId))
    .where(eq(categoryRules.workspaceId, workspaceId))
    .orderBy(asc(categoryRules.pattern));
}

export async function loadRules(db: Db, workspaceId: string): Promise<Rule[]> {
  return db.select({ categoryId: categoryRules.categoryId, pattern: categoryRules.pattern }).from(categoryRules).where(eq(categoryRules.workspaceId, workspaceId));
}

export type RuleResult = { ok: true; id: string } | { ok: false; reason: 'category_not_found' | 'duplicate' };

export async function createRule(db: Db, workspaceId: string, input: { pattern: string; categoryId: string }): Promise<RuleResult> {
  const [category] = await db.select({ id: categories.id }).from(categories).where(and(eq(categories.id, input.categoryId), eq(categories.workspaceId, workspaceId))).limit(1);
  if (!category) return { ok: false, reason: 'category_not_found' };
  const [duplicate] = await db.select({ id: categoryRules.id }).from(categoryRules).where(and(eq(categoryRules.workspaceId, workspaceId), eq(categoryRules.pattern, input.pattern))).limit(1);
  if (duplicate) return { ok: false, reason: 'duplicate' };
  const [row] = await db.insert(categoryRules).values({ workspaceId, ...input }).returning({ id: categoryRules.id });
  return { ok: true, id: row!.id };
}

export async function deleteRule(db: Db, workspaceId: string, ruleId: string): Promise<boolean> {
  const rows = await db.delete(categoryRules).where(and(eq(categoryRules.id, ruleId), eq(categoryRules.workspaceId, workspaceId))).returning({ id: categoryRules.id });
  return rows.length > 0;
}

/** Asigna categorías a los cargos que aún no tienen, según las reglas. Devuelve cuántos categorizó. */
export async function applyRulesToUncategorized(db: Db, workspaceId: string): Promise<number> {
  const rules = await loadRules(db, workspaceId);
  if (rules.length === 0) return 0;
  const pending = await db
    .select({ id: movements.id, descriptionNorm: movements.descriptionNorm })
    .from(movements)
    .where(and(eq(movements.workspaceId, workspaceId), isNull(movements.categoryId), sql`${movements.chargeMinor} > 0`));

  const byCategory = new Map<string, string[]>();
  for (const movement of pending) {
    const categoryId = matchCategory(movement.descriptionNorm, rules);
    if (categoryId) byCategory.set(categoryId, [...(byCategory.get(categoryId) ?? []), movement.id]);
  }
  const statements: BatchItem<'sqlite'>[] = [];
  let applied = 0;
  for (const [categoryId, ids] of byCategory) {
    for (const part of chunks(ids)) {
      statements.push(db.update(movements).set({ categoryId }).where(and(eq(movements.workspaceId, workspaceId), inArray(movements.id, part))));
      applied += part.length;
    }
  }
  if (statements.length > 0) await batch(db, statements);
  return applied;
}

/** Asigna (o quita, con `null`) la categoría de varios movimientos del espacio. */
export async function setMovementsCategory(db: Db, workspaceId: string, ids: string[], categoryId: string | null): Promise<{ ok: true; updated: number } | { ok: false; reason: 'category_not_found' }> {
  if (categoryId) {
    const [category] = await db.select({ id: categories.id }).from(categories).where(and(eq(categories.id, categoryId), eq(categories.workspaceId, workspaceId))).limit(1);
    if (!category) return { ok: false, reason: 'category_not_found' };
  }
  let updated = 0;
  for (const part of chunks(ids)) {
    const rows = await db
      .update(movements)
      .set({ categoryId })
      .where(and(eq(movements.workspaceId, workspaceId), inArray(movements.id, part)))
      .returning({ id: movements.id });
    updated += rows.length;
  }
  return { ok: true, updated };
}

// ── Consultas para el análisis y las listas ───────────────────────────────────────────────────

/** Mes más reciente con movimientos (`YYYY-MM`), o null si aún no hay. */
export async function latestMovementMonth(db: Db, workspaceId: string): Promise<string | null> {
  const [row] = await db.select({ date: sql<string | null>`max(${movements.date})` }).from(movements).where(eq(movements.workspaceId, workspaceId));
  return row?.date ? row.date.slice(0, 7) : null;
}

/** Meses (`YYYY-MM`) con movimientos, del más reciente al más antiguo. */
export async function movementMonths(db: Db, workspaceId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ month: sql<string>`substr(${movements.date}, 1, 7)` })
    .from(movements)
    .where(eq(movements.workspaceId, workspaceId))
    .orderBy(desc(sql`substr(${movements.date}, 1, 7)`));
  return rows.map((row) => row.month);
}

export async function movementsForAnalysis(db: Db, workspaceId: string, fromDate: string, toDate: string, accountId?: string): Promise<SpendRow[]> {
  return db
    .select({
      date: movements.date,
      descriptionNorm: movements.descriptionNorm,
      chargeMinor: movements.chargeMinor,
      creditMinor: movements.creditMinor,
      currency: movements.currency,
      categoryId: movements.categoryId,
      planId: movements.planId,
    })
    .from(movements)
    .where(and(eq(movements.workspaceId, workspaceId), gte(movements.date, fromDate), lte(movements.date, toDate), accountId ? eq(movements.accountId, accountId) : undefined));
}

/** Movimientos de TODAS las tarjetas de una cuenta entre dos fechas, en una moneda: el estado de cuenta junta titular y adicionales. */
export async function movementsForAccount(db: Db, workspaceId: string, accountId: string, currency: string, fromDate: string, toDate: string): Promise<SpendRow[]> {
  return db
    .select({
      date: movements.date,
      descriptionNorm: movements.descriptionNorm,
      chargeMinor: movements.chargeMinor,
      creditMinor: movements.creditMinor,
      currency: movements.currency,
      categoryId: movements.categoryId,
      planId: movements.planId,
    })
    .from(movements)
    .where(
      and(
        eq(movements.workspaceId, workspaceId),
        eq(movements.accountId, accountId),
        eq(movements.currency, currency),
        gte(movements.date, fromDate),
        lte(movements.date, toDate),
      ),
    );
}

// ── Cortes reales ─────────────────────────────────────────────────────────────────────────────

export type StatementCutoff = typeof statementCutoffs.$inferSelect;

export async function listCutoffs(db: Db, workspaceId: string, accountId: string): Promise<StatementCutoff[]> {
  return db
    .select()
    .from(statementCutoffs)
    .where(and(eq(statementCutoffs.workspaceId, workspaceId), eq(statementCutoffs.accountId, accountId)))
    .orderBy(desc(statementCutoffs.cutoffDate));
}

export interface CutoffInput {
  accountId: string;
  cutoffDate: string;
  startDate: string | null;
  officialPayMinor: number | null;
}

/** Guarda el corte real de una cuenta; si ya había uno con esa fecha, lo reemplaza. Falso si la cuenta no es del espacio. */
export async function saveCutoff(db: Db, workspaceId: string, input: CutoffInput): Promise<boolean> {
  const [account] = await db.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.id, input.accountId), eq(accounts.workspaceId, workspaceId))).limit(1);
  if (!account) return false;
  await db
    .insert(statementCutoffs)
    .values({ workspaceId, ...input })
    .onConflictDoUpdate({ target: [statementCutoffs.accountId, statementCutoffs.cutoffDate], set: { startDate: input.startDate, officialPayMinor: input.officialPayMinor } });
  return true;
}

export async function deleteCutoff(db: Db, workspaceId: string, cutoffId: string): Promise<boolean> {
  const rows = await db.delete(statementCutoffs).where(and(eq(statementCutoffs.id, cutoffId), eq(statementCutoffs.workspaceId, workspaceId))).returning({ id: statementCutoffs.id });
  return rows.length > 0;
}

export interface MovementListItem {
  id: string;
  date: string;
  description: string;
  descriptionNorm: string;
  reference: string | null;
  chargeMinor: number;
  creditMinor: number;
  currency: string;
  categoryId: string | null;
  planId: string | null;
  accountName: string;
  accountId: string;
  /** Nulo si el archivo no traía los últimos 4 dígitos del cargo. */
  cardId: string | null;
  last4: string | null;
}

export interface MovementFilters {
  fromDate: string;
  toDate: string;
  /** Una tarjeta concreta o toda una cuenta. */
  cardId?: string;
  accountId?: string;
  /** `'none'` = sin categoría */
  categoryId?: string;
  /** Texto a buscar en el concepto (ya normalizado). */
  q?: string;
}

const MAX_LIST_ROWS = 1000;

export async function listMovements(db: Db, workspaceId: string, filters: MovementFilters): Promise<MovementListItem[]> {
  const conditions = [eq(movements.workspaceId, workspaceId), gte(movements.date, filters.fromDate), lte(movements.date, filters.toDate)];
  if (filters.cardId) conditions.push(eq(movements.cardId, filters.cardId));
  if (filters.accountId) conditions.push(eq(movements.accountId, filters.accountId));
  if (filters.categoryId === 'none') conditions.push(isNull(movements.categoryId));
  else if (filters.categoryId) conditions.push(eq(movements.categoryId, filters.categoryId));
  if (filters.q) {
    const pattern = `%${normalizeDescription(filters.q).replace(/[\\%_]/g, '\\$&')}%`;
    conditions.push(sql`${movements.descriptionNorm} LIKE ${pattern} ESCAPE '\\'`);
  }
  return db
    .select({
      id: movements.id,
      date: movements.date,
      description: movements.description,
      descriptionNorm: movements.descriptionNorm,
      reference: movements.reference,
      chargeMinor: movements.chargeMinor,
      creditMinor: movements.creditMinor,
      currency: movements.currency,
      categoryId: movements.categoryId,
      planId: movements.planId,
      accountName: accounts.name,
      accountId: accounts.id,
      cardId: movements.cardId,
      last4: cards.last4,
    })
    .from(movements)
    .innerJoin(accounts, eq(accounts.id, movements.accountId))
    .leftJoin(cards, eq(cards.id, movements.cardId))
    .where(and(...conditions))
    .orderBy(desc(movements.date), desc(movements.createdAt))
    .limit(MAX_LIST_ROWS);
}

/** Cargos sin categoría (de todo el historial), para proponer reglas agrupadas por comercio. */
export async function uncategorizedCharges(db: Db, workspaceId: string): Promise<{ descriptionNorm: string; chargeMinor: number; currency: string }[]> {
  return db
    .select({ descriptionNorm: movements.descriptionNorm, chargeMinor: movements.chargeMinor, currency: movements.currency })
    .from(movements)
    .where(and(eq(movements.workspaceId, workspaceId), isNull(movements.categoryId), isNull(movements.planId), sql`${movements.chargeMinor} > 0`))
    .limit(5000);
}

// ── Ajustes del espacio ───────────────────────────────────────────────────────────────────────

export async function getWorkspaceSettings(db: Db, workspaceId: string): Promise<{ currency: string; thresholdMinor: number | null }> {
  const [row] = await db.select({ currency: workspaces.defaultCurrency, thresholdMinor: workspaces.antThresholdMinor }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  return row ?? { currency: 'MXN', thresholdMinor: null };
}

export async function setAntThreshold(db: Db, workspaceId: string, thresholdMinor: number): Promise<void> {
  await db.update(workspaces).set({ antThresholdMinor: thresholdMinor }).where(eq(workspaces.id, workspaceId));
}
