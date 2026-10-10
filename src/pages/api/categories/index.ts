import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/auth';
import { json, requireWorkspaceWithBody, validationError } from '../../../lib/http';
import { getWorkspaceSettings } from '../../../lib/spending/repo';
import { createCategory } from '../../../lib/spending/repo';
import { validateCategory } from '../../../lib/spending/validation';

export const POST: APIRoute = async ({ request, locals }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;

  const { body } = access;
  if (!body) return json(400, { code: 'INVALID_JSON' });
  // El presupuesto se escribe en la moneda del espacio.
  const { currency } = await getWorkspaceSettings(getDb(), access.workspace.id);
  const parsed = validateCategory(body, { locale: locals.locale, currency });
  if (!parsed.ok) return validationError(parsed.errors);

  const result = await createCategory(getDb(), access.workspace.id, parsed.value);
  return result.ok ? json(201, { id: result.id }) : json(409, { code: 'DUPLICATE_CATEGORY' });
};
