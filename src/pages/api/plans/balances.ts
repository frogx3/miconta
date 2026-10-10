import type { APIRoute } from 'astro';
import { getAccount } from '../../../lib/accounts/repo';
import { getDb } from '../../../lib/auth';
import { isValidISODate } from '../../../lib/import/dates';
import { remainingBalanceMinor } from '../../../lib/import/plans';
import { json, requireWorkspaceWithBody, validationError } from '../../../lib/http';
import { matchBankPlans, parseBankPlans, type BankPlanRow } from '../../../lib/plans/bank-balances';
import { applyReportedBalances, listPlans } from '../../../lib/plans/repo';

const MAX_FILES = 6;
const MAX_FILE_CHARS = 200_000;

/**
 * Saldos reales de los planes a partir de los CSV de "compras a meses" del banco. El navegador manda el texto
 * de los archivos y, con `apply: true`, el servidor vuelve a leerlos y a emparejar: nunca aplica lo que el
 * navegador diga que coincidió. Sin `apply` solo muestra qué cambiaría.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;
  const { body, workspace, userId } = access;
  if (!body) return json(400, { code: 'INVALID_JSON' });

  const accountId = typeof body.accountId === 'string' ? body.accountId : '';
  const asOf = typeof body.asOf === 'string' ? body.asOf : '';
  if (!isValidISODate(asOf)) return validationError([{ field: 'asOf', code: 'invalid_date' }]);
  const files = Array.isArray(body.files) ? body.files : [];
  if (files.length === 0) return validationError([{ field: 'files', code: 'required' }]);
  if (files.length > MAX_FILES || files.some((file) => typeof file?.text !== 'string' || file.text.length > MAX_FILE_CHARS)) return validationError([{ field: 'files', code: 'too_long' }]);

  const db = getDb();
  if (!(await getAccount(db, workspace.id, accountId))) return json(404, { code: 'NOT_FOUND' });

  const rows: BankPlanRow[] = [];
  for (const file of files as { name?: unknown; text: string }[]) {
    const parsed = parseBankPlans(file.text);
    if (!parsed.ok) return json(400, { code: 'BAD_FILE', file: typeof file.name === 'string' ? file.name.slice(0, 120) : '', reason: parsed.reason });
    rows.push(...parsed.rows);
  }

  const plans = (await listPlans(db, workspace.id)).filter((plan) => plan.accountId === accountId);
  const { matches, unmatched, closed } = matchBankPlans(rows, plans);

  if (body.apply === true) {
    const applied = await applyReportedBalances(db, workspace.id, userId, asOf, matches.map((m) => ({ planId: m.planId, balanceMinor: m.row.pendingMinor })));
    return json(200, { applied });
  }

  const byId = new Map(plans.map((plan) => [plan.id, plan]));
  return json(200, {
    currency: plans[0]?.currency ?? workspace.defaultCurrency,
    matches: matches.map((m) => ({ planId: m.planId, name: m.planName, current: remainingBalanceMinor(byId.get(m.planId)!), bank: m.row.pendingMinor })),
    unmatched: unmatched.map((row) => ({ description: row.description, date: row.date, number: `${row.current}/${row.total}`, bank: row.pendingMinor })),
    closed: closed.length,
  });
};
