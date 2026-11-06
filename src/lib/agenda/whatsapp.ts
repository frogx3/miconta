import { env } from 'cloudflare:workers';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { user, whatsappLinkCodes } from '../../db/schema';
import type { Db } from '../auth/hooks';
import { timingSafeEqual } from '../auth/setup-code';

/**
 * Avisos por WhatsApp (Kapso). Se encienden con `WHATSAPP_NOTIFICATIONS = "true"`; además hacen falta la plantilla,
 * el número del negocio y los secretos `KAPSO_API_KEY`, `KAPSO_PHONE_NUMBER_ID` y `KAPSO_WEBHOOK_SECRET`.
 * Los teléfonos se guardan y se envían como dígitos E.164 sin "+" (como el `wa_id` de WhatsApp): '5215512345678'.
 */
export interface WhatsappConfig {
  apiKey: string;
  phoneNumberId: string;
  webhookSecret: string;
  template: string;
  businessPhone: string;
}

const vars = () => env as unknown as Record<string, string | undefined>;

export const whatsappEnabled = (): boolean => String(vars().WHATSAPP_NOTIFICATIONS).toLowerCase() === 'true';

/** null si está apagado o falta algún valor. */
export function whatsappConfig(): WhatsappConfig | null {
  if (!whatsappEnabled()) return null;
  const v = vars();
  const config = {
    apiKey: v.KAPSO_API_KEY?.trim() ?? '',
    phoneNumberId: v.KAPSO_PHONE_NUMBER_ID?.trim() ?? '',
    webhookSecret: v.KAPSO_WEBHOOK_SECRET?.trim() ?? '',
    template: v.KAPSO_REMINDER_TEMPLATE?.trim() ?? '',
    businessPhone: v.KAPSO_BUSINESS_PHONE?.trim() ?? '',
  };
  return Object.values(config).every(Boolean) ? config : null;
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
  return btoa(String.fromCharCode(...signature)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Payload del botón "Ya lo pagué": `${itemKey}.${firma}`. El itemKey puede llevar ':' ('card:<id>:<fecha>') pero
 * nunca '.', así que se separa por el último punto. La firma ocupa 43 caracteres y WhatsApp admite 256 en la payload.
 */
export async function signItemToken(secret: string, itemKey: string): Promise<string> {
  if (itemKey.includes('.') || itemKey.length > 200) throw new Error('itemKey inválido para el botón');
  return `${itemKey}.${await hmac(secret, itemKey)}`;
}

export async function verifyItemToken(secret: string, token: string): Promise<string | null> {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const itemKey = token.slice(0, dot);
  return timingSafeEqual(token.slice(dot + 1), await hmac(secret, itemKey)) ? itemKey : null;
}

// Sin 0/O ni 1/I para que no se confundan al leerlos.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 6 caracteres; 32 divide a 256, así que `byte % 32` no tiene sesgo. */
export function newLinkCode(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) => ALPHABET[byte % ALPHABET.length]).join('');
}

/** "vincular 7kq2x9 " → "7KQ2X9". */
export function parseLinkMessage(text: string): string | null {
  const match = /^\s*vincular\s+([a-z0-9]{6})\s*$/i.exec(text);
  return match ? match[1]!.toUpperCase() : null;
}

const LINK_CODE_TTL_MS = 15 * 60_000;

/** Un código activo por usuario: los anteriores sin usar se borran. Vence en 15 minutos. */
export async function createLinkCode(db: Db, userId: string, now: Date): Promise<string> {
  const code = newLinkCode();
  await db.batch([
    db.delete(whatsappLinkCodes).where(and(eq(whatsappLinkCodes.userId, userId), isNull(whatsappLinkCodes.usedAt))),
    db.insert(whatsappLinkCodes).values({ code, userId, expiresAt: new Date(now.getTime() + LINK_CODE_TTL_MS) }),
  ]);
  return code;
}

/**
 * Liga `phone` al usuario del código. El "número de otro usuario" se revisa ANTES de consumir el código, para que
 * quien lo intentó desde un número ajeno pueda reintentar desde el suyo con el mismo código. El consumo es atómico
 * (UPDATE condicional), así que dos mensajes simultáneos no ligan dos veces.
 */
export async function redeemLinkCode(db: Db, code: string, phone: string, now: Date): Promise<'linked' | 'invalid' | 'phone_taken'> {
  const normalized = code.trim().toUpperCase();
  const [pending] = await db.select().from(whatsappLinkCodes).where(eq(whatsappLinkCodes.code, normalized)).limit(1);
  if (!pending || pending.usedAt || pending.expiresAt.getTime() <= now.getTime()) return 'invalid';

  const [owner] = await db.select({ id: user.id }).from(user).where(eq(user.whatsappPhone, phone)).limit(1);
  if (owner && owner.id !== pending.userId) return 'phone_taken';

  // Un solo lote (atómico en D1): consume el código solo si sigue libre y vigente, y liga el número solo si se consumió.
  const [consumed] = await db.batch([
    db
      .update(whatsappLinkCodes)
      .set({ usedAt: now })
      .where(and(eq(whatsappLinkCodes.code, normalized), isNull(whatsappLinkCodes.usedAt), gt(whatsappLinkCodes.expiresAt, now)))
      .returning({ userId: whatsappLinkCodes.userId }),
    db
      .update(user)
      .set({ whatsappPhone: phone, whatsappVerifiedAt: now, whatsappOptIn: true })
      .where(and(eq(user.id, pending.userId), sql`exists (select 1 from whatsapp_link_codes where code = ${normalized} and used_at = ${now.getTime()})`)),
  ]);
  // shortcut: si otro usuario tomara el número entre la revisión y el lote, el índice único hace fallar el lote (error, no 'phone_taken'); carrera prácticamente imposible.
  if (consumed.length === 0) return 'invalid';
  return 'linked';
}

/**
 * Firma del webhook: HMAC-SHA256(secreto, cuerpo crudo) en hex. Se acepta tal cual (`X-Webhook-Signature`) o con el
 * prefijo `sha256=` (`X-Hub-Signature-256`); la ruta pasa el encabezado que venga.
 */
export async function verifyWebhookSignature(secret: string, rawBody: string, header: string | null): Promise<boolean> {
  const provided = header?.trim().replace(/^sha256=/i, '').toLowerCase();
  if (!provided) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody)));
  return timingSafeEqual(provided, Array.from(signature, (byte) => byte.toString(16).padStart(2, '0')).join(''));
}

/** Mensajes entrantes que importan; estados, mensajes salientes y otros tipos (imagen, audio…) no se devuelven. */
export type InboundEvent = { kind: 'button'; from: string; payload: string } | { kind: 'text'; from: string; text: string };

// `any` a propósito: el cuerpo es externo y cada acceso se valida con typeof antes de usarse.
type Loose = Record<string, any>;
const asObject = (value: unknown): Loose | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Loose) : null);
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function toEvent(raw: unknown, fallbackFrom?: unknown): InboundEvent | null {
  const message = asObject(raw);
  if (!message || message.kapso?.direction === 'outbound') return null;
  const from = String(message.from ?? fallbackFrom ?? '').replace(/\D/g, '');
  if (!from) return null;
  if (message.type === 'text' && typeof message.text?.body === 'string') return { kind: 'text', from, text: message.text.body };
  const payload = message.type === 'button' ? message.button?.payload : message.type === 'interactive' && message.interactive?.type === 'button_reply' ? message.interactive.button_reply?.id : undefined;
  return typeof payload === 'string' && payload ? { kind: 'button', from, payload } : null;
}

/**
 * Lee el cuerpo del webhook en formato Meta (`entry[].changes[].value.messages[]`) o en formato Kapso (`message`
 * arriba, o un lote `data[]` de esos eventos). Nunca lanza: lo desconocido se ignora.
 */
// shortcut: los formatos salen de la documentación pública de Kapso y Meta; confirmarlos en el panel de Kapso antes de encender.
export function parseInbound(body: unknown): InboundEvent[] {
  const root = asObject(body);
  if (!root) return [];
  const meta = asArray(root.entry).flatMap((entry) => asArray(asObject(entry)?.changes).flatMap((change) => asArray(asObject(asObject(change)?.value)?.messages).map((m) => toEvent(m))));
  const kapso = [root, ...asArray(root.data)].map((event) => asObject(event)).map((event) => (event?.message ? toEvent(event.message, event.conversation?.phone_number) : null));
  return [...meta, ...kapso].filter((event): event is InboundEvent => event !== null);
}
