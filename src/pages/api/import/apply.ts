import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/auth';
import { getAccount } from '../../../lib/accounts/repo';
import { json, requireWorkspaceWithBody } from '../../../lib/http';
import { applyImport, ImportInputError, MAX_FILE_CHARS } from '../../../lib/import/service';
import { sanitizeProfile } from '../../../lib/import/profile-input';

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Importa el CSV: movimientos, tarjetas nuevas, planes y mensualidades confirmadas, en una sola
 * transacción. El servidor vuelve a leer y deduplicar el archivo; del navegador solo toma las decisiones.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;

  const { body } = access;
  if (!body || typeof body.text !== 'string' || typeof body.accountId !== 'string' || typeof body.cutoffDate !== 'string') {
    return json(400, { code: 'INVALID_REQUEST' });
  }
  if (body.text.length > MAX_FILE_CHARS) return json(413, { code: 'FILE_TOO_LARGE' });

  const profile = sanitizeProfile(body.profile);
  if (!profile.ok) return json(400, { code: 'INVALID_PROFILE', reason: profile.error });

  const planDrafts = Array.isArray(body.planDrafts) ? body.planDrafts : [];
  const confirmedMatches = Array.isArray(body.confirmedMatches) ? body.confirmedMatches : [];
  if (planDrafts.length > 200 || confirmedMatches.length > 200 || !planDrafts.every(isObject) || !confirmedMatches.every(isObject)) {
    return json(400, { code: 'INVALID_REQUEST' });
  }

  // Tarjeta para los movimientos que el archivo no identifica (opcional): la de todos, una nueva y las de cada movimiento.
  const assignment = isObject(body.cardAssignment) ? body.cardAssignment : null;
  const byMovement = assignment && isObject(assignment.byMovement) ? Object.entries(assignment.byMovement) : [];
  if (byMovement.length > 5000 || !byMovement.every(([key, value]) => typeof value === 'string' && key.length <= 100 && value.length <= 64)) {
    return json(400, { code: 'INVALID_REQUEST' });
  }
  const cardAssignment = assignment
    ? {
        defaultCard: typeof assignment.defaultCard === 'string' && assignment.defaultCard ? assignment.defaultCard : null,
        newCard: isObject(assignment.newCard) ? assignment.newCard : null,
        byMovement: Object.fromEntries(byMovement) as Record<string, string>,
      }
    : undefined;

  const db = getDb();
  const account = await getAccount(db, access.workspace.id, body.accountId);
  if (!account || account.archivedAt) return json(404, { code: 'ACCOUNT_NOT_FOUND' });

  try {
    const result = await applyImport(db, env.FILES, {
      workspaceId: access.workspace.id,
      userId: access.userId,
      account,
      defaultCurrency: access.workspace.defaultCurrency,
      locale: locals.locale,
      text: body.text,
      fileName: typeof body.fileName === 'string' ? body.fileName.slice(0, 200) : 'import.csv',
      profile: profile.profile,
      cutoffDate: body.cutoffDate,
      planDrafts,
      confirmedMatches: confirmedMatches.map((m) => ({ planId: String(m.planId ?? ''), movementKey: String(m.movementKey ?? '') })),
      ignoreErrors: body.ignoreErrors === true,
      createMissingCards: body.createMissingCards !== false,
      cardAssignment,
    });
    if (result.ok) return json(201, { batchId: result.batchId, counts: result.counts });
    return json(result.code === 'NOTHING_TO_IMPORT' ? 409 : 400, { code: result.code, details: result.details });
  } catch (error) {
    if (error instanceof ImportInputError) return json(413, { code: error.code });
    // La llave única de movimientos corta cargas concurrentes del mismo archivo.
    if (error instanceof Error && /UNIQUE constraint/i.test(`${error.message} ${(error as { cause?: Error }).cause?.message ?? ''}`)) {
      return json(409, { code: 'ALREADY_IMPORTED' });
    }
    throw error;
  }
};
