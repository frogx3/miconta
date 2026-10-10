import type { APIRoute } from 'astro';
import { createAccount } from '../../../lib/accounts/repo';
import { validateAccountInput } from '../../../lib/accounts/validation';
import { getDb } from '../../../lib/auth';
import { json, requireWorkspaceWithBody, validationError } from '../../../lib/http';

export const POST: APIRoute = async ({ request, locals }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;

  const { body } = access;
  if (!body) return json(400, { code: 'INVALID_JSON' });
  const parsed = validateAccountInput(body);
  if (!parsed.ok) return validationError(parsed.errors);

  const id = await createAccount(getDb(), access.workspace.id, parsed.value);
  return json(201, { id });
};
