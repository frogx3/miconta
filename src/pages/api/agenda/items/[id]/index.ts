import type { APIRoute } from 'astro';
import { getDb } from '../../../../../lib/auth';
import { cancelItem, getItem, updateItem } from '../../../../../lib/agenda/repo';
import { validateItem } from '../../../../../lib/agenda/validation';
import { json, requireWorkspace, requireWorkspaceWithBody, validationError } from '../../../../../lib/http';

/** Edita un pago o cobro; el monto se lee en la moneda del registro. */
export const PATCH: APIRoute = async ({ request, locals, params }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;
  if (!access.body) return json(400, { code: 'INVALID_JSON' });

  const db = getDb();
  const item = await getItem(db, access.workspace.id, params.id!);
  if (!item) return json(404, { code: 'NOT_FOUND' });
  const parsed = validateItem(access.body, { locale: locals.locale, currency: item.currency });
  if (!parsed.ok) return validationError(parsed.errors);
  await updateItem(db, access.workspace.id, item.id, parsed.value);
  return json(200, { ok: true });
};

/** Cancela esta ocurrencia (solo pendientes). */
export const DELETE: APIRoute = async ({ request, locals, params }) => {
  const access = requireWorkspace(locals, request, { write: true });
  if ('response' in access) return access.response;
  return (await cancelItem(getDb(), access.workspace.id, params.id!)) ? json(200, { ok: true }) : json(404, { code: 'NOT_FOUND' });
};
