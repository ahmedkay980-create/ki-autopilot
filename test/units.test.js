'use strict';
const { mockFetch, makeEngine } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const webpush = require('../src/webpush');
const { InstagramClient } = require('../src/instagram');
const trends = require('../src/trends');
const voice = require('../src/voice');
const R = require('../src/render');
const U = require('../src/util');
const { Scheduler } = require('../src/scheduler');

// ---------- Web-Push ----------
function uaDecrypt(body, uaEcdh, authSecret) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const cipher = body.subarray(21 + idlen);
  const shared = uaEcdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaEcdh.getPublicKey(), asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(cipher.subarray(cipher.length - 16));
  const plain = Buffer.concat([d.update(cipher.subarray(0, cipher.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2, 'Endmarke des letzten Datensatzes');
  return { text: plain.subarray(0, -1).toString(), rs: body.readUInt32BE(16) };
}

test('Web-Push: Browser kann die Nachricht entschlüsseln (RFC 8291 / aes128gcm)', () => {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const sub = { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') };
  const body = webpush.encrypt('{"title":"Fertig","body":"Video online"}', sub);
  const out = uaDecrypt(body, ua, auth);
  assert.equal(out.text, '{"title":"Fertig","body":"Video online"}');
  assert.equal(out.rs, 4096);
});

test('Web-Push: VAPID-Signatur ist gültig, abgelaufene Abos werden erkannt', async () => {
  const keys = webpush.generateVapidKeys();
  assert.equal(Buffer.from(keys.publicKey, 'base64url').length, 65);
  const jwt = webpush.vapidJwt({ audience: 'https://fcm.googleapis.com', subject: 'mailto:a@b.c', ...keys, expSeconds: 2e9 });
  const [h, p, s] = jwt.split('.');
  const pub = Buffer.from(keys.publicKey, 'base64url');
  const key = crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') } });
  assert.ok(crypto.verify('sha256', Buffer.from(h + '.' + p), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
  assert.equal(JSON.parse(Buffer.from(p, 'base64url')).aud, 'https://fcm.googleapis.com');

  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
  let headers;
  const fetch = mockFetch([['POST', /fcm\.googleapis\.com/, (u, o) => { headers = o.headers; return { __status: 410 }; }]]);
  const r = await webpush.sendPush(sub, { title: 'x' }, { ...keys, subject: 'mailto:a@b.c', fetchImpl: fetch });
  assert.equal(r.gone, true);
  assert.match(headers.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
  assert.equal(headers['content-encoding'], 'aes128gcm');
});

// ---------- Instagram ----------
test('Instagram: Reel per video_url anlegen, warten, veröffentlichen', async () => {
  let form;
  const fetch = mockFetch([
    ['POST', /graph\.instagram\.com\/v27\.0\/178\/media$/, (u, o) => { form = new URLSearchParams(o.body); return { id: 'c9' }; }],
    ['GET', /graph\.instagram\.com\/v27\.0\/c9\?/, () => ({ status_code: 'FINISHED' })],
    ['POST', /\/178\/media_publish$/, (u, o) => { assert.equal(new URLSearchParams(o.body).get('creation_id'), 'c9'); return { id: 'm9' }; }],
    ['GET', /\/m9\?/, () => ({ permalink: 'https://www.instagram.com/reel/m9/', timestamp: '2026-11-08T23:00:01+0000' })],
  ]);
  const ig = new InstagramClient({ getConfig: () => ({ instagram: { token: 'IGTOKEN', userId: '178', apiVersion: 'v27.0' } }), fetchImpl: fetch, sleepImpl: async () => {} });
  const r = await ig.publishReel({ videoUrl: 'https://1-2-3-4.sslip.io/v/tok/final.mp4', caption: 'Hi #ai', shareToFeed: true, thumbOffsetMs: 1200 });
  assert.equal(form.get('media_type'), 'REELS');
  assert.equal(form.get('video_url'), 'https://1-2-3-4.sslip.io/v/tok/final.mp4');
  assert.equal(form.get('share_to_feed'), 'true');
  assert.equal(form.get('access_token'), 'IGTOKEN');
  assert.equal(r.mediaId, 'm9');
  assert.equal(r.permalink, 'https://www.instagram.com/reel/m9/');
});

test('Instagram: Verarbeitungsfehler und API-Fehler werden verständlich gemeldet', async () => {
  const cfg = () => ({ instagram: { token: 'T', userId: '1', apiVersion: 'v27.0' } });
  const bad = new InstagramClient({ getConfig: cfg, sleepImpl: async () => {}, fetchImpl: mockFetch([
    ['POST', /\/1\/media$/, () => ({ id: 'c1' })],
    ['GET', /\/c1\?/, () => ({ status_code: 'ERROR', status: 'Video too short' })],
  ]) });
  await assert.rejects(bad.publishReel({ videoUrl: 'https://x/v.mp4', caption: '' }), /verarbeitet das Video nicht \(Video too short\)/);
  const denied = new InstagramClient({ getConfig: cfg, fetchImpl: mockFetch([['GET', /\/me\?/, () => ({ __status: 400, json: { error: { message: 'Invalid OAuth access token', code: 190 } } })]]) });
  await assert.rejects(denied.me(), /Invalid OAuth access token \(Code 190\)/);
});

// ---------- Trend-Radar ----------
test('Radar: Hacker News nur KI-Themen, Reddit ab 150 Upvotes, ein Ausfall stoppt die anderen nicht', async () => {
  const now = Date.parse('2026-11-08T12:00:00Z');
  const fetch = mockFetch([
    ['GET', /hn\.algolia/, () => ({ hits: [
      { title: 'Claude writes a compiler', url: 'https://x.org/a', points: 500, num_comments: 120, created_at_i: now / 1000 - 3600 * 5, objectID: '1' },
      { title: 'Rust 2.0 released', url: 'https://x.org/b', points: 900, num_comments: 300, created_at_i: now / 1000 - 3600, objectID: '2' },
    ] })],
    ['GET', /reddit\.com/, () => ({ data: { children: [
      { data: { title: 'Humanoid robot folds laundry', score: 4000, num_comments: 300, permalink: '/r/singularity/x', created_utc: now / 1000 - 7200, subreddit: 'singularity' } },
      { data: { title: 'meh', score: 20, permalink: '/r/x/y', created_utc: now / 1000, subreddit: 'x' } },
    ] } })],
  ]);
  const claude = { ready: false };
  const cfg = { trends: { youtubeKey: '', keywords: 'AI', subreddits: 'singularity', hn: true, reddit: true, webSearch: true } };
  const r = await trends.collectSignals({ cfg, fetch, claude, now });
  assert.deepEqual(r.signals.map((s) => s.source).sort(), ['hn', 'reddit']);
  assert.equal(r.signals.find((s) => s.source === 'hn').title, 'Claude writes a compiler');
  assert.equal(r.sources.youtube.skipped, 'kein YouTube-Schlüssel');
  assert.equal(r.sources.web.skipped, 'kein Claude-Schlüssel');

  const broken = mockFetch([['GET', /reddit\.com/, () => ({ data: { children: [] } })]]);
  const r2 = await trends.collectSignals({ cfg, fetch: broken, claude, now });
  assert.ok(r2.sources.hn.error);
  assert.equal(r2.sources.reddit.count, 0);
});

test('Radar: YouTube misst Aufrufe pro Stunde', async () => {
  const now = Date.parse('2026-11-08T12:00:00Z');
  const fetch = mockFetch([
    ['GET', /youtube\/v3\/search/, (u) => { assert.match(u, /order=viewCount/); assert.match(u, /publishedAfter=2026-11-01/); return { items: [{ id: { videoId: 'abc' } }] }; }],
    ['GET', /youtube\/v3\/videos/, () => ({ items: [{ id: 'abc', snippet: { title: 'GPT-6 explained', publishedAt: '2026-11-06T12:00:00Z', channelTitle: 'X' }, statistics: { viewCount: '960000' } }] })],
  ]);
  const r = await trends.youtube({ key: 'k', keywords: ['AI'], fetch, now });
  assert.equal(r.items[0].velocity, 20000);
  assert.match(r.items[0].label, /960 Tsd\. Aufrufe in 2 Tagen/);
});

// ---------- Stimme, Szenen, Untertitel ----------
test('Wortzeiten aus Zeichen-Zeitstempeln, Szenen füllen die volle Länge', () => {
  const text = 'Hello big world. Next scene here';
  const chars = [...text];
  const al = { characters: chars, character_start_times_seconds: chars.map((_, i) => i * 0.1), character_end_times_seconds: chars.map((_, i) => i * 0.1 + 0.1) };
  const words = voice.wordsFromAlignment(al);
  assert.deepEqual(words.map((w) => w.w), ['Hello', 'big', 'world.', 'Next', 'scene', 'here']);
  assert.ok(Math.abs(words[3].s - 1.7) < 1e-9);
  const t = voice.sceneTimes(['Hello big world.', 'Next scene here'], words, 4);
  assert.equal(t[0].start, 0);
  assert.ok(Math.abs(t[1].start - 1.7) < 1e-9);
  assert.ok(Math.abs(t[0].durationS + t[1].durationS - 4) < 1e-9);
});

test('Untertitel: Hook oben, höchstens drei Wörter pro Zeile, aktuelles Wort hervorgehoben', () => {
  const words = 'This AI thinks for minutes, not seconds.'.split(' ').map((w, i) => ({ w, s: i * 0.5, e: i * 0.5 + 0.4 }));
  assert.ok(R.groupWords(words).every((g) => g.length <= 3));
  const ass = R.buildAss({ words, hook: 'AI {that} thinks' });
  assert.match(ass, /Hook,,0,0,0,,\{\\fad\(100,220\)\}AI THAT THINKS/);
  assert.match(ass, /\{\\c&H000AD6FF&/);
  assert.equal(R.assTime(61.234), '0:01:01.23');
});

// ---------- Zeit und Zeitplaner ----------
test('Zeitzonen: Wanduhrzeit in New York richtig umgerechnet (auch nach Zeitumstellung)', () => {
  assert.equal(U.zonedToDate(2026, 11, 8, 19, 0, 'America/New_York').toISOString(), '2026-11-09T00:00:00.000Z');
  assert.equal(U.zonedToDate(2026, 10, 30, 19, 0, 'America/New_York').toISOString(), '2026-10-30T23:00:00.000Z');
  assert.equal(U.zonedToDate(2026, 7, 1, 12, 0, 'Europe/Berlin').toISOString(), '2026-07-01T10:00:00.000Z');
});

test('Zeitplaner: Radar täglich 07:00 mit Nachholfenster, Vollautomatik nur wenn eingeschaltet', () => {
  const { engine } = makeEngine();
  const s = new Scheduler(engine);
  const job = (n) => s.jobs().find((j) => j.name === n);
  assert.equal(s.isDue(job('radar'), new Date('2026-11-08T06:59:00'), { lastRun: '2026-11-07T07:00:10' }), false);
  assert.equal(s.isDue(job('radar'), new Date('2026-11-08T07:00:30'), { lastRun: '2026-11-07T07:00:10' }), true);
  assert.equal(s.isDue(job('radar'), new Date('2026-11-08T12:00:00'), { lastRun: '2026-11-07T07:00:10' }), true, 'Server war morgens aus → mittags nachholen');
  assert.equal(s.isDue(job('radar'), new Date('2026-11-08T20:00:00'), { lastRun: '2026-11-07T07:00:10' }), false);
  assert.equal(s.isDue(job('autoProduce'), new Date('2026-11-08T08:30:00'), {}), false);
  assert.equal(s.isDue(job('weeklyReview'), new Date('2026-11-08T10:05:00'), { lastRun: '2026-11-01T10:00:00' }), true);
  assert.equal(s.isDue(job('publishDue'), new Date('2026-11-08T10:05:00'), { lastRun: '2026-11-08T10:04:30' }), false);
});
