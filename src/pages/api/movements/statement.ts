import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/auth';
import { json, requireWorkspaceWithBody, validationError } from '../../../lib/http';
import { moveToStatement } from '../../../lib/spending/repo';

const MAX_IDS = 200;

/**
 * Contabiliza movimientos en otro corte de su cuenta (`month` = mes en que cierra, `YYYY-MM`) o los devuelve al que les toca
 * por fecha (`month: null`). El banco arma el estado de cuenta por fecha de cargo y el CSV solo trae la de operación.
 */
export const PATCH: APIRoute = async ({ request, locals }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;
  if (!access.body) return json(400, { code: 'INVALID_JSON' });

  const { ids, month } = access.body;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_IDS || !ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 64)) {
    return validationError([{ field: 'ids', code: 'invalid_ids' }]);
  }
  if (month !== null && !(typeof month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(month))) return validationError([{ field: 'month', code: 'invalid_date' }]);

  const result = await moveToStatement(getDb(), access.workspace.id, [...new Set(ids as string[])], month as string | null);
  if (result.ok) return json(200, { updated: result.updated });
  return result.reason === 'not_found' ? json(404, { code: 'NOT_FOUND' }) : json(409, { code: 'INVALID_CUT' });
};
