import type { APIRoute } from 'astro';
import { getDb } from '../../../../../lib/auth';
import { markDone } from '../../../../../lib/agenda/repo';
import { json, requireWorkspaceWithBody } from '../../../../../lib/http';

/** "Ya lo pagué / Ya lo cobré". Marcarlo dos veces responde `already`. */
export const POST: APIRoute = async ({ request, locals, params }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;
  const result = await markDone(getDb(), access.workspace.id, params.id!, { userId: access.userId, via: 'web' });
  return result === 'not_found' ? json(404, { code: 'NOT_FOUND' }) : json(200, { result });
};
