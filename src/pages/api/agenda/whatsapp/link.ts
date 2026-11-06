import type { APIRoute } from 'astro';
import { getDb } from '../../../../lib/auth';
import { createLinkCode, whatsappConfig, whatsappEnabled } from '../../../../lib/agenda/whatsapp';
import { json, sameOrigin } from '../../../../lib/http';

/** Código de vinculación del usuario (no del espacio: también para `viewer`) y el enlace wa.me para mandarlo. */
export const POST: APIRoute = async ({ request, locals }) => {
  await request.text(); // Se consume el cuerpo antes de cualquier rechazo (ver `requireWorkspaceWithBody`).
  if (!whatsappEnabled()) return json(404, { code: 'NOT_FOUND' });
  if (!locals.user) return json(401, { code: 'UNAUTHENTICATED' });
  if (!sameOrigin(request)) return json(403, { code: 'BAD_ORIGIN' });
  const config = whatsappConfig();
  if (!config) return json(503, { code: 'NOT_CONFIGURED' });

  const code = await createLinkCode(getDb(), locals.user.id, new Date());
  return json(200, { code, url: `https://wa.me/${config.businessPhone.replace(/\D/g, '')}?text=${encodeURIComponent(`Vincular ${code}`)}` });
};
