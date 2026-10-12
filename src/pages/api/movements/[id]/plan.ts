import type { APIRoute } from 'astro';
import { getDb } from '../../../../lib/auth';
import { json, requireWorkspaceWithBody, validationError } from '../../../../lib/http';
import { createPlanFromMovement } from '../../../../lib/plans/repo';

/** Convierte un movimiento ya cargado en un plan (MSI, meses con intereses o pago fijo). */
export const POST: APIRoute = async ({ request, locals, params }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;
  if (!access.body) return json(400, { code: 'INVALID_JSON' });

  const result = await createPlanFromMovement(getDb(), access.workspace.id, access.userId, params.id!, access.body, locals.locale);
  if (result.ok) return json(201, { planId: result.planId });
  if (result.reason === 'invalid') return validationError(result.errors);
  if (result.reason === 'not_found') return json(404, { code: 'NOT_FOUND' });
  return json(409, { code: result.reason === 'card_required' ? 'CARD_REQUIRED' : 'NOT_CONVERTIBLE' });
};
