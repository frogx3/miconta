import type { APIRoute } from 'astro';
import { and, eq, isNotNull } from 'drizzle-orm';
import { agendaItems, cards, user, workspaceMembers } from '../../../db/schema';
import { getDb } from '../../../lib/auth';
import type { Db } from '../../../lib/auth/hooks';
import { sendText } from '../../../lib/agenda/kapso';
import { getItem, markDone, materializeCardPayment, storedOccurrence } from '../../../lib/agenda/repo';
import { parseInbound, parseLinkMessage, redeemLinkCode, verifyItemToken, verifyWebhookSignature, whatsappConfig, type InboundEvent, type WhatsappConfig } from '../../../lib/agenda/whatsapp';
import { json, WRITE_ROLES } from '../../../lib/http';

const MAX_BODY_BYTES = 1_000_000;
const MAX_MESSAGES = 20;

const HELP = 'Hola, soy Don Bigo. Aquí te aviso de tus pagos; administra tu agenda en donbigo.com/app/agenda';
const NOT_REGISTERED = 'No pude registrar ese pago. Revísalo en donbigo.com/app/agenda';
const NO_PERMISSION = 'No tienes permiso para registrar pagos en este espacio.';
const OPEN_APP = 'Abre Don Bigo para registrar este pago: donbigo.com/app/agenda';
const LINK_REPLIES = {
  linked: 'Listo, te avisaré aquí',
  invalid: 'Ese código ya no es válido, genera otro en Don Bigo',
  phone_taken: 'Ese número ya está vinculado a otra persona',
} as const;

/**
 * Webhook público de Kapso (sin sesión): la firma HMAC del cuerpo es la única prueba de origen. Responde 200 tras
 * procesar aunque fallen las respuestas por WhatsApp, para que Kapso no reintente.
 */
export const POST: APIRoute = async ({ request }) => {
  const config = whatsappConfig();
  if (!config) {
    await request.text(); // Se consume antes de rechazar (ver `requireWorkspaceWithBody`).
    return json(404, { code: 'NOT_FOUND' });
  }
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return json(413, { code: 'TOO_LARGE' });
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return json(413, { code: 'TOO_LARGE' });

  const signature = request.headers.get('x-webhook-signature') ?? request.headers.get('x-hub-signature-256');
  if (!(await verifyWebhookSignature(config.webhookSecret, raw, signature))) return json(401, { code: 'BAD_SIGNATURE' });

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { code: 'INVALID_JSON' });
  }

  const db = getDb();
  // El número del negocio nunca recibe respuesta: evita contestarnos a nosotros mismos en bucle.
  const businessPhone = config.businessPhone.replace(/\D/g, '');
  const events = parseInbound(body).filter((event) => event.from !== businessPhone).slice(0, MAX_MESSAGES);
  for (const event of events) {
    try {
      const reply = event.kind === 'text' ? await handleText(db, event.from, event.text) : await handleButton(db, config, event);
      await sendText(config, event.from, reply); // No lanza: un envío fallido no cambia la respuesta.
    } catch (error) {
      // Un error de base en un mensaje no tumba el lote (Kapso reintentaría todo). Los errores de Drizzle traen los
      // parámetros de la consulta: se ocultan las secuencias largas de dígitos (teléfonos).
      console.error('webhook: mensaje falló', event.kind, (error instanceof Error ? error.message : String(error)).replace(/\d{7,}/g, '…'));
    }
  }
  return json(200, {});
};

async function handleText(db: Db, from: string, text: string): Promise<string> {
  const code = parseLinkMessage(text);
  return code ? LINK_REPLIES[await redeemLinkCode(db, code, from, new Date())] : HELP;
}

async function handleButton(db: Db, config: WhatsappConfig, event: Extract<InboundEvent, { kind: 'button' }>): Promise<string> {
  const [sender] = await db
    .select({ id: user.id })
    .from(user)
    .where(and(eq(user.whatsappPhone, event.from), isNotNull(user.whatsappVerifiedAt)))
    .limit(1);
  // A números desconocidos solo se les da la ayuda genérica, sin detalles.
  if (!sender) return HELP;

  const itemKey = await verifyItemToken(config.webhookSecret, event.payload);
  if (!itemKey) return NOT_REGISTERED;

  // El token lo firmamos nosotros: su itemKey es de fiar, pero el espacio se toma de la base, no del mensaje.
  const card = /^card:([^:]+):(\d{4}-\d{2}-\d{2})$/.exec(itemKey);
  const projected = /^proj:([^:]+):(\d{4}-\d{2}-\d{2})$/.exec(itemKey);
  const [owner] = card
    ? await db.select({ workspaceId: cards.workspaceId }).from(cards).where(eq(cards.id, card[1]!)).limit(1)
    : await db.select({ workspaceId: agendaItems.workspaceId }).from(agendaItems).where(eq(agendaItems.id, projected ? projected[1]! : itemKey)).limit(1);
  if (!owner) return NOT_REGISTERED;
  const workspaceId = owner.workspaceId;

  const [membership] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, sender.id)))
    .limit(1);
  if (!membership || !WRITE_ROLES.includes(membership.role)) return NO_PERMISSION;

  const by = { userId: sender.id, via: 'whatsapp' } as const;
  let id = itemKey;
  let result: 'done' | 'already' | 'not_found';
  if (card) {
    const saved = await materializeCardPayment(db, workspaceId, { cardId: card[1]!, dueDate: card[2]!, action: 'done', by });
    if (!saved) return NOT_REGISTERED;
    id = saved.id;
    result = saved.result === 'done' ? 'done' : 'already';
  } else if (projected) {
    // Un aviso proyectado es informativo: no se materializa la serie desde WhatsApp (habría que decidir qué pasa con
    // las ocurrencias anteriores sin pagar). El botón solo marca si esa fecha ya quedó guardada en la serie (p. ej. se
    // pagó la anterior en la web); si no, se manda a la app sin tocar nada.
    const stored = await storedOccurrence(db, workspaceId, projected[1]!, projected[2]!);
    if (!stored) return OPEN_APP;
    id = stored;
    result = await markDone(db, workspaceId, stored, by);
  } else {
    result = await markDone(db, workspaceId, itemKey, by);
  }
  if (result === 'not_found') return NOT_REGISTERED;
  if (result === 'already') return 'Ya estaba registrado';
  const item = await getItem(db, workspaceId, id);
  return `Listo, marqué *${item?.description ?? 'el pago'}* como pagada ✅`;
}
