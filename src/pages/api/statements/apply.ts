import type { APIRoute } from 'astro';
import { getAccount } from '../../../lib/accounts/repo';
import { getDb } from '../../../lib/auth';
import { json, requireWorkspaceWithBody } from '../../../lib/http';
import { applyReportedBalances } from '../../../lib/plans/repo';
import { applyStatement } from '../../../lib/statements/apply';
import { validateStatementInput } from '../../../lib/statements/input';
import { runComparison } from '../../../lib/statements/run';

/**
 * Guarda lo que la persona aprobó en la pantalla de diferencias. El servidor vuelve a comparar y solo acepta
 * movimientos que de verdad faltan (por su posición en `movements`); nunca confía en lo que el navegador calculó.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;
  const parsed = validateStatementInput(access.body);
  if (!parsed.ok) return json(400, { code: 'INVALID_STATEMENT', field: parsed.field });
  const input = parsed.value;
  const choice = access.body!.apply as { movements?: unknown; cutoff?: unknown; planBalances?: unknown } | undefined;
  const picked = Array.isArray(choice?.movements) ? choice.movements : [];
  if (!picked.every((i) => Number.isSafeInteger(i) && (i as number) >= 0 && (i as number) < input.movements.length) || new Set(picked).size !== picked.length) {
    return json(400, { code: 'INVALID_SELECTION' });
  }

  const db = getDb();
  const { workspace, userId } = access;
  const account = await getAccount(db, workspace.id, input.accountId);
  if (!account || account.archivedAt) return json(404, { code: 'NOT_FOUND' });

  const { comparison, currency } = await runComparison(db, workspace.id, account, input, workspace.defaultCurrency);
  const missing = new Set(comparison.missing);
  const rows = (picked as number[]).map((i) => input.movements[i]!);
  if (rows.some((row) => !missing.has(row))) return json(409, { code: 'NOT_MISSING' });

  const fileName = typeof access.body!.fileName === 'string' && access.body!.fileName.trim() ? access.body!.fileName.trim().slice(0, 160) : 'Estado de cuenta.pdf';
  const saved = await applyStatement(db, { workspaceId: workspace.id, userId, account, currency, fileName: `PDF · ${fileName}`, period: input.period, movements: rows, saveCutoff: choice?.cutoff === true });
  // Saldo pendiente real de cada plan que se reconoció, como al cargar el CSV de planes del banco.
  const planBalances =
    choice?.planBalances === true
      ? await applyReportedBalances(db, workspace.id, userId, input.period.cutoff, [...comparison.plans.matched, ...comparison.plans.differs].map((m) => ({ planId: m.planId, balanceMinor: m.row.pendingMinor })))
      : 0;
  return json(200, { ...saved, cutoff: choice?.cutoff === true, planBalances });
};
