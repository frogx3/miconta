// Genera el par de claves VAPID para las notificaciones push: VAPID_PUBLIC_KEY (var) y VAPID_PRIVATE_KEY (secreto).
const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
const raw = Buffer.from(await crypto.subtle.exportKey('raw', publicKey)).toString('base64url');
const { d } = await crypto.subtle.exportKey('jwk', privateKey);
console.log(`VAPID_PUBLIC_KEY=${raw}\nVAPID_PRIVATE_KEY=${d}`);
