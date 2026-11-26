import { eq } from 'drizzle-orm';
import type { APIRoute } from 'astro';
import { user as userTable } from '../../../db/schema';
import { getDb } from '../../../lib/auth';
import { allowAttempt, createRequest } from '../../../lib/invitations/repo';
import { checkInvitationRequest } from '../../../lib/invitations/validation';
import { sendAdminNewRequest, sendRequestReceived, smtpConfig } from '../../../lib/email/send-access';
import { json, sameOrigin, validationError } from '../../../lib/http';

export const prerender = false;

/** Intentos por IP: suficientes para corregir un dato, pocos para llenar la lista a mano. */
const MAX_PER_HOUR = 5;

/**
 * «Pide tu invitación» de la landing (público, sin sesión). Guarda la solicitud como usuario pendiente y avisa al
 * admin. Si el correo ya existe responde igual que si fuera nuevo, para no revelar quién está registrado.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  if (!sameOrigin(request)) return json(403, { code: 'BAD_ORIGIN' });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return json(400, { code: 'BAD_REQUEST' });

  const check = checkInvitationRequest(body);
  // A un bot se le responde como a cualquiera: así no aprende a esquivar la trampa.
  if (!check.ok && check.bot) return json(200, { ok: true });
  if (!check.ok) return validationError(check.errors);

  const db = getDb();
  const ip = request.headers.get('cf-connecting-ip') ?? 'local';
  if (!(await allowAttempt(db, `invitations:${ip}`, MAX_PER_HOUR, 3_600_000))) return json(429, { code: 'TOO_MANY_REQUESTS' });

  const created = await createRequest(db, check.value, locals.locale);
  if (created && smtpConfig()) {
    const origin = new URL(request.url).origin;
    const admins = await db.select({ name: userTable.name, email: userTable.email, locale: userTable.locale }).from(userTable).where(eq(userTable.role, 'admin'));
    // La solicitud ya quedó guardada: si un correo falla, el admin la ve igual en «Por aprobar».
    await Promise.allSettled([
      sendRequestReceived({ ...check.value, locale: locals.locale }, origin),
      sendAdminNewRequest(admins, check.value, origin),
    ]).then((results) => results.forEach((result) => result.status === 'rejected' && console.error('invitation email failed', result.reason)));
  }
  return json(200, { ok: true });
};
