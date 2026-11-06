import type { APIRoute } from 'astro';
import { and, eq } from 'drizzle-orm';
import { pushSubscriptions } from '../../../db/schema';
import { t } from '../../../i18n/messages';
import { getDb } from '../../../lib/auth';
import { json, parseJsonObject, sameOrigin } from '../../../lib/http';
import { parseSubscription, sendPush, vapidConfig } from '../../../lib/push/webpush';

/** Notificaciones del usuario en este navegador (no del espacio). Lee el cuerpo antes de rechazar. */
async function access(request: Request, locals: App.Locals) {
  const body = parseJsonObject(await request.text());
  const cfg = vapidConfig();
  if (!cfg) return json(404, { code: 'NOT_FOUND' });
  if (!locals.user) return json(401, { code: 'UNAUTHENTICATED' });
  if (!sameOrigin(request)) return json(403, { code: 'BAD_ORIGIN' });
  return { cfg, userId: locals.user.id, body };
}

/** Guarda la suscripción del navegador (`PushSubscription.toJSON()`) y manda una notificación de bienvenida. */
export const POST: APIRoute = async ({ request, locals }) => {
  const result = await access(request, locals);
  if (result instanceof Response) return result;
  const sub = parseSubscription(result.body);
  if (!sub) return json(400, { code: 'VALIDATION', errors: [{ field: 'subscription', code: 'invalid' }] });
  // Un endpoint es de un solo navegador: si otro usuario inició sesión en él, la suscripción pasa al actual.
  await getDb()
    .insert(pushSubscriptions)
    .values({ userId: result.userId, ...sub })
    .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { userId: result.userId, p256dh: sub.p256dh, auth: sub.auth } });
  const { locale } = locals;
  const sent = await sendPush(result.cfg, sub, { title: t(locale, 'push.welcome.title'), body: t(locale, 'push.welcome.body'), url: '/app/agenda' }, new Date());
  if (sent.ok) return json(200, { ok: true });
  console.error('push: bienvenida falló', sent.error);
  if (!sent.gone) return json(200, { ok: true });
  // El servicio de push ya no la reconoce: no se guarda y el navegador la descarta.
  await getDb().delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, sub.endpoint));
  return json(410, { code: 'SUBSCRIPTION_GONE' });
};

/** Quita la suscripción de este navegador: `{ endpoint }`. */
export const DELETE: APIRoute = async ({ request, locals }) => {
  const result = await access(request, locals);
  if (result instanceof Response) return result;
  if (typeof result.body?.endpoint !== 'string') return json(400, { code: 'VALIDATION', errors: [{ field: 'endpoint', code: 'required' }] });
  await getDb().delete(pushSubscriptions).where(and(eq(pushSubscriptions.endpoint, result.body.endpoint), eq(pushSubscriptions.userId, result.userId)));
  return json(200, { ok: true });
};
