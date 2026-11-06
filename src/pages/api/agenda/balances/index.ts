import type { APIRoute } from 'astro';
import { getDb } from '../../../../lib/auth';
import { findCard, upsertBalance } from '../../../../lib/agenda/repo';
import { validateBalance } from '../../../../lib/agenda/validation';
import { json, requireWorkspaceWithBody, validationError } from '../../../../lib/http';

/** Saldo de hoy de una tarjeta de débito (`cardId`) o de un renglón libre (`label`, con `id` para editarlo). */
export const PUT: APIRoute = async ({ request, locals }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;
  if (!access.body) return json(400, { code: 'INVALID_JSON' });

  const db = getDb();
  const workspaceCurrency = access.workspace.defaultCurrency;
  const cardId = typeof access.body.cardId === 'string' ? access.body.cardId.trim() : '';
  const card = cardId ? await findCard(db, access.workspace.id, cardId) : null;
  if (cardId && (!card || card.kind !== 'debit' || card.archivedAt)) return json(404, { code: 'NOT_FOUND' });
  const parsed = validateBalance(access.body, { locale: locals.locale, currency: card?.currency ?? workspaceCurrency });
  if (!parsed.ok) return validationError(parsed.errors);

  const id = typeof access.body.id === 'string' && access.body.id ? access.body.id : undefined;
  const saved = await upsertBalance(db, access.workspace.id, { ...parsed.value, id, workspaceCurrency });
  return saved ? json(200, { id: saved }) : json(404, { code: 'NOT_FOUND' });
};
