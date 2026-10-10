import type { APIRoute } from 'astro';
import { getDb } from '../../../../lib/auth';
import { json, requireWorkspaceWithBody, validationError } from '../../../../lib/http';
import { getPlanDetail, updatePlan } from '../../../../lib/plans/repo';
import { validatePlanEdit } from '../../../../lib/plans/validation';

/** Edita a mano los parámetros de un plan; cada cambio queda en el historial con su comentario. */
export const PATCH: APIRoute = async ({ request, locals, params }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;

  const { body } = access;
  if (!body) return json(400, { code: 'INVALID_JSON' });

  const db = getDb();
  const detail = await getPlanDetail(db, access.workspace.id, params.id!);
  if (!detail) return json(404, { code: 'NOT_FOUND' });

  const parsed = validatePlanEdit(body, { locale: locals.locale, currency: detail.plan.currency });
  if (!parsed.ok) return validationError(parsed.errors);

  const result = await updatePlan(db, access.workspace.id, access.userId, params.id!, parsed.value);
  return result.ok ? json(200, { changed: result.changed }) : json(404, { code: 'NOT_FOUND' });
};
