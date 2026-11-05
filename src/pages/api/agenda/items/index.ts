import type { APIRoute } from 'astro';
import { getDb } from '../../../../lib/auth';
import { createItem } from '../../../../lib/agenda/repo';
import { validateItem } from '../../../../lib/agenda/validation';
import { json, requireWorkspaceWithBody, validationError } from '../../../../lib/http';

/** Crea un pago o cobro en la moneda del espacio. */
export const POST: APIRoute = async ({ request, locals }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;
  if (!access.body) return json(400, { code: 'INVALID_JSON' });

  const currency = access.workspace.defaultCurrency;
  const parsed = validateItem(access.body, { locale: locals.locale, currency });
  if (!parsed.ok) return validationError(parsed.errors);
  return json(201, { id: await createItem(getDb(), access.workspace.id, currency, parsed.value) });
};
