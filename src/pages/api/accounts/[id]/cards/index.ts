import type { APIRoute } from 'astro';
import { addCard } from '../../../../../lib/accounts/repo';
import { validateCardInput } from '../../../../../lib/accounts/validation';
import { getDb } from '../../../../../lib/auth';
import { json, requireWorkspaceWithBody, validationError } from '../../../../../lib/http';

export const POST: APIRoute = async ({ request, locals, params }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;

  const { body } = access;
  if (!body) return json(400, { code: 'INVALID_JSON' });
  const parsed = validateCardInput(body, locals.locale);
  if (!parsed.ok) return validationError(parsed.errors);

  const result = await addCard(getDb(), access.workspace.id, params.id!, parsed.value);
  if (result.ok) return json(201, { id: result.id });
  return result.reason === 'duplicate' ? json(409, { code: 'DUPLICATE_CARD' }) : json(404, { code: 'NOT_FOUND' });
};
