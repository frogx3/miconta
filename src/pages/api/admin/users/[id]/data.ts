import { eq } from 'drizzle-orm';
import type { APIRoute } from 'astro';
import { user as userTable } from '../../../../../db/schema';
import { checkWipe, wipeUserData } from '../../../../../lib/admin/users';
import { getDb } from '../../../../../lib/auth';

export const prerender = false;

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * Borra todos los datos financieros de un usuario sin eliminarlo. Solo administradores, y no sobre uno
 * mismo; si algún espacio del usuario es compartido responde 409 para no tocar los datos de otras personas.
 */
export const DELETE: APIRoute = async ({ params, locals, request }) => {
  const actor = locals.user;
  if (!actor) return json(401, { code: 'UNAUTHENTICATED' });
  if (actor.role !== 'admin') return json(403, { code: 'FORBIDDEN' });
  if (request.headers.get('origin') !== new URL(request.url).origin) return json(403, { code: 'BAD_ORIGIN' });

  const userId = params.id!;
  if (userId === actor.id) return json(400, { code: 'CANNOT_WIPE_SELF' });

  const db = getDb();
  const [target] = await db.select({ id: userTable.id }).from(userTable).where(eq(userTable.id, userId)).limit(1);
  if (!target) return json(404, { code: 'NOT_FOUND' });

  const check = await checkWipe(db, userId);
  if (check.sharedWorkspaces > 0) return json(409, { code: 'SHARED_WORKSPACE', sharedWorkspaces: check.sharedWorkspaces });

  await wipeUserData(db, userId);
  return json(200, { ok: true });
};
