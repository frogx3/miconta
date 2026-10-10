import type { APIRoute } from 'astro';
import { getDb } from '../../../../lib/auth';
import { json, requireWorkspaceWithBody, validationError } from '../../../../lib/http';
import { addTagToPlan, removeTagFromPlan, validateTagName } from '../../../../lib/plans/tags';

/** Pone una etiqueta a un plan (la crea si no existe). */
export const POST: APIRoute = async ({ request, locals, params }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;
  if (!access.body) return json(400, { code: 'INVALID_JSON' });
  const name = validateTagName(access.body.name);
  if (!name.ok) return validationError([{ field: 'name', code: name.code }]);

  const result = await addTagToPlan(getDb(), access.workspace.id, params.id!, name.name);
  if (result.ok) return json(200, { tag: result.tag });
  if (result.reason === 'not_found') return json(404, { code: 'NOT_FOUND' });
  return validationError([{ field: 'name', code: result.reason }]);
};

/** Quita una etiqueta de un plan. */
export const DELETE: APIRoute = async ({ request, locals, params }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;
  const tagId = typeof access.body?.tagId === 'string' ? access.body.tagId : '';
  if (!tagId) return json(400, { code: 'INVALID_JSON' });
  return (await removeTagFromPlan(getDb(), access.workspace.id, params.id!, tagId)) ? json(200, { ok: true }) : json(404, { code: 'NOT_FOUND' });
};
