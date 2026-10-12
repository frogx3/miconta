import type { APIRoute } from 'astro';
import { getDb } from '../../../../../lib/auth';
import { json, requireWorkspaceWithBody, validationError } from '../../../../../lib/http';
import { setBatchPeriod } from '../../../../../lib/import/batches';

/** Define el periodo (fecha de corte y primer día) del estado de cuenta de una carga. */
export const PATCH: APIRoute = async ({ request, locals, params }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;
  if (!access.body) return json(400, { code: 'INVALID_JSON' });

  const cutoffDate = typeof access.body.cutoffDate === 'string' ? access.body.cutoffDate.trim() : '';
  const startDate = typeof access.body.startDate === 'string' ? access.body.startDate.trim() : '';
  const result = await setBatchPeriod(getDb(), access.workspace.id, params.id!, { cutoffDate, startDate: startDate || null });
  if (result.ok) return json(200, { ok: true });
  if (result.reason === 'not_found') return json(404, { code: 'NOT_FOUND' });
  return validationError([{ field: result.reason === 'invalid_cutoff' ? 'cutoffDate' : 'startDate', code: result.reason === 'invalid_cutoff' ? 'invalid_date' : 'invalid_range' }]);
};
