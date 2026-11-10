import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/auth';
import { findCard, materializeCardPayment } from '../../../lib/agenda/repo';
import { validateCardPayment } from '../../../lib/agenda/validation';
import { json, requireWorkspaceWithBody, validationError } from '../../../lib/http';
import { todayISO } from '../../../lib/date-format';

/** Ajusta, paga o cancela un pago de tarjeta sugerido; la primera acción lo guarda como registro. */
export const POST: APIRoute = async ({ request, locals }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;
  if (!access.body) return json(400, { code: 'INVALID_JSON' });

  const db = getDb();
  const cardId = typeof access.body.cardId === 'string' ? access.body.cardId : '';
  const card = cardId ? await findCard(db, access.workspace.id, cardId) : null;
  if (!card || card.kind !== 'credit') return json(404, { code: 'NOT_FOUND' });
  const parsed = validateCardPayment(access.body, { locale: locals.locale, currency: card.currency });
  if (!parsed.ok) return validationError(parsed.errors);

  const result = await materializeCardPayment(db, access.workspace.id, { cardId, ...parsed.value, by: { userId: access.userId, via: 'web', date: todayISO(locals.timeZone) } });
  return result ? json(200, result) : json(404, { code: 'NOT_FOUND' });
};
