import type { APIRoute } from 'astro';
import { getDb } from '../../../../../lib/auth';
import { undoDone } from '../../../../../lib/agenda/repo';
import { json, requireWorkspaceWithBody } from '../../../../../lib/http';

/** Deshace un "Ya lo pagué": reabre el registro y quita la siguiente ocurrencia si nadie la tocó. */
export const POST: APIRoute = async ({ request, locals, params }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;
  const result = await undoDone(getDb(), access.workspace.id, params.id!);
  if (result === 'not_found') return json(404, { code: 'NOT_FOUND' });
  return result === 'not_done' ? json(409, { code: 'NOT_DONE' }) : json(200, { result });
};
