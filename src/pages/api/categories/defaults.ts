import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/auth';
import { json, requireWorkspaceWithBody } from '../../../lib/http';
import { defaultCategories } from '../../../lib/spending/defaults';
import { seedCategories } from '../../../lib/spending/repo';

/** Crea las categorías sugeridas (en el idioma del usuario) que aún no existan. */
export const POST: APIRoute = async ({ request, locals }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;
  const created = await seedCategories(getDb(), access.workspace.id, defaultCategories(locals.locale));
  return json(201, { created });
};
