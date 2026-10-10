import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/auth';
import { json, requireWorkspaceWithBody, validationError } from '../../../lib/http';
import { getWorkspaceSettings, setAntThreshold } from '../../../lib/spending/repo';
import { validateThreshold } from '../../../lib/spending/validation';

/** Ajustes del espacio. Solo dueño o administrador del espacio. Hoy: el umbral de gasto hormiga. */
export const PATCH: APIRoute = async ({ request, locals }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;
  if (access.workspace.role !== 'owner' && access.workspace.role !== 'admin') return json(403, { code: 'FORBIDDEN_ROLE' });

  const { body } = access;
  if (!body) return json(400, { code: 'INVALID_JSON' });

  const db = getDb();
  const { currency } = await getWorkspaceSettings(db, access.workspace.id);
  const parsed = validateThreshold(body.antThreshold, locals.locale, currency);
  if (!parsed.ok) return validationError(parsed.errors);

  await setAntThreshold(db, access.workspace.id, parsed.value);
  return json(200, { antThresholdMinor: parsed.value });
};
