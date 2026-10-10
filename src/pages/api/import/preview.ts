import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/auth';
import { getAccount } from '../../../lib/accounts/repo';
import { json, requireWorkspaceWithBody } from '../../../lib/http';
import { buildPreview, ImportInputError, MAX_FILE_CHARS } from '../../../lib/import/service';
import { sanitizeProfile } from '../../../lib/import/profile-input';
import type { ImportProfile } from '../../../lib/import/types';

/** Lee el CSV y devuelve la vista previa (deduplicación, planes sugeridos). No escribe nada. */
export const POST: APIRoute = async ({ request, locals }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;

  const { body } = access;
  if (!body || typeof body.text !== 'string' || typeof body.accountId !== 'string') return json(400, { code: 'INVALID_REQUEST' });
  if (body.text.length > MAX_FILE_CHARS) return json(413, { code: 'FILE_TOO_LARGE' });

  const db = getDb();
  const account = await getAccount(db, access.workspace.id, body.accountId);
  if (!account || account.archivedAt) return json(404, { code: 'ACCOUNT_NOT_FOUND' });

  let profile: ImportProfile | null = null;
  if (body.profile !== undefined && body.profile !== null) {
    const sanitized = sanitizeProfile(body.profile);
    if (!sanitized.ok) return json(400, { code: 'INVALID_PROFILE', reason: sanitized.error });
    profile = sanitized.profile;
  }

  try {
    const preview = await buildPreview(db, { workspaceId: access.workspace.id, account, defaultCurrency: access.workspace.defaultCurrency, text: body.text, profile, locale: locals.locale });
    return json(200, { preview });
  } catch (error) {
    if (error instanceof ImportInputError) return json(413, { code: error.code });
    throw error;
  }
};
