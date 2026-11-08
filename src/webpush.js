'use strict';
// Web-Push ohne Bibliothek: VAPID (RFC 8292) und Nachrichtenverschlüsselung aes128gcm (RFC 8291 / RFC 8188).
const crypto = require('node:crypto');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');

/** Neues VAPID-Schlüsselpaar: öffentlicher Schlüssel unkomprimiert (65 Byte), privater 32 Byte, beides base64url. */
function generateVapidKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const pub = Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]);
  void publicKey;
  return { publicKey: b64u(pub), privateKey: jwk.d };
}

function vapidKeyObject(publicKey, privateKey) {
  const pub = unb64u(publicKey);
  return crypto.createPrivateKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', d: privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
  });
}

/** VAPID-JWT (ES256) für den Push-Dienst unter `audience` (Origin des Endpoints). */
function vapidJwt({ audience, subject, publicKey, privateKey, expSeconds }) {
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64u(JSON.stringify({ aud: audience, exp: expSeconds, sub: subject }));
  const data = header + '.' + payload;
  const sig = crypto.sign('sha256', Buffer.from(data), { key: vapidKeyObject(publicKey, privateKey), dsaEncoding: 'ieee-p1363' });
  return data + '.' + b64u(sig);
}

/**
 * Verschlüsselt `plaintext` für ein Abo (p256dh, auth). `salt` und `ephemeral` nur für Tests vorgeben.
 * Ergebnis ist der komplette Body mit Kopf: salt(16) | rs(4) | idlen(1) | keyid(65) | Chiffrat.
 */
function encrypt(plaintext, { p256dh, auth }, { salt, ephemeralPrivate } = {}) {
  const uaPublic = unb64u(p256dh);
  const authSecret = unb64u(auth);
  const ecdh = crypto.createECDH('prime256v1');
  if (ephemeralPrivate) ecdh.setPrivateKey(unb64u(ephemeralPrivate));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const s = salt ? unb64u(salt) : crypto.randomBytes(16);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, s, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, s, Buffer.from('Content-Encoding: nonce\0'), 12));

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const padded = Buffer.concat([Buffer.from(plaintext), Buffer.from([2])]); // 0x02 = letzter Datensatz
  const body = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  const head = Buffer.alloc(21);
  s.copy(head, 0);
  head.writeUInt32BE(4096, 16);
  head.writeUInt8(asPublic.length, 20);
  return Buffer.concat([head, asPublic, body]);
}

/** Schickt eine Push-Nachricht. Gibt {ok, status, gone} zurück; gone = Abo abgelaufen, löschen. */
async function sendPush(sub, payload, { publicKey, privateKey, subject, fetchImpl = globalThis.fetch, ttl = 86400, now = Date.now() }) {
  const url = new URL(sub.endpoint);
  const jwt = vapidJwt({ audience: url.origin, subject, publicKey, privateKey, expSeconds: Math.floor(now / 1000) + 12 * 3600 });
  const body = encrypt(JSON.stringify(payload), sub.keys);
  const res = await fetchImpl(sub.endpoint, {
    method: 'POST',
    headers: {
      authorization: `vapid t=${jwt}, k=${publicKey}`,
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: String(ttl),
      urgency: 'normal',
    },
    body,
  });
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
}

module.exports = { generateVapidKeys, vapidJwt, encrypt, sendPush, b64u, unb64u };
