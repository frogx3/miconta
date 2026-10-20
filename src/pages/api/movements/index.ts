import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/auth';
import { json, requireWorkspaceWithBody, validationError } from '../../../lib/http';
import { getCard } from '../../../lib/accounts/repo';
import { createManualMovement } from '../../../lib/spending/manual';
import { setMovementsCategory } from '../../../lib/spending/repo';
import { parseMovementAmount, validateMovement } from '../../../lib/spending/validation';

const MAX_IDS = 200;

/** Asigna (o quita, con `categoryId: null`) la categoría de uno o varios movimientos. */
export const PATCH: APIRoute = async ({ request, locals }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;

  const { body } = access;
  if (!body) return json(400, { code: 'INVALID_JSON' });
  const { ids, categoryId } = body;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_IDS || !ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 64)) {
    return validationError([{ field: 'ids', code: 'invalid_ids' }]);
  }
  if (categoryId !== null && typeof categoryId !== 'string') return validationError([{ field: 'categoryId', code: 'invalid_category' }]);

  const result = await setMovementsCategory(getDb(), access.workspace.id, [...new Set(ids as string[])], categoryId);
  return result.ok ? json(200, { updated: result.updated }) : json(404, { code: 'CATEGORY_NOT_FOUND' });
};

/** Captura un movimiento a mano en una tarjeta; puede crear la categoría en el mismo paso. */
export const POST: APIRoute = async ({ request, locals }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;
  if (!access.body) return json(400, { code: 'INVALID_JSON' });

  const parsed = validateMovement(access.body);
  if (!parsed.ok) return validationError(parsed.errors);
  const value = parsed.value;

  const db = getDb();
  const card = await getCard(db, access.workspace.id, value.cardId);
  if (!card || card.archivedAt) return validationError([{ field: 'cardId', code: 'invalid_card' }]);
  const amountMinor = parseMovementAmount(value.amountInput, locals.locale, card.currency);
  if (amountMinor === null) return validationError([{ field: 'amount', code: 'invalid_amount' }]);

  const result = await createManualMovement(db, access.workspace.id, access.userId, {
    accountId: card.accountId,
    cardId: card.id,
    currency: card.currency,
    date: value.date,
    description: value.description,
    kind: value.kind,
    amountMinor,
    categoryId: value.categoryId,
    newCategory: value.newCategory,
  });
  return result.ok ? json(201, { id: result.id }) : validationError([{ field: 'categoryId', code: 'invalid_category' }]);
};
