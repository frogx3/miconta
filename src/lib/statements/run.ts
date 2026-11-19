import { and, between, eq } from 'drizzle-orm';
import { cards, movements, statementCutoffs } from '../../db/schema';
import type { AccountWithCards } from '../accounts/repo';
import type { Db } from '../auth/hooks';
import { isBankId, OTHER_BANK } from '../banks';
import { listPlans } from '../plans/repo';
import { addDays } from '../spending/statement';
import { compareStatement, type StatementComparison } from './compare';
import type { StatementInput } from './input';

/** Margen para emparejar fechas en las orillas del periodo (el comparador acepta ±3 días). */
const EDGE_DAYS = 3;
/** Un corte capturado a menos de esta distancia del del estado de cuenta se considera el mismo. */
const CUTOFF_WINDOW_DAYS = 10;

/** Carga lo que Don Bigo tiene de la cuenta en el periodo y lo compara. La usan la vista de diferencias y el guardado. */
export async function runComparison(db: Db, workspaceId: string, account: AccountWithCards, input: StatementInput, defaultCurrency: string): Promise<{ comparison: StatementComparison; currency: string }> {
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
  const currency = account.cards.find((card) => card.kind === 'credit')?.currency ?? defaultCurrency;
  const comparison = compareStatement(
    { bankId: isBankId(account.bankId) ? account.bankId : OTHER_BANK, currency, period: input.period, totals: input.totals, movements: input.movements, plans: input.plans },
    { movements: existing, plans, cutoff: cutoffs[0] ?? null },
  );
  // Los de las orillas solo servían para emparejar: "sobra en Don Bigo" es solo dentro del periodo.
  comparison.extra = comparison.extra.filter((m) => m.date >= start && m.date <= cutoff);
  return { comparison, currency };
}
