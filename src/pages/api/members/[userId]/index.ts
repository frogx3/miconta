import type { APIRoute } from 'astro';
import { getDb } from '../../../../lib/auth';
import { json, requireWorkspaceWithBody, validationError } from '../../../../lib/http';
import { changeMemberRole, removeMember, type MemberResult } from '../../../../lib/members/repo';
import { isInviteRole } from '../../../../lib/members/roles';

const answer = (result: MemberResult) => (result.ok ? json(200, { ok: true }) : result.reason === 'not_found' ? json(404, { code: 'NOT_FOUND' }) : json(403, { code: 'FORBIDDEN_ROLE' }));

/** Cambia el rol de un miembro (nunca a dueño; el dueño no se toca). */
export const PATCH: APIRoute = async ({ request, locals, params }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;
  if (!access.body) return json(400, { code: 'INVALID_JSON' });
  if (!isInviteRole(access.body.role)) return validationError([{ field: 'role', code: 'invalid_role' }]);
  return answer(await changeMemberRole(getDb(), access.workspace.id, access.workspace.role, params.userId!, access.body.role));
};

/** Saca a un miembro del espacio; conserva todo lo que registró y le deja un espacio propio vacío. */
export const DELETE: APIRoute = async ({ request, locals, params }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;
  if (params.userId === access.userId) return json(403, { code: 'FORBIDDEN_ROLE' });
  return answer(await removeMember(getDb(), access.workspace.id, access.workspace.role, params.userId!));
};
