import { and, eq } from 'drizzle-orm';
import { categories, importBatches, movements } from '../../db/schema';
import type { Db } from '../auth/hooks';
import { normalizeDescription } from '../import/text';
import { createCategory } from './repo';

export interface ManualMovementInput {
  accountId: string;
  cardId: string;
  currency: string;
  date: string;
  description: string;
  kind: 'charge' | 'credit';
  amountMinor: number;
  categoryId: string | null;
  /** Nombre de una categoría que se crea al guardar (o se reutiliza si ya existe con ese nombre). */
  newCategory: string | null;
}

export type ManualMovementResult = { ok: true; id: string } | { ok: false; reason: 'category_not_found' };

/** Lote que agrupa los movimientos capturados a mano de una cuenta; se crea la primera vez que se necesita. */
async function manualBatchId(db: Db, workspaceId: string, accountId: string, userId: string): Promise<string> {
  const [existing] = await db
    .select({ id: importBatches.id })
    .from(importBatches)
    .where(and(eq(importBatches.workspaceId, workspaceId), eq(importBatches.accountId, accountId), eq(importBatches.source, 'manual')))
    .limit(1);
  if (existing) return existing.id;
  const [row] = await db
    .insert(importBatches)
    .values({ workspaceId, accountId, fileName: 'Manual', source: 'manual', status: 'applied', createdBy: userId })
    .returning({ id: importBatches.id });
  return row!.id;
}

export async function createManualMovement(db: Db, workspaceId: string, userId: string, input: ManualMovementInput): Promise<ManualMovementResult> {
  let categoryId: string | null = null;
  if (input.kind === 'charge') {
    if (input.newCategory) {
      const created = await createCategory(db, workspaceId, { name: input.newCategory, color: null });
      if (created.ok) categoryId = created.id;
      else {
        const all = await db.select({ id: categories.id, name: categories.name }).from(categories).where(eq(categories.workspaceId, workspaceId));
        categoryId = all.find((c) => c.name.localeCompare(input.newCategory!, undefined, { sensitivity: 'accent' }) === 0)?.id ?? null;
      }
    } else if (input.categoryId) {
      const [found] = await db.select({ id: categories.id }).from(categories).where(and(eq(categories.id, input.categoryId), eq(categories.workspaceId, workspaceId))).limit(1);
      if (!found) return { ok: false, reason: 'category_not_found' };
      categoryId = found.id;
    }
  }

  const batchId = await manualBatchId(db, workspaceId, input.accountId, userId);
  const [row] = await db
    .insert(movements)
    .values({
      workspaceId,
      accountId: input.accountId,
      cardId: input.cardId,
      batchId,
      uniqueKey: `manual:${crypto.randomUUID()}`,
      date: input.date,
      description: input.description,
      descriptionNorm: normalizeDescription(input.description),
      chargeMinor: input.kind === 'charge' ? input.amountMinor : 0,
      creditMinor: input.kind === 'credit' ? input.amountMinor : 0,
      currency: input.currency,
      categoryId,
    })
    .returning({ id: movements.id });
  return { ok: true, id: row!.id };
}
