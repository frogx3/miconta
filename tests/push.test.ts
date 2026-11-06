import { describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({}) as Record<string, string>);
vi.mock('cloudflare:workers', () => ({ env }));

import { encryptPayload, fromBase64Url, parseSubscription, sendPush, toBase64Url, vapidAuthorization, vapidConfig, type VapidConfig } from '../src/lib/push/webpush';

const ecdh = { name: 'ECDH', namedCurve: 'P-256' } as const;
const raw = async (key: CryptoKey) => new Uint8Array((await crypto.subtle.exportKey('raw', key)) as ArrayBuffer);
const hkdf = async (salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) =>
  new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: info as BufferSource }, await crypto.subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveBits']), bytes * 8));
const text = (s: string) => new TextEncoder().encode(s);

/** Lo que hace el navegador al recibir (RFC 8291), para comprobar el cifrado de ida y vuelta. */
async function browser() {
  const keys = (await crypto.subtle.generateKey(ecdh, true, ['deriveBits'])) as CryptoKeyPair;
  const uaPublic = await raw(keys.publicKey);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const decrypt = async (body: Uint8Array) => {
    const salt = body.slice(0, 16);
    const idlen = body[20]!;
    const asPublic = body.slice(21, 21 + idlen);
    const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: await crypto.subtle.importKey('raw', asPublic, ecdh, false, []) }, keys.privateKey, 256));
    const ikm = await hkdf(auth, shared, new Uint8Array([...text('WebPush: info\0'), ...uaPublic, ...asPublic]), 32);
    const cek = await hkdf(salt, ikm, text('Content-Encoding: aes128gcm\0'), 16);
    const nonce = await hkdf(salt, ikm, text('Content-Encoding: nonce\0'), 12);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']), body.slice(21 + idlen)));
    expect(plain.at(-1)).toBe(2);
    return new TextDecoder().decode(plain.slice(0, -1));
  };
  return { p256dh: toBase64Url(uaPublic), auth: toBase64Url(auth), decrypt };
}

async function vapidKeys(): Promise<VapidConfig & { verifyKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const { d } = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { publicKey: toBase64Url(await raw(pair.publicKey)), privateKey: d!, subject: 'https://donbigo.com', verifyKey: pair.publicKey };
}

describe('cifrado aes128gcm', () => {
  it('el navegador descifra lo que se manda', async () => {
    const ua = await browser();
    const body = await encryptPayload(ua, '{"title":"Renta vence en 2 días"}');
    expect(new DataView(body.buffer).getUint32(16)).toBe(4096);
    expect(await ua.decrypt(body)).toBe('{"title":"Renta vence en 2 días"}');
  });
});

describe('VAPID', () => {
  it('JWT ES256 válido para el origen del endpoint', async () => {
    const cfg = await vapidKeys();
    const header = await vapidAuthorization(cfg, 'https://fcm.googleapis.com/fcm/send/abc', new Date('2026-11-06T00:00:00Z'));
    const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
    expect(k).toBe(cfg.publicKey);
    const [h, p, s] = jwt!.split('.');
    expect(JSON.parse(new TextDecoder().decode(fromBase64Url(p!)))).toEqual({ aud: 'https://fcm.googleapis.com', exp: Date.parse('2026-11-06T12:00:00Z') / 1000, sub: 'https://donbigo.com' });
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, cfg.verifyKey, fromBase64Url(s!), text(`${h}.${p}`))).toBe(true);
  });
  it('apagado sin las dos claves', () => {
    expect(vapidConfig()).toBeNull();
    Object.assign(env, { VAPID_PUBLIC_KEY: 'pub' });
    expect(vapidConfig()).toBeNull();
    env.VAPID_PRIVATE_KEY = 'priv';
    expect(vapidConfig()).toEqual({ publicKey: 'pub', privateKey: 'priv', subject: 'https://donbigo.com' });
  });
});

describe('suscripción', () => {
  const keys = { p256dh: toBase64Url(new Uint8Array(65).fill(4)), auth: toBase64Url(new Uint8Array(16).fill(1)) };
  it('acepta servicios de push conocidos', () => {
    for (const endpoint of ['https://fcm.googleapis.com/fcm/send/x', 'https://web.push.apple.com/QK', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://wns2-par02p.notify.windows.com/w/?token=x']) {
      expect(parseSubscription({ endpoint, keys })).toEqual({ endpoint, ...keys });
    }
  });
  it('rechaza otros hosts, http y claves de otro tamaño', () => {
    expect(parseSubscription({ endpoint: 'https://evil.example/x', keys })).toBeNull();
    expect(parseSubscription({ endpoint: 'http://fcm.googleapis.com/x', keys })).toBeNull();
    expect(parseSubscription({ endpoint: 'https://fcm.googleapis.com.evil.example/x', keys })).toBeNull();
    expect(parseSubscription({ endpoint: 'https://fcm.googleapis.com/x', keys: { ...keys, auth: 'AA' } })).toBeNull();
    expect(parseSubscription({ endpoint: 'https://fcm.googleapis.com/x' })).toBeNull();
    expect(parseSubscription(null)).toBeNull();
  });
});

describe('envío', () => {
  it('manda cuerpo cifrado con encabezados; 410 → gone', async () => {
    const cfg = await vapidKeys();
    const ua = await browser();
    const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: ua.p256dh, auth: ua.auth };
    const fetchFn = vi.fn(async () => new Response(null, { status: 201 }));
    expect(await sendPush(cfg, sub, { title: 'Hola', body: 'b', url: '/app/agenda' }, new Date(), fetchFn as unknown as typeof fetch)).toEqual({ ok: true });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(sub.endpoint);
    const headers = new Headers(init.headers);
    expect(headers.get('Content-Encoding')).toBe('aes128gcm');
    expect(headers.get('TTL')).toBe('86400');
    expect(JSON.parse(await ua.decrypt(init.body as Uint8Array))).toEqual({ title: 'Hola', body: 'b', url: '/app/agenda' });

    const gone = async () => new Response('', { status: 410 });
    expect(await sendPush(cfg, sub, { title: 'x', body: 'y', url: '/' }, new Date(), gone as typeof fetch)).toMatchObject({ ok: false, gone: true });
  });
});
