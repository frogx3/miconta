import { env } from 'cloudflare:workers';

/**
 * Web Push (RFC 8030) con VAPID (RFC 8292) y cifrado aes128gcm (RFC 8291), solo con WebCrypto. Se enciende al
 * definir `VAPID_PUBLIC_KEY` (var) y el secreto `VAPID_PRIVATE_KEY`; las claves salen de `node scripts/vapid-keys.mjs`.
 */
export interface VapidConfig {
  /** Clave pública P-256 sin comprimir (65 bytes) en base64url: la misma que usa el navegador al suscribirse. */
  publicKey: string;
  /** Escalar privado `d` (32 bytes) en base64url. */
  privateKey: string;
  /** Contacto para el servicio de push (`mailto:` o URL). */
  subject: string;
}

export interface PushSubscriptionKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
}

const vars = () => env as unknown as Record<string, string | undefined>;

/** null si faltan las claves (push apagado). */
export function vapidConfig(): VapidConfig | null {
  const v = vars();
  const publicKey = v.VAPID_PUBLIC_KEY?.trim() ?? '';
  const privateKey = v.VAPID_PRIVATE_KEY?.trim() ?? '';
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject: v.VAPID_SUBJECT?.trim() || 'https://donbigo.com' };
}

type Bytes = Uint8Array<ArrayBuffer>;

export const toBase64Url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const fromBase64Url = (text: string): Bytes => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

const concat = (...parts: Uint8Array[]): Bytes => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
const utf8 = (text: string): Bytes => new TextEncoder().encode(text) as Bytes;

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, bytes: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

/** JWT ES256 para `Authorization: vapid t=…, k=…`; WebCrypto ya firma en el formato r||s que pide JWS. */
export async function vapidAuthorization(cfg: VapidConfig, endpoint: string, now: Date): Promise<string> {
  const pub = fromBase64Url(cfg.publicKey);
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x: toBase64Url(pub.slice(1, 33)), y: toBase64Url(pub.slice(33, 65)), d: cfg.privateKey },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const segment = (value: object) => toBase64Url(utf8(JSON.stringify(value)));
  const unsigned = `${segment({ typ: 'JWT', alg: 'ES256' })}.${segment({ aud: new URL(endpoint).origin, exp: Math.floor(now.getTime() / 1000) + 12 * 3600, sub: cfg.subject })}`;
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(unsigned)));
  return `vapid t=${unsigned}.${toBase64Url(signature)}, k=${cfg.publicKey}`;
}

/** Cuerpo cifrado aes128gcm (un solo registro) para la suscripción. */
export async function encryptPayload(sub: Pick<PushSubscriptionKeys, 'p256dh' | 'auth'>, payload: string): Promise<Bytes> {
  const uaPublic = fromBase64Url(sub.p256dh);
  const authSecret = fromBase64Url(sub.auth);
  const local = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', local.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concat(utf8('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // 0x02: delimitador del último (y único) registro.
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(utf8(payload), new Uint8Array([2]))));

  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096);
  return concat(salt, recordSize, new Uint8Array([asPublic.length]), asPublic, cipher);
}

export type PushResult = { ok: true } | { ok: false; gone: boolean; error: string };

/** Lo que muestra el service worker (`public/sw.js`). */
export interface PushMessage {
  title: string;
  body: string;
  url: string;
  tag?: string;
}

/** `gone`: la suscripción ya no existe (404/410) y debe borrarse. */
export async function sendPush(cfg: VapidConfig, sub: PushSubscriptionKeys, message: PushMessage, now: Date, fetchFn: typeof fetch = fetch): Promise<PushResult> {
  try {
    const response = await fetchFn(sub.endpoint, {
      method: 'POST',
      headers: {
        Authorization: await vapidAuthorization(cfg, sub.endpoint, now),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(24 * 3600),
        Urgency: 'normal',
      },
      body: await encryptPayload(sub, JSON.stringify(message)),
    });
    if (response.ok) return { ok: true };
    return { ok: false, gone: response.status === 404 || response.status === 410, error: `HTTP ${response.status}: ${(await response.text().catch(() => '')).slice(0, 300)}` };
  } catch (error) {
    return { ok: false, gone: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// El servidor hace POST al endpoint que manda el navegador: solo a servicios de push conocidos (evita usarlo para
// pegarle a cualquier URL). shortcut: lista de Chrome/Android, Firefox, Safari/iOS y Edge; ampliar si otro navegador falla.
const PUSH_HOSTS = /^(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)$/;

const decodedLength = (text: unknown): number => {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(text)) return -1;
  try {
    return fromBase64Url(text.replace(/=+$/, '')).length;
  } catch {
    return -1;
  }
};

/** `PushSubscription.toJSON()` del navegador → datos a guardar; null si algo no cuadra. */
export function parseSubscription(body: Record<string, unknown> | null): PushSubscriptionKeys | null {
  const keys = body?.keys as Record<string, unknown> | undefined;
  if (typeof body?.endpoint !== 'string' || body.endpoint.length > 1000 || typeof keys !== 'object' || keys === null) return null;
  let url: URL;
  try {
    url = new URL(body.endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !PUSH_HOSTS.test(url.hostname)) return null;
  if (decodedLength(keys.p256dh) !== 65 || decodedLength(keys.auth) !== 16) return null;
  return { endpoint: body.endpoint, p256dh: String(keys.p256dh).replace(/=+$/, ''), auth: String(keys.auth).replace(/=+$/, '') };
}
