import type { APIRoute } from 'astro';
import { getDb } from '../../../../lib/auth';
import { json, requireWorkspaceWithBody, validationError } from '../../../../lib/http';
import { settlePlan } from '../../../../lib/plans/repo';

/** Liquida a mano un plan pagado por otra vía. El comentario (cómo se liquidó) es obligatorio. */
export const POST: APIRoute = async ({ request, locals, params }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;

  const { body } = access;
  if (!body) return json(400, { code: 'INVALID_JSON' });
  const comment = typeof body.comment === 'string' ? body.comment.trim() : '';
  if (!comment) return validationError([{ field: 'comment', code: 'required' }]);
  if (comment.length > 500) return validationError([{ field: 'comment', code: 'too_long' }]);

  const result = await settlePlan(getDb(), access.workspace.id, access.userId, params.id!, comment);
  if (result.ok) return json(200, { ok: true });
  return result.reason === 'not_found' ? json(404, { code: 'NOT_FOUND' }) : json(409, { code: 'INVALID_STATE' });
};
