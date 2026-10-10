import type { APIRoute } from 'astro';
import { getDb } from '../../../../../lib/auth';
import { json, requireWorkspaceWithBody } from '../../../../../lib/http';
import { revertBatch } from '../../../../../lib/import/batches';

/**
 * Deshace una carga de importación: elimina sus movimientos y los planes que creó, y devuelve a su
 * estado anterior los que avanzó. Solo la última carga de cada tarjeta, y solo si ningún plan cambió
 * después; si no, responde 409 con el motivo y no toca nada.
 */
export const POST: APIRoute = async ({ request, locals, params }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;

  let result: Awaited<ReturnType<typeof revertBatch>>;
  try {
    result = await revertBatch(getDb(), access.workspace.id, access.userId, params.id!);
  } catch (error) {
    // La reversión es una sola transacción: si algo falla no se toca nada.
    console.error('revert failed', error);
    return json(500, { code: 'REVERT_FAILED' });
  }
  if (result.ok) return json(200, { movementsDeleted: result.movementsDeleted, plansDeleted: result.plansDeleted, installmentsUndone: result.installmentsUndone });
  if (result.reason === 'plans_changed') return json(409, { code: 'PLANS_CHANGED', blockers: result.blockers });
  if (result.reason === 'not_found') return json(404, { code: 'NOT_FOUND' });
  return json(409, { code: result.reason === 'not_latest' ? 'NOT_LATEST' : 'ALREADY_REVERTED' });
};
