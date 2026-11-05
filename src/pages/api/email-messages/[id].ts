import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getDb } from '../../../lib/auth';
import { reviewMessage } from '../../../lib/email/inbound';
import { json, requireWorkspaceWithBody, validationError } from '../../../lib/http';

/** Aplica (`{ "action": "apply", "trustDomain": true }`) o descarta un correo pendiente de la bitácora. */
export const POST: APIRoute = async ({ request, locals, params }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;
  const action = access.body?.action;
  if (action !== 'apply' && action !== 'dismiss') return validationError([{ field: 'action', code: 'invalid_action' }]);

  const result = await reviewMessage(getDb(), env.FILES, access.workspace.id, params.id!, action, access.body?.trustDomain === true);
  if (!result.ok) return json(result.code === 'NOT_FOUND' ? 404 : 409, { code: result.code });
  return json(200, { status: result.status });
};
