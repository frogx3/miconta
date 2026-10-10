import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/auth';
import { json, requireWorkspaceWithBody, validationError } from '../../../lib/http';
import { setMovementsCategory } from '../../../lib/spending/repo';

const MAX_IDS = 200;

/** Asigna (o quita, con `categoryId: null`) la categoría de uno o varios movimientos. */
export const PATCH: APIRoute = async ({ request, locals }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;

  const { body } = access;
  if (!body) return json(400, { code: 'INVALID_JSON' });
  const { ids, categoryId } = body;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_IDS || !ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 64)) {
    return validationError([{ field: 'ids', code: 'invalid_ids' }]);
  }
  if (categoryId !== null && typeof categoryId !== 'string') return validationError([{ field: 'categoryId', code: 'invalid_category' }]);

  const result = await setMovementsCategory(getDb(), access.workspace.id, [...new Set(ids as string[])], categoryId);
  return result.ok ? json(200, { updated: result.updated }) : json(404, { code: 'CATEGORY_NOT_FOUND' });
};
