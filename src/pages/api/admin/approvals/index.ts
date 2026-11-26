import type { APIRoute } from 'astro';
import { getAuth, getDb } from '../../../../lib/auth';
import { issueAccessCode } from '../../../../lib/auth/access-code';
import { approveRequests, rejectRequests } from '../../../../lib/invitations/repo';
import { sendWelcome, smtpConfig } from '../../../../lib/email/send-access';
import { json, sameOrigin } from '../../../../lib/http';

export const prerender = false;

/** Lote máximo: aprobar manda un correo por persona y cada aprobación es su propia transacción. */
const MAX_IDS = 25;

/**
 * Aprueba o rechaza solicitudes de invitación (una o varias). Aprobar crea el espacio, marca la beta, emite el código de
 * acceso y manda la bienvenida; si el correo falla la aprobación queda hecha y se reenvía desde la ficha del usuario.
 */
export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json(401, { code: 'UNAUTHENTICATED' });
  if (locals.user.role !== 'admin') return json(403, { code: 'FORBIDDEN' });
  if (!sameOrigin(request)) return json(403, { code: 'BAD_ORIGIN' });

  const body = (await request.json().catch(() => null)) as { ids?: unknown; action?: unknown; note?: unknown } | null;
  const ids = Array.isArray(body?.ids) ? [...new Set(body.ids.filter((id): id is string => typeof id === 'string'))] : [];
  if (ids.length === 0 || ids.length > MAX_IDS) return json(400, { code: 'BAD_IDS' });

  const db = getDb();
  if (body?.action === 'reject') {
    const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 500) : null;
    return json(200, { ok: true, rejected: await rejectRequests(db, ids, locals.user.id, note) });
  }
  if (body?.action !== 'approve') return json(400, { code: 'BAD_ACTION' });

  const ctx = await getAuth().$context;
  const approved = await approveRequests(db, ids, locals.user.id, (password) => ctx.password.hash(password));
  const origin = new URL(request.url).origin;
  let emailFailed = 0;
  for (const person of approved) {
    if (!smtpConfig()) {
      emailFailed++;
      continue;
    }
    const { code, expiresAt } = await issueAccessCode(db, person.id);
    try {
      await sendWelcome(person, code, expiresAt, origin);
    } catch (error) {
      console.error('welcome email failed', error);
      emailFailed++;
    }
  }
  return json(200, { ok: true, approved: approved.length, emailFailed });
};
