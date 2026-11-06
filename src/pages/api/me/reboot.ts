import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getDb } from '../../../lib/auth';
import { confirmsEmail, json, requireSelfWithBody } from '../../../lib/http';
import { rebootWorkspace } from '../../../lib/me/lifecycle';

/** Reboot: borra toda la información del espacio (no la cuenta, ni los miembros, ni la configuración). Solo el dueño. */
export const POST: APIRoute = async ({ request, locals }) => {
  const access = await requireSelfWithBody(locals, request);
  if ('response' in access) return access.response;
  if (access.workspace.role !== 'owner') return json(403, { code: 'FORBIDDEN_ROLE' });
  if (!confirmsEmail(access.body, access.user.email)) return json(400, { code: 'CONFIRM_MISMATCH' });
  await rebootWorkspace(getDb(), env.FILES, access.workspace.id);
  return json(200, { ok: true });
};
