import type { APIRoute } from 'astro';
import { getDb } from '../../../../lib/auth';
import { json, requireWorkspaceWithBody, validationError } from '../../../../lib/http';
import { createInvitation, revokeInvitation } from '../../../../lib/members/repo';
import { INVITE_DAYS, invitableRoles, isInviteRole } from '../../../../lib/members/roles';

/** Crea una invitación. El enlace con el token solo se devuelve aquí: después no se puede volver a ver. */
export const POST: APIRoute = async ({ request, locals }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;
  const allowed = invitableRoles(access.workspace.role);
  if (allowed.length === 0) return json(403, { code: 'FORBIDDEN_ROLE' });

  const { body } = access;
  if (!body) return json(400, { code: 'INVALID_JSON' });
  if (!isInviteRole(body.role) || !allowed.includes(body.role)) return validationError([{ field: 'role', code: 'invalid_role' }]);
  const days = Number(body.days);
  if (!(INVITE_DAYS as readonly number[]).includes(days)) return validationError([{ field: 'days', code: 'invalid_days' }]);

  const { token, expiresAt } = await createInvitation(getDb(), access.workspace.id, access.userId, body.role, days);
  return json(201, { url: `${new URL(request.url).origin}/invitacion/${token}`, expiresAt: expiresAt.toISOString() });
};

export const DELETE: APIRoute = async ({ request, locals }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;
  if (invitableRoles(access.workspace.role).length === 0) return json(403, { code: 'FORBIDDEN_ROLE' });
  const id = typeof access.body?.id === 'string' ? access.body.id : '';
  if (!id) return json(400, { code: 'INVALID_JSON' });
  return (await revokeInvitation(getDb(), access.workspace.id, id)) ? json(200, { ok: true }) : json(404, { code: 'NOT_FOUND' });
};
