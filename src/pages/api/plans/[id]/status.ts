import type { APIRoute } from 'astro';
import { getDb } from '../../../../lib/auth';
import { json, requireWorkspaceWithBody, validationError } from '../../../../lib/http';
import { changeStatus } from '../../../../lib/plans/repo';

/** Marca o quita "por revisar" y reabre un plan liquidado a mano (`to: "active" | "review"`). */
export const POST: APIRoute = async ({ request, locals, params }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;

  const { body } = access;
  if (!body) return json(400, { code: 'INVALID_JSON' });
  if (body.to !== 'active' && body.to !== 'review') return validationError([{ field: 'to', code: 'invalid_kind' }]);
  const comment = typeof body.comment === 'string' ? body.comment.trim() : '';
  if (comment.length > 500) return validationError([{ field: 'comment', code: 'too_long' }]);

  const result = await changeStatus(getDb(), access.workspace.id, access.userId, params.id!, body.to, comment || null);
  if (result.ok) return json(200, { ok: true });
  return result.reason === 'not_found' ? json(404, { code: 'NOT_FOUND' }) : json(409, { code: 'INVALID_STATE' });
};
