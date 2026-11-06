import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { user } from '../../../db/schema';
import { getDb } from '../../../lib/auth';
import { isTimeZone } from '../../../lib/date-format';
import { json, requireSelfWithBody, validationError } from '../../../lib/http';

/** Preferencias de la persona (no del espacio): avisos dentro de la app y zona horaria. Cada PATCH trae una de las dos. */
export const PATCH: APIRoute = async ({ request, locals }) => {
  const access = await requireSelfWithBody(locals, request);
  if ('response' in access) return access.response;
  const { inAppNotifications, timeZone } = access.body ?? {};
  if (timeZone !== undefined) {
    if (!isTimeZone(timeZone)) return validationError([{ field: 'timeZone', code: 'invalid' }]);
    await getDb().update(user).set({ timeZone }).where(eq(user.id, access.user.id));
    return json(200, { ok: true });
  }
  if (typeof inAppNotifications !== 'boolean') return validationError([{ field: 'inAppNotifications', code: 'invalid' }]);
  await getDb().update(user).set({ inAppNotifications }).where(eq(user.id, access.user.id));
  return json(200, { ok: true });
};
