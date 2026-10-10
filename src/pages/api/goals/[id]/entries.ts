import type { APIRoute } from 'astro';
import { getDb } from '../../../../lib/auth';
import { todayISO } from '../../../../lib/date-format';
import { addEntry, deleteEntry, getGoal } from '../../../../lib/goals/repo';
import { validateEntry } from '../../../../lib/goals/validation';
import { json, requireWorkspaceWithBody, validationError } from '../../../../lib/http';

/** Registra un aporte (o un retiro, en negativo) de una meta de ahorro. */
export const POST: APIRoute = async ({ request, locals, params }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;
  if (!access.body) return json(400, { code: 'INVALID_JSON' });

  const db = getDb();
  const goal = await getGoal(db, access.workspace.id, params.id!);
  if (!goal) return json(404, { code: 'NOT_FOUND' });
  const parsed = validateEntry(access.body, { locale: locals.locale, currency: goal.currency, todayISO: todayISO() });
  if (!parsed.ok) return validationError(parsed.errors);

  const result = await addEntry(db, access.workspace.id, access.userId, goal.id, parsed.value);
  if (result.ok) return json(201, { id: result.id });
  return result.reason === 'not_found' ? json(404, { code: 'NOT_FOUND' }) : json(409, { code: 'NOT_SAVINGS' });
};

export const DELETE: APIRoute = async ({ request, locals, params }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;
  const entryId = typeof access.body?.entryId === 'string' ? access.body.entryId : '';
  if (!entryId) return json(400, { code: 'INVALID_JSON' });
  return (await deleteEntry(getDb(), access.workspace.id, params.id!, entryId)) ? json(200, { ok: true }) : json(404, { code: 'NOT_FOUND' });
};
