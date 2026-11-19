import { and, eq, ne, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { importBatches, movements, statementCutoffs } from '../../db/schema';
import type { AccountWithCards } from '../accounts/repo';
import type { Db } from '../auth/hooks';
import { sha256Hex } from '../import/parse';
import { normalizeDescription } from '../import/text';
import { matchCategory } from '../spending/categorize';
import { loadRules } from '../spending/repo';
import type { StatementMovement } from './compare';

/** Inserciones por sentencia: D1 limita a 100 parámetros y cada movimiento usa 17. */
const ROWS_PER_INSERT = 5;

/** Llave única de un movimiento del PDF: prefijo propio para no chocar con las del CSV (otra descripción, otro hash). */
export async function statementKeys(rows: readonly StatementMovement[]): Promise<string[]> {
  const seen = new Map<string, number>();
  const keys: string[] = [];
  for (const m of rows) {
    const hash = await sha256Hex(['pdf', m.last4 ?? '', m.date, normalizeDescription(m.description), m.chargeMinor, m.creditMinor].join('|'));
    const occurrence = (seen.get(hash) ?? 0) + 1;
    seen.set(hash, occurrence);
    keys.push(`pdf:${hash}#${occurrence}`);
  }
  return keys;
}

/**
 * Guarda lo que la persona aprobó de la comparación: los movimientos que faltaban (como una carga del historial, que
 * se puede deshacer) y, si lo pidió, el corte y la fecha límite del estado de cuenta. Todo en una sola transacción.
 */
export async function applyStatement(
  db: Db,
  input: {
    workspaceId: string;
    userId: string;
    account: AccountWithCards;
    currency: string;
    fileName: string;
    period: { start: string; cutoff: string; dueDate: string | null };
    movements: StatementMovement[];
    saveCutoff: boolean;
  },
): Promise<{ batchId: string | null; movements: number; categorized: number }> {
  const { workspaceId, account } = input;
  const statements: BatchItem<'sqlite'>[] = [];
  let batchId: string | null = null;
  let categorized = 0;

  if (input.movements.length > 0) {
    batchId = crypto.randomUUID();
    const active = account.cards.filter((card) => !card.archivedAt);
    const byLast4 = new Map(active.flatMap((card) => (card.last4 ? [[card.last4, card.id] as const] : [])));
    // Sin terminación en el PDF: la tarjeta de crédito de la cuenta, solo si no hay duda de cuál es.
    const credit = active.filter((card) => card.kind === 'credit');
    const fallback = credit.length === 1 ? credit[0]!.id : null;
    const rules = await loadRules(db, workspaceId);
    const keys = await statementKeys(input.movements);

    statements.push(
      db.insert(importBatches).values({
        id: batchId,
        workspaceId,
        accountId: account.id,
        fileName: input.fileName,
        cutoffDate: input.period.cutoff,
        status: 'applied',
        source: 'csv',
        createdBy: input.userId,
        summary: { rows: { total: input.movements.length, fresh: input.movements.length, duplicates: 0, errors: 0 } },
      }),
    );
    const rows = input.movements.map((m, i) => {
      const descriptionNorm = normalizeDescription(m.description);
      const categoryId = m.chargeMinor > 0 ? matchCategory(descriptionNorm, rules) : null;
      if (categoryId) categorized++;
      return {
        workspaceId,
        accountId: account.id,
        cardId: (m.last4 ? byLast4.get(m.last4) : undefined) ?? fallback,
        batchId: batchId!,
        uniqueKey: keys[i]!,
        date: m.date,
        description: m.description,
        descriptionNorm,
        chargeMinor: m.chargeMinor,
        creditMinor: m.creditMinor,
        currency: input.currency,
        categoryId,
      };
    });
    for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) statements.push(db.insert(movements).values(rows.slice(i, i + ROWS_PER_INSERT)));
  }

  if (input.saveCutoff) {
    const { cutoff, dueDate, start } = input.period;
    // Un corte por mes: si el mes ya tenía otro día capturado, se corrige ese en lugar de crear un segundo.
    statements.push(
      db
        .update(statementCutoffs)
        .set({ cutoffDate: cutoff, startDate: start, ...(dueDate ? { dueDate } : {}) })
        .where(and(eq(statementCutoffs.accountId, account.id), sql`substr(${statementCutoffs.cutoffDate}, 1, 7) = ${cutoff.slice(0, 7)}`, ne(statementCutoffs.cutoffDate, cutoff))),
      db
        .insert(statementCutoffs)
        .values({ workspaceId, accountId: account.id, cutoffDate: cutoff, startDate: start, dueDate })
        .onConflictDoUpdate({ target: [statementCutoffs.accountId, statementCutoffs.cutoffDate], set: { startDate: start, ...(dueDate ? { dueDate } : {}) } }),
    );
  }

  if (statements.length > 0) await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
  return { batchId, movements: input.movements.length, categorized };
}
