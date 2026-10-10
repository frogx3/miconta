import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/auth';
import { json, requireWorkspaceWithBody } from '../../../lib/http';
import { applyRulesToUncategorized } from '../../../lib/spending/repo';

/** Aplica las reglas a los cargos que todavía no tienen categoría. */
export const POST: APIRoute = async ({ request, locals }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;
  return json(200, { applied: await applyRulesToUncategorized(getDb(), access.workspace.id) });
};
