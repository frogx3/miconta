import { eq } from 'drizzle-orm';
import type { APIRoute } from 'astro';
import { user as userTable } from '../../db/schema';
import { getAuth, getDb } from '../../lib/auth';
import { claimAccessCode } from '../../lib/auth/access-code';
import { json, sameOrigin } from '../../lib/http';

export const prerender = false;

/**
 * Canjea un código de primer acceso: fija la contraseña elegida, da el correo por verificado e inicia sesión.
 * El código se consume antes de tocar la contraseña, así que no se puede canjear dos veces.
 */
export const POST: APIRoute = async ({ request }) => {
  if (!sameOrigin(request)) return json(403, { code: 'BAD_ORIGIN' });
  const body = (await request.json().catch(() => null)) as { code?: unknown; password?: unknown } | null;
  const code = typeof body?.code === 'string' ? body.code : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (password.length < 10 || password.length > 128) return json(400, { code: 'PASSWORD_TOO_SHORT' });

  const db = getDb();
  const userId = await claimAccessCode(db, code);
  if (!userId) return json(400, { code: 'CODE_INVALID' });

  const auth = getAuth();
  const ctx = await auth.$context;
  await ctx.internalAdapter.updatePassword(userId, await ctx.password.hash(password));
  const [target] = await db.update(userTable).set({ emailVerified: true }).where(eq(userTable.id, userId)).returning({ email: userTable.email, role: userTable.role });

  // Inicia sesión con Better Auth y reenvía su cookie; si falla (p. ej. cuenta suspendida), que entre por /login.
  const signIn = await auth.api.signInEmail({ body: { email: target!.email, password }, asResponse: true });
  const response = json(200, { ok: true, next: !signIn.ok ? '/login' : target!.role === 'admin' ? '/admin' : '/app/bienvenida' });
  for (const cookie of signIn.headers.getSetCookie()) response.headers.append('set-cookie', cookie);
  return response;
};
