// shortcut: formato tomado de la documentación pública, confirmar con el panel de Kapso antes de encender
// API compatible con Meta de Kapso: POST https://api.kapso.ai/meta/whatsapp/v24.0/{phoneNumberId}/messages,
// encabezado `X-API-Key`, cuerpo en formato de WhatsApp Cloud API; el id del mensaje viene en `messages[0].id`.
// `to` va en dígitos E.164 sin "+" (como el `wa_id` de WhatsApp), p. ej. '5215512345678'.
import type { WhatsappConfig } from './whatsapp';

type Result = { ok: true; messageId: string } | { ok: false; error: string };

async function send(cfg: WhatsappConfig, body: Record<string, unknown>, fetchFn: typeof fetch): Promise<Result> {
  try {
    const response = await fetchFn(`https://api.kapso.ai/meta/whatsapp/v24.0/${cfg.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-API-Key': cfg.apiKey },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
    });
    const text = await response.text();
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}: ${text.slice(0, 500)}` };
    const messageId = (JSON.parse(text) as { messages?: { id?: string }[] }).messages?.[0]?.id;
    return messageId ? { ok: true, messageId } : { ok: false, error: `Respuesta sin id: ${text.slice(0, 500)}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Plantilla de recordatorio: {descripción, monto, fecha} y botón de respuesta rápida cuya payload es el token firmado. */
export function sendReminder(
  cfg: WhatsappConfig,
  to: string,
  p: { description: string; amount: string; date: string; buttonPayload: string },
  fetchFn: typeof fetch = fetch,
): Promise<Result> {
  return send(cfg, {
    to,
    type: 'template',
    template: {
      name: cfg.template,
      language: { code: 'es_MX' },
      components: [
        { type: 'body', parameters: [p.description, p.amount, p.date].map((text) => ({ type: 'text', text })) },
        { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: p.buttonPayload }] },
      ],
    },
  }, fetchFn);
}

/** Texto libre: solo llega dentro de la ventana de 24 h desde el último mensaje del usuario. */
export async function sendText(cfg: WhatsappConfig, to: string, text: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
  return (await send(cfg, { to, type: 'text', text: { body: text } }, fetchFn)).ok;
}
