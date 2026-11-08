'use strict';
// Kleine Helfer: IDs, Zeit, Zeitzonen, Base64url, JSON aus Text.
const crypto = require('node:crypto');

const uid = (prefix = '') => prefix + crypto.randomBytes(6).toString('hex');
const token = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hours = (h) => h * 3600e3;
const days = (n) => n * 864e5;
const monthKey = (d) => new Date(d).toISOString().slice(0, 7);

/** YYYY-MM-DD in lokaler Zeit des Servers. */
function isoDate(d) {
  const x = new Date(d);
  return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
}

function median(arr) {
  const a = arr.filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** Erstes gültiges JSON-Objekt oder -Array aus Fließtext lösen. */
function extractJson(text) {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1]); } catch { /* weiter */ } }
  for (let start = text.search(/[[{]/); start >= 0 && start < text.length; start = text.slice(start + 1).search(/[[{]/) + start + 1) {
    const close = text[start] === '[' ? ']' : '}';
    for (let end = text.lastIndexOf(close); end > start; end = text.lastIndexOf(close, end - 1)) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch { /* kürzer probieren */ }
    }
    if (text.slice(start + 1).search(/[[{]/) < 0) break;
  }
  return null;
}

// ---------- Zeitzonen ohne Bibliothek ----------
const dtfCache = new Map();
function dtf(tz) {
  if (!dtfCache.has(tz)) {
    dtfCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return dtfCache.get(tz);
}
/** Wanduhr-Teile eines Zeitpunkts in Zeitzone `tz`. */
function zonedParts(date, tz) {
  const p = dtf(tz).formatToParts(new Date(date));
  const g = (t) => Number(p.find((x) => x.type === t).value);
  return { y: g('year'), m: g('month'), d: g('day'), hh: g('hour'), mm: g('minute'), ss: g('second') };
}
function tzOffsetMs(date, tz) {
  const z = zonedParts(date, tz);
  return Date.UTC(z.y, z.m - 1, z.d, z.hh, z.mm, z.ss) - Math.floor(new Date(date).getTime() / 1000) * 1000;
}
/** Wanduhrzeit in `tz` → echter Zeitpunkt. */
function zonedToDate(y, m, d, hh, mm, tz) {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const off = tzOffsetMs(guess, tz);
  let t = guess - off;
  const off2 = tzOffsetMs(t, tz);
  if (off2 !== off) t = guess - off2;
  return new Date(t);
}
function validTz(tz) {
  try { dtf(tz); return true; } catch { return false; }
}

module.exports = { uid, token, sleep, hours, days, monthKey, isoDate, median, extractJson, zonedParts, zonedToDate, validTz };
