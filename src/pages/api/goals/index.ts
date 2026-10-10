import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/auth';
import { createGoal } from '../../../lib/goals/repo';
import { validateGoal } from '../../../lib/goals/validation';
import { json, requireWorkspaceWithBody, validationError } from '../../../lib/http';
import { todayISO } from '../../../lib/date-format';

/** Crea una meta. Los montos se escriben en la moneda del espacio. */
export const POST: APIRoute = async ({ request, locals }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;
  if (!access.body) return json(400, { code: 'INVALID_JSON' });

  const currency = access.workspace.defaultCurrency;
  const parsed = validateGoal(access.body, { locale: locals.locale, currency, todayISO: todayISO() });
  if (!parsed.ok) return validationError(parsed.errors);

  const result = await createGoal(getDb(), access.workspace.id, access.userId, currency, parsed.value);
  return result.ok ? json(201, { id: result.id }) : validationError([{ field: 'planId', code: 'invalid_plan' }]);
};
