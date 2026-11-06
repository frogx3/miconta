import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getDb } from '../../../../../lib/auth';
import { json, sameOrigin } from '../../../../../lib/http';
import { purgeUser, restoreUser } from '../../../../../lib/me/lifecycle';

export const prerender = false;

/** Lee el cuerpo antes de decidir: responder sin consumirlo corta la conexión en desarrollo (500 `fetch failed`). */
async function guard(locals: App.Locals, request: Request): Promise<Response | null> {
  await request.text();
  if (!locals.user) return json(401, { code: 'UNAUTHENTICATED' });
  if (locals.user.role !== 'admin') return json(403, { code: 'FORBIDDEN' });
  if (!sameOrigin(request)) return json(403, { code: 'BAD_ORIGIN' });
  return null;
}

/** Restablece una cuenta que su dueño borró (sigue en stand-by): vuelve a tener acceso con su misma contraseña. */
export const POST: APIRoute = async ({ params, locals, request }) => {
  const denied = await guard(locals, request);
  if (denied) return denied;
  return (await restoreUser(getDb(), params.id!)) ? json(200, { ok: true }) : json(404, { code: 'NOT_FOUND' });
};

/** Elimina para siempre una cuenta en stand-by (lo mismo que hace el cron a los 30 días). */
export const DELETE: APIRoute = async ({ params, locals, request }) => {
  const denied = await guard(locals, request);
  if (denied) return denied;
  const result = await purgeUser(getDb(), env.FILES, params.id!);
  return result === 'not_pending' ? json(404, { code: 'NOT_FOUND' }) : json(200, { ok: true, result });
};
