import type { APIRoute } from 'astro';
import { getCard, removeCard, setCardArchived, updateCard } from '../../../../../lib/accounts/repo';
import { cardFacts } from '../../../../../lib/accounts/format';
import { validateCardInput } from '../../../../../lib/accounts/validation';
import { getDb } from '../../../../../lib/auth';
import { json, requireWorkspace, requireWorkspaceWithBody, validationError } from '../../../../../lib/http';

/** Actualiza una tarjeta; con `{ "archived": true|false }` la archiva o la restaura. */
export const PATCH: APIRoute = async ({ request, locals, params }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;

  const { body } = access;
  if (!body) return json(400, { code: 'INVALID_JSON' });
  const db = getDb();

  if (typeof body.archived === 'boolean') {
    const found = await setCardArchived(db, access.workspace.id, params.id!, params.cardId!, body.archived);
    return found ? json(200, { ok: true }) : json(404, { code: 'NOT_FOUND' });
  }

  const parsed = validateCardInput(body, locals.locale);
  if (!parsed.ok) return validationError(parsed.errors);

  const result = await updateCard(db, access.workspace.id, params.id!, params.cardId!, parsed.value);
  if (result.ok) {
    const card = await getCard(db, access.workspace.id, params.cardId!);
    return json(200, { ok: true, facts: card ? cardFacts(card, locals.locale) : null });
  }
  return result.reason === 'duplicate' ? json(409, { code: 'DUPLICATE_CARD' }) : json(404, { code: 'NOT_FOUND' });
};

/** Quita una tarjeta sin movimientos ni planes; si tiene historial hay que archivarla. */
export const DELETE: APIRoute = async ({ request, locals, params }) => {
  const access = requireWorkspace(locals, request, { write: true });
  if ('response' in access) return access.response;

  const result = await removeCard(getDb(), access.workspace.id, params.id!, params.cardId!);
  if (result.ok) return json(200, { ok: true });
  return result.reason === 'in_use' ? json(409, { code: 'CARD_IN_USE' }) : json(404, { code: 'NOT_FOUND' });
};
