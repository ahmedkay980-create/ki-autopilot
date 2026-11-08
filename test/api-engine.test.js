'use strict';
const { makeEngine, mockFetch } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Scheduler } = require('../src/scheduler');
const { createHandler } = require('../src/api');

async function withServer(engine, fn, opts = {}) {
  const server = http.createServer(createHandler(engine, new Scheduler(engine), opts));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); }
}
const post = (base, p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body || {}) });

function fakeRenderedVideo(engine, patch = {}) {
  const v = {
    id: 'v_test', topicId: 't0', title: 'Test video', format: 'news60', status: 'geplant', createdAt: engine.nowIso(), updatedAt: engine.nowIso(), history: [],
    script: { caption: 'Caption here?', hashtags: ['ai'], sources: [{ title: 'OpenAI', url: 'https://www.openai.com/x' }], scenes: [] },
    render: { file: 'final.mp4', cover: 'cover.jpg', durationS: 30, bytes: 10, token: 'abcdefghijklmnopqrstuvwx', at: engine.nowIso() },
    schedule: { at: engine.nowIso() }, ...patch,
  };
  fs.mkdirSync(engine.vdir(v), { recursive: true });
  fs.writeFileSync(path.join(engine.vdir(v), 'final.mp4'), Buffer.from('0123456789'));
  engine.store.update((db) => db.videos.unshift(v));
  return v;
}

test('Zugang: ohne Anmeldung nichts, Passwort-Bremse, Geheimnisse maskiert, Video für Instagram öffentlich', async () => {
  const { engine } = makeEngine({ env: { APP_PASSWORD: 'richtig-langes-passwort' }, config: { anthropic: { apiKey: 'sk-ant-geheim-9876' } } });
  fakeRenderedVideo(engine);
  await withServer(engine, async (base) => {
    assert.equal((await fetch(base + '/api/state')).status, 401);
    assert.equal((await fetch(base + '/media/v_test/final.mp4')).status, 401);
    assert.equal((await post(base, '/api/login', { password: 'falsch' })).status, 401);

    const ok = await post(base, '/api/login', { password: 'richtig-langes-passwort' }, { 'x-forwarded-proto': 'https' });
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    const sid = cookie.split(';')[0];

    const st = await (await fetch(base + '/api/state', { headers: { cookie: sid, 'x-forwarded-proto': 'https', 'x-forwarded-host': '5-6-7-8.sslip.io' } })).json();
    assert.equal(st.cfg.anthropic.apiKey, '••••9876');
    assert.equal(st.cfg.auth.passwordHash, undefined);
    assert.equal(engine.cfg.publicUrl, 'https://5-6-7-8.sslip.io', 'öffentliche Adresse automatisch erkannt');

    const pub = await fetch(base + '/v/abcdefghijklmnopqrstuvwx/final.mp4', { headers: { range: 'bytes=2-5' } });
    assert.equal(pub.status, 206);
    assert.equal(await pub.text(), '2345');
    assert.equal((await fetch(base + '/v/falscherschluessel123456/final.mp4')).status, 404);
    assert.ok([403, 404].includes((await fetch(base + '/..%2f..%2fpackage.json')).status));

    // Maskierter Schlüssel überschreibt den echten nicht
    await post(base, '/api/config', { anthropic: { apiKey: '••••9876', model: 'claude-haiku-5-5' } }, { cookie: sid });
    assert.equal(engine.cfg.anthropic.apiKey, 'sk-ant-geheim-9876');
    assert.equal(engine.cfg.anthropic.model, 'claude-haiku-5-5');

    for (let i = 0; i < 8; i++) await post(base, '/api/login', { password: 'nope' }, { 'x-forwarded-for': '9.9.9.9' });
    assert.equal((await post(base, '/api/login', { password: 'richtig-langes-passwort' }, { 'x-forwarded-for': '9.9.9.9' })).status, 429);
  });
});

test('Ohne Passwort ist der Server gesperrt, außer lokal', async () => {
  const { engine } = makeEngine();
  await withServer(engine, async (base) => { assert.equal((await fetch(base + '/api/state')).status, 401); });
  await withServer(engine, async (base) => { assert.equal((await fetch(base + '/api/state')).status, 200); }, { open: true });
});

test('Live-Posten: Instagram holt das Video über die öffentliche Adresse', async () => {
  let form;
  const fetch = mockFetch([
    ['POST', /graph\.instagram\.com\/v27\.0\/178\/media$/, (u, o) => { form = new URLSearchParams(o.body); return { id: 'c1' }; }],
    ['GET', /\/c1\?/, () => ({ status_code: 'FINISHED' })],
    ['POST', /\/178\/media_publish$/, () => ({ id: 'm1' })],
    ['GET', /\/m1\?/, () => ({ permalink: 'https://www.instagram.com/reel/m1/' })],
  ]);
  const { engine } = makeEngine({ fetch, config: { dryRun: false, publicUrl: 'https://1-2-3-4.sslip.io', instagram: { token: 'IG', userId: '178' } } });
  const v = fakeRenderedVideo(engine);
  await engine.publish(v.id);
  assert.equal(form.get('video_url'), 'https://1-2-3-4.sslip.io/v/abcdefghijklmnopqrstuvwx/final.mp4');
  assert.match(form.get('caption'), /Caption here\?\n\nSources: openai\.com\n\nVisuals and voice are AI-generated\.\n\n#ai/);
  assert.equal(v.status, 'online');
  assert.equal(v.published.permalink, 'https://www.instagram.com/reel/m1/');
});

test('Verpasster Termin wird neu geplant, Netzfehler werden automatisch wiederholt', async () => {
  const fetch = mockFetch([]); // Instagram nicht erreichbar → 404 aus dem Mock
  const { engine, clock } = makeEngine({ fetch, config: { dryRun: false, publicUrl: 'https://x.sslip.io', instagram: { token: 'IG', userId: '1' } } });
  const v = fakeRenderedVideo(engine, { schedule: { at: '2026-11-08T05:00:00Z' } });
  assert.match(await engine.jobPublishDue(), /neu geplant/);
  assert.ok(Date.parse(v.schedule.at) > clock.now().getTime());

  engine.store.update(() => { v.status = 'fehler'; v.retryable = true; v.updatedAt = '2026-11-08T13:00:00Z'; });
  assert.match(await engine.jobRetryFailed(), /1 neu gestartet/);
  assert.equal(v.status, 'geplant', 'fertiges Video: nur das Posten wird wiederholt');
  assert.equal(v.autoRetries, 1);
});

test('Kommentare: Lob wird automatisch bedankt, Fragen als Entwurf, eigene übersprungen, Video-Ideen landen im Radar', async () => {
  const fetch = mockFetch([
    ['GET', /\/m1\/comments\?/, () => ({ data: [
      { id: 'k1', text: 'This is awesome 🔥', username: 'fan1', timestamp: '2026-11-08T12:00:00+0000' },
      { id: 'k2', text: 'Which tool is free?', username: 'curious', timestamp: '2026-11-08T12:01:00+0000' },
      { id: 'k3', text: 'thanks all', username: 'ai.autopilot', timestamp: '2026-11-08T12:02:00+0000' },
    ] })],
    ['POST', /\/k\d\/replies$/, () => ({ id: 'r' })],
  ]);
  const { engine } = makeEngine({ fetch, config: { dryRun: false, instagram: { token: 'IG', userId: '1', username: 'ai.autopilot' } } });
  fakeRenderedVideo(engine, { status: 'online', published: { at: '2026-11-08T10:00:00Z', mediaId: 'm1' } });
  const res = await engine.jobComments();
  assert.match(res, /2 neu, 1 automatisch beantwortet, 1 Entwürfe/);
  assert.equal(engine.db.comments.find((c) => c.id === 'k1').status, 'beantwortet');
  assert.ok(fetch.calls.some((c) => /\/k1\/replies$/.test(c.url)));
  assert.equal(engine.db.comments.find((c) => c.id === 'k2').status, 'entwurf');
  assert.ok(!engine.db.comments.some((c) => c.id === 'k3'));
});

test('Instagram verbinden: Konto erkannt, Handle übernommen, Zugang wird später verlängert', async () => {
  const fetch = mockFetch([
    ['GET', /graph\.instagram\.com\/v27\.0\/me\?/, () => ({ id: 'app-scoped', user_id: '1789', username: 'ai.autopilot', account_type: 'MEDIA_CREATOR', followers_count: 12 })],
    ['GET', /refresh_access_token/, (u) => { assert.match(u, /grant_type=ig_refresh_token/); return { access_token: 'NEU', expires_in: 5184000 }; }],
  ]);
  const { engine, clock } = makeEngine({ fetch });
  const me = await engine.connectInstagram({ token: 'IGAAtoken' });
  assert.equal(me.userId, '1789');
  assert.equal(engine.cfg.instagram.userId, '1789');
  assert.equal(engine.cfg.channel.handle, '@ai.autopilot');
  assert.equal(await engine.jobTokenRefresh(), 'noch frisch');
  clock.add(8 * 864e5);
  assert.equal(await engine.jobTokenRefresh(), 'Instagram-Zugang verlängert');
  assert.equal(engine.cfg.instagram.token, 'NEU');
});
