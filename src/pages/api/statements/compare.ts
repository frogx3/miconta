import type { APIRoute } from 'astro';
import { getAccount } from '../../../lib/accounts/repo';
import { getDb } from '../../../lib/auth';
import { json, requireWorkspaceWithBody } from '../../../lib/http';
import { validateStatementInput } from '../../../lib/statements/input';
import { runComparison } from '../../../lib/statements/run';

/**
 * Compara un estado de cuenta (tablas que la persona eligió del PDF) contra lo que hay en Don Bigo para esa cuenta.
 * Solo describe diferencias: no escribe nada.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;
  const parsed = validateStatementInput(access.body);
  if (!parsed.ok) return json(400, { code: 'INVALID_STATEMENT', field: parsed.field });

  const db = getDb();
  const account = await getAccount(db, access.workspace.id, parsed.value.accountId);
  if (!account) return json(404, { code: 'NOT_FOUND' });
  const result = await runComparison(db, access.workspace.id, account, parsed.value, access.workspace.defaultCurrency);
  // Posición de cada faltante en lo enviado: con ella la persona elige qué guardar.
  return json(200, { ...result, missingIndexes: result.comparison.missing.map((m) => parsed.value.movements.indexOf(m)) });
};
