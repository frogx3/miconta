import type { APIRoute } from 'astro';
import { getAccount } from '../../../../lib/accounts/repo';
import { getDb } from '../../../../lib/auth';
import { emailCaptureEnabled } from '../../../../lib/email/config';
import { disableInbox, enableInbox } from '../../../../lib/email/inbound';
import { json, requireWorkspaceWithBody } from '../../../../lib/http';

/** Activa la dirección de reenvío de la cuenta; con `{ "regenerate": true }` le da una nueva y la anterior deja de recibir. */
export const POST: APIRoute = async ({ request, locals, params }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;
  if (!emailCaptureEnabled()) return json(404, { code: 'NOT_FOUND' });
  const db = getDb();
  const account = await getAccount(db, access.workspace.id, params.id!);
  if (!account) return json(404, { code: 'NOT_FOUND' });
  await enableInbox(db, access.workspace.id, account.id, access.userId, access.body?.regenerate === true);
  return json(200, { ok: true });
};

/** Desactiva la dirección: los correos que lleguen después se rebotan. La bitácora se conserva. */
export const DELETE: APIRoute = async ({ request, locals, params }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;
  await disableInbox(getDb(), access.workspace.id, params.id!);
  return json(200, { ok: true });
};
