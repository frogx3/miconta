import { eq } from 'drizzle-orm';
import type { APIRoute } from 'astro';
import { user as userTable } from '../../../../db/schema';
import { checkDeletion, removeUserWorkspaces } from '../../../../lib/admin/users';
import { getAuth, getDb } from '../../../../lib/auth';

export const prerender = false;

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * Elimina una cuenta de usuario. Solo para administradores y solo si la cuenta no tiene información
 * financiera; si la tiene, responde 409 y la vía es suspenderla. La regla se valida aquí, no en la UI.
 */
export const DELETE: APIRoute = async ({ params, locals, request }) => {
  const actor = locals.user;
  if (!actor) return json(401, { code: 'UNAUTHENTICATED' });
  if (actor.role !== 'admin') return json(403, { code: 'FORBIDDEN' });
  if (request.headers.get('origin') !== new URL(request.url).origin) return json(403, { code: 'BAD_ORIGIN' });

  const userId = params.id!;
  if (userId === actor.id) return json(400, { code: 'CANNOT_DELETE_SELF' });

  const db = getDb();
  const [target] = await db.select({ id: userTable.id }).from(userTable).where(eq(userTable.id, userId)).limit(1);
  if (!target) return json(404, { code: 'NOT_FOUND' });

  const check = await checkDeletion(db, userId);
  if (!check.deletable) return json(409, { code: 'HAS_FINANCIAL_DATA', accounts: check.accounts });

  await removeUserWorkspaces(db, userId);
  await getAuth().api.removeUser({ body: { userId }, headers: request.headers });
  return json(200, { ok: true });
};
