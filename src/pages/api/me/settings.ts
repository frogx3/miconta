import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { user } from '../../../db/schema';
import { getDb } from '../../../lib/auth';
import { json, requireSelfWithBody, validationError } from '../../../lib/http';

/** Preferencias de la persona (no del espacio): por ahora, si ve los avisos dentro de la app. */
export const PATCH: APIRoute = async ({ request, locals }) => {
  const access = await requireSelfWithBody(locals, request);
  if ('response' in access) return access.response;
  const value = access.body?.inAppNotifications;
  if (typeof value !== 'boolean') return validationError([{ field: 'inAppNotifications', code: 'invalid' }]);
  await getDb().update(user).set({ inAppNotifications: value }).where(eq(user.id, access.user.id));
  return json(200, { ok: true });
};
