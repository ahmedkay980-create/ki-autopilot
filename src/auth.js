'use strict';
// Anmeldung: Passwort-Hash (scrypt), Sitzungen als Cookie, Bremse gegen Durchprobieren.
const crypto = require('node:crypto');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 32);
  return 'scrypt$' + salt.toString('base64url') + '$' + hash.toString('base64url');
}

function checkPassword(pw, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, s, h] = stored.split('$');
  const want = Buffer.from(h, 'base64url');
  const got = crypto.scryptSync(String(pw), Buffer.from(s, 'base64url'), want.length);
  return crypto.timingSafeEqual(want, got);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Einfache Bremse: max. `limit` Fehlversuche je Adresse in `windowMs`. */
class Throttle {
  constructor(limit = 8, windowMs = 15 * 60e3) { this.limit = limit; this.windowMs = windowMs; this.hits = new Map(); }
  blocked(key, now = Date.now()) {
    const list = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    this.hits.set(key, list);
    return list.length >= this.limit;
  }
  fail(key, now = Date.now()) { this.hits.set(key, [...(this.hits.get(key) || []), now]); }
  reset(key) { this.hits.delete(key); }
}

module.exports = { hashPassword, checkPassword, parseCookies, Throttle };
