import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/auth';
import { json, requireWorkspaceWithBody, validationError } from '../../../lib/http';
import { applyRulesToUncategorized, createRule } from '../../../lib/spending/repo';
import { validateRule } from '../../../lib/spending/validation';

/** Crea una regla ("si el concepto contiene X, va a esta categoría"); con `applyNow` la aplica a lo ya importado. */
export const POST: APIRoute = async ({ request, locals }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;

  const { body } = access;
  if (!body) return json(400, { code: 'INVALID_JSON' });
  const parsed = validateRule(body);
  if (!parsed.ok) return validationError(parsed.errors);

  const db = getDb();
  const result = await createRule(db, access.workspace.id, parsed.value);
  if (!result.ok) return result.reason === 'duplicate' ? json(409, { code: 'DUPLICATE_RULE' }) : json(404, { code: 'CATEGORY_NOT_FOUND' });

  const applied = body.applyNow === true ? await applyRulesToUncategorized(db, access.workspace.id) : 0;
  return json(201, { id: result.id, applied });
};
