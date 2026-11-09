import { eq } from 'drizzle-orm';
import type { APIRoute } from 'astro';
import { user as userTable } from '../../../../../db/schema';
import { getDb } from '../../../../../lib/auth';
import { issueAccessCode } from '../../../../../lib/auth/access-code';
import { sendAccessCode } from '../../../../../lib/email/send-access';
import { json, sameOrigin } from '../../../../../lib/http';

export const prerender = false;

/** Manda por correo un código de primer acceso nuevo (48 h); el anterior sin usar deja de valer. Solo administradores. */
export const POST: APIRoute = async ({ params, locals, request }) => {
  if (!locals.user) return json(401, { code: 'UNAUTHENTICATED' });
  if (locals.user.role !== 'admin') return json(403, { code: 'FORBIDDEN' });
  if (!sameOrigin(request)) return json(403, { code: 'BAD_ORIGIN' });

  const db = getDb();
  const [target] = await db.select().from(userTable).where(eq(userTable.id, params.id!)).limit(1);
  if (!target || target.deletedAt) return json(404, { code: 'NOT_FOUND' });

  const { code, expiresAt } = await issueAccessCode(db, target.id);
  try {
    await sendAccessCode(target, code, expiresAt, new URL(request.url).origin);
  } catch (error) {
    console.error('access-code email failed', error);
    return json(502, { code: 'EMAIL_FAILED' });
  }
  return json(200, { ok: true, email: target.email, expiresAt: expiresAt.toISOString() });
};
