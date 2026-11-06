import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/auth';
import { confirmsEmail, json, requireSelfWithBody } from '../../../lib/http';
import { requestDeletion } from '../../../lib/me/lifecycle';

/** Borrar cuenta: queda en stand-by sin acceso; un admin la puede restablecer y a los 30 días se purga. */
export const POST: APIRoute = async ({ request, locals, cookies }) => {
  const access = await requireSelfWithBody(locals, request);
  if ('response' in access) return access.response;
  if (!confirmsEmail(access.body, access.user.email)) return json(400, { code: 'CONFIRM_MISMATCH' });
  const result = await requestDeletion(getDb(), access.user.id);
  if (result === 'has_members') return json(409, { code: 'HAS_MEMBERS' });
  // Las sesiones ya se borraron en la base; la cookie también se va.
  for (const name of ['better-auth.session_token', '__Secure-better-auth.session_token']) cookies.delete(name, { path: '/' });
  return json(200, { ok: true });
};
