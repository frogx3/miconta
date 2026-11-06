import type { APIRoute } from 'astro';
import { getDb } from '../../../../lib/auth';
import { archiveBalance } from '../../../../lib/agenda/repo';
import { json, requireWorkspaceWithBody } from '../../../../lib/http';

/** Quita un saldo de "Dinero disponible" (se archiva). */
export const DELETE: APIRoute = async ({ request, locals, params }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;
  return (await archiveBalance(getDb(), access.workspace.id, params.id!)) ? json(200, { ok: true }) : json(404, { code: 'NOT_FOUND' });
};
