import type { APIRoute } from 'astro';
import { setAccountArchived, updateAccount } from '../../../../lib/accounts/repo';
import { validateAccountInput } from '../../../../lib/accounts/validation';
import { getDb } from '../../../../lib/auth';
import { json, requireWorkspaceWithBody, validationError } from '../../../../lib/http';

/**
 * Actualiza una cuenta. Con `{ "archived": true|false }` la archiva o la restaura; no hay borrado:
 * una cuenta archivada se oculta pero conserva todo su historial.
 */
export const PATCH: APIRoute = async ({ request, locals, params }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;

  const { body } = access;
  if (!body) return json(400, { code: 'INVALID_JSON' });
  const db = getDb();
  const accountId = params.id!;

  if (typeof body.archived === 'boolean') {
    const found = await setAccountArchived(db, access.workspace.id, accountId, body.archived);
    return found ? json(200, { ok: true }) : json(404, { code: 'NOT_FOUND' });
  }

  const parsed = validateAccountInput(body);
  if (!parsed.ok) return validationError(parsed.errors);
  const found = await updateAccount(db, access.workspace.id, accountId, parsed.value);
  return found ? json(200, { ok: true }) : json(404, { code: 'NOT_FOUND' });
};
