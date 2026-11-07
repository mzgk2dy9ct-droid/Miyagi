// Notificaciones push (estándar Web Push: VAPID + cifrado aes128gcm, RFC 8291/8292),
// hechas solo con node:crypto para no depender de librerías.
import { createECDH, createPrivateKey, createSign, createHmac, createCipheriv, randomBytes } from "node:crypto";

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const fromB64u = (s) => Buffer.from(String(s), "base64url");

export function generateVapidKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const d = ecdh.getPrivateKey();
  const priv = Buffer.concat([Buffer.alloc(Math.max(0, 32 - d.length)), d]);
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(priv) };
}

export function vapidJwt(endpoint, keys, subject) {
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const payload = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const pub = fromB64u(keys.publicKey);
  const key = createPrivateKey({
    key: { kty: "EC", crv: "P-256", d: keys.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: "jwk",
  });
  const sig = createSign("SHA256").update(`${header}.${payload}`).sign({ key, dsaEncoding: "ieee-p1363" });
  return `${header}.${payload}.${b64u(sig)}`;
}

const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

export function encryptPayload(subscription, plaintext) {
  const uaPublic = fromB64u(subscription.keys.p256dh);
  const authSecret = fromB64u(subscription.keys.auth);
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = randomBytes(16);
  const prkKey = hmac(authSecret, shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: aes128gcm\0"), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: nonce\0"), Buffer.from([1])])).subarray(0, 12);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

// Envía una notificación. Devuelve el código HTTP (404/410 = suscripción caducada).
export async function sendPush(subscription, payload, keys, subject) {
  const body = encryptPayload(subscription, JSON.stringify(payload));
  const r = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "3600",
      Urgency: "high",
      Authorization: `vapid t=${vapidJwt(subscription.endpoint, keys, subject)}, k=${keys.publicKey}`,
    },
    body,
  });
  return r.status;
}
