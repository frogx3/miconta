import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/auth';
import { json, requireWorkspace } from '../../../lib/http';
import { deleteRule } from '../../../lib/spending/repo';

/** Borra la regla. Los movimientos ya categorizados conservan su categoría. */
export const DELETE: APIRoute = async ({ request, locals, params }) => {
  const access = requireWorkspace(locals, request, { write: true });
  if ('response' in access) return access.response;
  const found = await deleteRule(getDb(), access.workspace.id, params.id!);
  return found ? json(200, { ok: true }) : json(404, { code: 'NOT_FOUND' });
};
