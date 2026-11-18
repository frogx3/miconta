import type { APIRoute } from 'astro';
import { and, between, eq } from 'drizzle-orm';
import { cards, movements, statementCutoffs } from '../../../db/schema';
import { getAccount } from '../../../lib/accounts/repo';
import { getDb } from '../../../lib/auth';
import { isBankId, OTHER_BANK } from '../../../lib/banks';
import { addDays } from '../../../lib/spending/statement';
import { json, requireWorkspaceWithBody } from '../../../lib/http';
import { listPlans } from '../../../lib/plans/repo';
import { compareStatement } from '../../../lib/statements/compare';
import { validateStatementInput } from '../../../lib/statements/input';

/** Margen para emparejar fechas en las orillas del periodo (el comparador acepta ±3 días). */
const EDGE_DAYS = 3;
/** Un corte capturado a menos de esta distancia del del estado de cuenta se considera el mismo. */
const CUTOFF_WINDOW_DAYS = 10;

/**
 * Compara un estado de cuenta (tablas que la persona eligió del PDF) contra lo que hay en Don Bigo para esa cuenta.
 * Solo describe diferencias: no escribe nada.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;
  const parsed = validateStatementInput(access.body);
  if (!parsed.ok) return json(400, { code: 'INVALID_STATEMENT', field: parsed.field });
  const input = parsed.value;

  const db = getDb();
  const workspaceId = access.workspace.id;
  const account = await getAccount(db, workspaceId, input.accountId);
  if (!account) return json(404, { code: 'NOT_FOUND' });

  const { start, cutoff } = input.period;
  const [existing, plans, cutoffs] = await Promise.all([
    db
      .select({ id: movements.id, date: movements.date, description: movements.description, chargeMinor: movements.chargeMinor, creditMinor: movements.creditMinor, last4: cards.last4 })
      .from(movements)
      .leftJoin(cards, eq(cards.id, movements.cardId))
      .where(and(eq(movements.workspaceId, workspaceId), eq(movements.accountId, account.id), between(movements.date, addDays(start, -EDGE_DAYS), addDays(cutoff, EDGE_DAYS)))),
    listPlans(db, workspaceId).then((all) => all.filter((plan) => plan.accountId === account.id)),
    db
      .select({ date: statementCutoffs.cutoffDate, dueDate: statementCutoffs.dueDate })
      .from(statementCutoffs)
      .where(and(eq(statementCutoffs.workspaceId, workspaceId), eq(statementCutoffs.accountId, account.id), between(statementCutoffs.cutoffDate, addDays(cutoff, -CUTOFF_WINDOW_DAYS), addDays(cutoff, CUTOFF_WINDOW_DAYS)))),
  ]);

  const comparison = compareStatement(
    { bankId: isBankId(account.bankId) ? account.bankId : OTHER_BANK, currency: plans[0]?.currency ?? access.workspace.defaultCurrency, period: input.period, totals: input.totals, movements: input.movements, plans: input.plans },
    { movements: existing, plans, cutoff: cutoffs[0] ?? null },
  );
  // Los de las orillas solo servían para emparejar: "sobra en Don Bigo" es solo dentro del periodo.
  comparison.extra = comparison.extra.filter((m) => m.date >= start && m.date <= cutoff);
  return json(200, { comparison, currency: account.cards.find((card) => card.kind === 'credit')?.currency ?? access.workspace.defaultCurrency });
};
