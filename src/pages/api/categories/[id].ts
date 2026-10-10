import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/auth';
import { json, requireWorkspace, requireWorkspaceWithBody, validationError } from '../../../lib/http';
import { getWorkspaceSettings } from '../../../lib/spending/repo';
import { deleteCategory, updateCategory } from '../../../lib/spending/repo';
import { validateCategory } from '../../../lib/spending/validation';

export const PATCH: APIRoute = async ({ request, locals, params }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;

  const { body } = access;
  if (!body) return json(400, { code: 'INVALID_JSON' });
  // El presupuesto se escribe en la moneda del espacio.
  const { currency } = await getWorkspaceSettings(getDb(), access.workspace.id);
  const parsed = validateCategory(body, { locale: locals.locale, currency });
  if (!parsed.ok) return validationError(parsed.errors);

  const result = await updateCategory(getDb(), access.workspace.id, params.id!, parsed.value);
  if (result.ok) return json(200, { ok: true });
  return result.reason === 'duplicate' ? json(409, { code: 'DUPLICATE_CATEGORY' }) : json(404, { code: 'NOT_FOUND' });
};

/** Elimina la categoría: sus movimientos quedan sin categoría y sus reglas se borran. */
export const DELETE: APIRoute = async ({ request, locals, params }) => {
  const access = requireWorkspace(locals, request, { write: true });
  if ('response' in access) return access.response;
  const found = await deleteCategory(getDb(), access.workspace.id, params.id!);
  return found ? json(200, { ok: true }) : json(404, { code: 'NOT_FOUND' });
};
