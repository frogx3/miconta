import type { APIRoute } from 'astro';
import { getDb } from '../../../../lib/auth';
import { todayISO } from '../../../../lib/date-format';
import { deleteGoal, getGoal, setGoalArchived, updateGoal } from '../../../../lib/goals/repo';
import { validateGoalEdit } from '../../../../lib/goals/validation';
import { json, requireWorkspaceWithBody, validationError } from '../../../../lib/http';

/** Edita el nombre, la fecha o el monto de una meta, o la archiva/restaura con `{ archived: true|false }`. */
export const PATCH: APIRoute = async ({ request, locals, params }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;
  if (!access.body) return json(400, { code: 'INVALID_JSON' });

  const db = getDb();
  const goal = await getGoal(db, access.workspace.id, params.id!);
  if (!goal) return json(404, { code: 'NOT_FOUND' });

  if (typeof access.body.archived === 'boolean') {
    await setGoalArchived(db, access.workspace.id, goal.id, access.body.archived);
    return json(200, { ok: true });
  }
  const parsed = validateGoalEdit(access.body, goal.type, { locale: locals.locale, currency: goal.currency, todayISO: todayISO() });
  if (!parsed.ok) return validationError(parsed.errors);
  await updateGoal(db, access.workspace.id, goal.id, parsed.value);
  return json(200, { ok: true });
};

export const DELETE: APIRoute = async ({ request, locals, params }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;
  return (await deleteGoal(getDb(), access.workspace.id, params.id!)) ? json(200, { ok: true }) : json(404, { code: 'NOT_FOUND' });
};
