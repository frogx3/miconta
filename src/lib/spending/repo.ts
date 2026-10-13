import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { accounts, cards, categories, categoryRules, movements, statementCutoffs, workspaces } from '../../db/schema';
import type { Db } from '../auth/hooks';
import { normalizeDescription } from '../import/text';
import { matchCategory, type Rule } from './categorize';
import type { SpendRow } from './analysis';
import { paymentGroups } from './groups';

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

/** Fecha del movimiento más antiguo del espacio, o `null` si no hay ninguno. */
export async function firstMovementDate(db: Db, workspaceId: string): Promise<string | null> {
  const [row] = await db.select({ first: sql<string | null>`min(${movements.date})` }).from(movements).where(eq(movements.workspaceId, workspaceId));
  return row?.first ?? null;
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

/**
 * Periodo de un corte. `month` es el mes en que cierra (`YYYY-MM`) y se cuentan además los movimientos que se asignaron
 * a mano a ese corte aunque su fecha caiga fuera; los asignados a otro corte se excluyen aunque su fecha caiga dentro.
 * Con `month` nulo (el periodo en curso, aún sin corte) solo cuentan los que no se asignaron a ningún corte.
 */
export interface CutPeriod {
  month: string | null;
  from: string;
  to: string;
}

function inPeriod(period: CutPeriod): SQL {
  const byDate = and(isNull(movements.statementMonth), gte(movements.date, period.from), lte(movements.date, period.to))!;
  return period.month ? or(eq(movements.statementMonth, period.month), byDate)! : byDate;
}

export interface PeriodMovement extends SpendRow {
  id: string;
  description: string;
  reference: string | null;
  cardId: string | null;
  statementMonth: string | null;
}

/** Movimientos de TODAS las tarjetas de una cuenta en un corte, en una moneda: el estado de cuenta junta titular y adicionales. */
export async function movementsForAccount(db: Db, workspaceId: string, accountId: string, currency: string, period: CutPeriod): Promise<PeriodMovement[]> {
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
      cardId: movements.cardId,
      statementMonth: movements.statementMonth,
    })
    .from(movements)
    .where(and(eq(movements.workspaceId, workspaceId), eq(movements.accountId, accountId), eq(movements.currency, currency), inPeriod(period)));
}

/**
 * Movimientos que cuentan en este corte aunque su fecha caiga fuera (`in`) o que, por su fecha, serían de este corte pero se
 * asignaron a otro (`out`). Son los ajustes manuales que explican una diferencia con el estado de cuenta.
 */
export async function cutAdjustments(db: Db, workspaceId: string, accountId: string, currency: string, month: string, from: string, to: string): Promise<{ in: PeriodMovement[]; out: PeriodMovement[] }> {
  const rows = await db
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
      cardId: movements.cardId,
      statementMonth: movements.statementMonth,
    })
    .from(movements)
    .where(
      and(
        eq(movements.workspaceId, workspaceId),
        eq(movements.accountId, accountId),
        eq(movements.currency, currency),
        or(
          and(eq(movements.statementMonth, month), or(lt(movements.date, from), gt(movements.date, to))),
          and(isNotNull(movements.statementMonth), ne(movements.statementMonth, month), gte(movements.date, from), lte(movements.date, to)),
        ),
      ),
    );
  return { in: rows.filter((row) => row.statementMonth === month), out: rows.filter((row) => row.statementMonth !== month) };
}

export type MoveResult = { ok: true; updated: number } | { ok: false; reason: 'not_found' | 'invalid_cut' };

/**
 * Contabiliza movimientos en otro corte (`month`, el mes en que cierra) o los devuelve al que les toca por fecha (`null`).
 * El corte debe existir en la cuenta de cada movimiento. Un pago agrupado (pago requerido + intereses + IVA) se mueve completo.
 */
export async function moveToStatement(db: Db, workspaceId: string, ids: string[], month: string | null): Promise<MoveResult> {
  const picked: { id: string; accountId: string; cardId: string | null; reference: string | null }[] = [];
  for (const part of chunks(ids)) {
    picked.push(...(await db.select({ id: movements.id, accountId: movements.accountId, cardId: movements.cardId, reference: movements.reference }).from(movements).where(and(eq(movements.workspaceId, workspaceId), inArray(movements.id, part)))));
  }
  if (picked.length !== new Set(ids).size) return { ok: false, reason: 'not_found' };

  const accountIds = [...new Set(picked.map((row) => row.accountId))];
  if (month) {
    for (const accountId of accountIds) {
      const [cut] = await db
        .select({ id: statementCutoffs.id })
        .from(statementCutoffs)
        .where(and(eq(statementCutoffs.workspaceId, workspaceId), eq(statementCutoffs.accountId, accountId), sql`substr(${statementCutoffs.cutoffDate}, 1, 7) = ${month}`))
        .limit(1);
      if (!cut) return { ok: false, reason: 'invalid_cut' };
    }
  }

  // Un movimiento que pertenece a un pago agrupado arrastra al resto del grupo.
  const all = new Set(ids);
  for (const reference of [...new Set(picked.flatMap((row) => (row.reference ? [`${row.accountId}|${row.cardId ?? ''}|${row.reference}`] : [])))]) {
    const [accountId, cardId, ref] = reference.split('|') as [string, string, string];
    const siblings = await db
      .select({ id: movements.id, cardId: movements.cardId, reference: movements.reference, descriptionNorm: movements.descriptionNorm, chargeMinor: movements.chargeMinor, creditMinor: movements.creditMinor })
      .from(movements)
      .where(and(eq(movements.workspaceId, workspaceId), eq(movements.accountId, accountId), eq(movements.reference, ref), cardId ? eq(movements.cardId, cardId) : isNull(movements.cardId)));
    for (const group of paymentGroups(siblings.map((row) => ({ key: row.id, cardKey: row.cardId, reference: row.reference, descriptionNorm: row.descriptionNorm, chargeMinor: row.chargeMinor, creditMinor: row.creditMinor }))).values()) {
      const members = [...group.chargeKeys, ...group.creditKeys];
      if (members.some((id) => all.has(id))) members.forEach((id) => all.add(id));
    }
  }

  const statements: BatchItem<'sqlite'>[] = chunks([...all]).map((part) =>
    db.update(movements).set({ statementMonth: month }).where(and(eq(movements.workspaceId, workspaceId), inArray(movements.id, part))),
  );
  await batch(db, statements);
  return { ok: true, updated: all.size };
}

/** Quita las asignaciones a un corte que ya no existe (se borró o cambió de mes): esos movimientos vuelven a contarse por su fecha. */
export async function clearOrphanMoves(db: Db, workspaceId: string, accountId: string): Promise<void> {
  await db
    .update(movements)
    .set({ statementMonth: null })
    .where(
      and(
        eq(movements.workspaceId, workspaceId),
        eq(movements.accountId, accountId),
        isNotNull(movements.statementMonth),
        sql`${movements.statementMonth} not in (select substr(${statementCutoffs.cutoffDate}, 1, 7) from ${statementCutoffs} where ${statementCutoffs.accountId} = ${accountId})`,
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

export type SaveCutoffResult = { ok: true } | { ok: false; reason: 'not_found' | 'month_taken' };

/**
 * Guarda el corte real de una cuenta. Un corte se identifica por el mes en que cierra (hay uno por mes): si se edita uno
 * existente (`recordId`, o el que ya cierra en ese mes) se actualiza, incluida su fecha, en vez de crear un segundo. Mover
 * la fecha a un mes que ya tiene otro corte se rechaza.
 */
export async function saveCutoff(db: Db, workspaceId: string, input: CutoffInput, recordId?: string): Promise<SaveCutoffResult> {
  const [account] = await db.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.id, input.accountId), eq(accounts.workspaceId, workspaceId))).limit(1);
  if (!account) return { ok: false, reason: 'not_found' };

  const month = input.cutoffDate.slice(0, 7);
  const inAccount = and(eq(statementCutoffs.workspaceId, workspaceId), eq(statementCutoffs.accountId, input.accountId))!;
  const [edited] = recordId ? await db.select().from(statementCutoffs).where(and(inAccount, eq(statementCutoffs.id, recordId))).limit(1) : [];
  if (recordId && !edited) return { ok: false, reason: 'not_found' };
  const inMonth = await db
    .select()
    .from(statementCutoffs)
    .where(and(inAccount, sql`substr(${statementCutoffs.cutoffDate}, 1, 7) = ${month}`))
    .orderBy(asc(statementCutoffs.createdAt));
  const target = edited ?? inMonth[0];
  const others = inMonth.filter((record) => record.id !== target?.id);
  // Mover un corte a un mes que ya tiene otro es un conflicto. Si el corte ya estaba en ese mes, los demás son repetidos
  // (quedaron de cuando guardar una fecha distinta creaba otro corte): hay un corte por mes, así que se quitan.
  if (edited && others.length > 0 && edited.cutoffDate.slice(0, 7) !== month) return { ok: false, reason: 'month_taken' };

  if (target) {
    await batch(db, [
      ...(others.length > 0 ? [db.delete(statementCutoffs).where(inArray(statementCutoffs.id, others.map((record) => record.id)))] : []),
      db.update(statementCutoffs).set({ cutoffDate: input.cutoffDate, startDate: input.startDate, officialPayMinor: input.officialPayMinor }).where(eq(statementCutoffs.id, target.id)),
    ]);
    // Si el corte cambió de mes, los movimientos asignados a él ya no tienen a dónde ir: vuelven a contarse por su fecha.
    if (target.cutoffDate.slice(0, 7) !== month) await clearOrphanMoves(db, workspaceId, input.accountId);
  } else {
    await db.insert(statementCutoffs).values({ workspaceId, ...input });
  }
  return { ok: true };
}

export async function deleteCutoff(db: Db, workspaceId: string, cutoffId: string): Promise<boolean> {
  const rows = await db
    .delete(statementCutoffs)
    .where(and(eq(statementCutoffs.id, cutoffId), eq(statementCutoffs.workspaceId, workspaceId)))
    .returning({ id: statementCutoffs.id, accountId: statementCutoffs.accountId });
  if (rows[0]) await clearOrphanMoves(db, workspaceId, rows[0].accountId);
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
  /** Corte al que se asignó a mano (mes en que cierra); nulo si cuenta en el que le toca por su fecha. */
  statementMonth: string | null;
}

export interface MovementFilters {
  fromDate: string;
  toDate: string;
  /** Un corte (con sus asignaciones manuales); sustituye al rango de fechas. */
  cut?: CutPeriod;
  /** Una tarjeta concreta o toda una cuenta. */
  cardId?: string;
  accountId?: string;
  /** `'none'` = sin categoría */
  categoryId?: string;
  /** Texto a buscar en el concepto (ya normalizado). */
  q?: string;
  /** Solo los movimientos de una carga de CSV. */
  batchId?: string;
}

const MAX_LIST_ROWS = 1000;

export async function listMovements(db: Db, workspaceId: string, filters: MovementFilters): Promise<MovementListItem[]> {
  const conditions = [eq(movements.workspaceId, workspaceId), filters.cut ? inPeriod(filters.cut) : and(gte(movements.date, filters.fromDate), lte(movements.date, filters.toDate))!];
  if (filters.cardId) conditions.push(eq(movements.cardId, filters.cardId));
  if (filters.accountId) conditions.push(eq(movements.accountId, filters.accountId));
  if (filters.batchId) conditions.push(eq(movements.batchId, filters.batchId));
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
      statementMonth: movements.statementMonth,
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
