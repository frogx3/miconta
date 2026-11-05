import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { user } from '../../../../db/schema';
import { getDb } from '../../../../lib/auth';
import { whatsappEnabled } from '../../../../lib/agenda/whatsapp';
import { json, parseJsonObject, sameOrigin } from '../../../../lib/http';

/** Preferencias de WhatsApp del usuario (no del espacio: también para `viewer`). Lee el cuerpo antes de rechazar. */
async function access(request: Request, locals: App.Locals): Promise<{ userId: string; body: Record<string, unknown> | null } | Response> {
  const body = parseJsonObject(await request.text());
  if (!whatsappEnabled()) return json(404, { code: 'NOT_FOUND' });
  if (!locals.user) return json(401, { code: 'UNAUTHENTICATED' });
  if (!sameOrigin(request)) return json(403, { code: 'BAD_ORIGIN' });
  return { userId: locals.user.id, body };
}

/** Pausa o reactiva los avisos: `{ optIn: boolean }`. */
export const PATCH: APIRoute = async ({ request, locals }) => {
  const result = await access(request, locals);
  if (result instanceof Response) return result;
  if (typeof result.body?.optIn !== 'boolean') return json(400, { code: 'VALIDATION', errors: [{ field: 'optIn', code: 'required' }] });
  await getDb().update(user).set({ whatsappOptIn: result.body.optIn }).where(eq(user.id, result.userId));
  return json(200, { optIn: result.body.optIn });
};

/** Desvincula el número. */
export const DELETE: APIRoute = async ({ request, locals }) => {
  const result = await access(request, locals);
  if (result instanceof Response) return result;
  await getDb().update(user).set({ whatsappPhone: null, whatsappVerifiedAt: null, whatsappOptIn: true }).where(eq(user.id, result.userId));
  return json(200, { ok: true });
};
