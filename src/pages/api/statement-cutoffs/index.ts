import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/auth';
import { json, requireWorkspaceWithBody, validationError } from '../../../lib/http';
import { listCards } from '../../../lib/accounts/repo';
import { deleteCutoff, saveCutoff } from '../../../lib/spending/repo';
import { validateCutoff } from '../../../lib/spending/validation';

/** Guarda el corte real de una cuenta, tomado de su estado de cuenta; con `id` edita ese corte (también su fecha). */
export const POST: APIRoute = async ({ request, locals }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;
  if (!access.body) return json(400, { code: 'INVALID_JSON' });

  const db = getDb();
  // El monto oficial se escribe en la moneda de las tarjetas de crédito de la cuenta.
  const accountCards = (await listCards(db, access.workspace.id)).filter((card) => card.accountId === access.body!.accountId && card.kind === 'credit');
  const currency = accountCards[0]?.currency ?? access.workspace.defaultCurrency;
  const parsed = validateCutoff(access.body, locals.locale, currency);
  if (!parsed.ok) return validationError(parsed.errors);

  const recordId = typeof access.body.id === 'string' && access.body.id ? access.body.id : undefined;
  const saved = await saveCutoff(db, access.workspace.id, parsed.value, recordId);
  if (saved.ok) return json(200, { ok: true });
  return saved.reason === 'not_found' ? json(404, { code: 'NOT_FOUND' }) : validationError([{ field: 'cutoffDate', code: 'month_taken' }]);
};

/** Quita un corte capturado. */
export const DELETE: APIRoute = async ({ request, locals }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;
  const id = typeof access.body?.id === 'string' ? access.body.id : '';
  if (!id) return json(400, { code: 'INVALID_JSON' });
  return (await deleteCutoff(getDb(), access.workspace.id, id)) ? json(200, { ok: true }) : json(404, { code: 'NOT_FOUND' });
};
