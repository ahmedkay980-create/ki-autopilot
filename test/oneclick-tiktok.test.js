'use strict';
const { makeEngine, mockFetch, media } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { TikTokClient, chunkPlan } = require('../src/tiktok');
const { claudeRoute, elevenRoute, falRoutes } = require('./mocks');

function tiktokRoutes(log, { mode = 'entwurf' } = {}) {
  return [
    ['POST', /open\.tiktokapis\.com\/v2\/oauth\/token\/$/, (u, o) => { log.push('token'); assert.match(o.body, /grant_type=refresh_token/); return { access_token: 'TT', expires_in: 86400, refresh_token: 'rt-tt' }; }],
    ['POST', /\/v2\/post\/publish\/creator_info\/query\/$/, () => ({ data: { creator_nickname: 'AI Daily', privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'] }, error: { code: 'ok' } })],
    ['POST', /\/v2\/post\/publish\/(inbox\/)?video\/init\/$/, (u, o) => {
      const b = JSON.parse(o.body);
      log.push(u.includes('/inbox/') ? 'inbox-init' : 'direct-init');
      log.push(b);
      return { data: { publish_id: 'p_1', upload_url: 'https://open-upload.tiktokapis.com/video/?upload_id=1&upload_token=x' }, error: { code: 'ok' } };
    }],
    ['PUT', /open-upload\.tiktokapis\.com\/video\//, (u, o) => { log.push('put:' + o.headers['content-range']); return { __status: 201, json: {} }; }],
    ['POST', /\/v2\/post\/publish\/status\/fetch\/$/, () => ({ data: { status: mode === 'direkt' ? 'PUBLISH_COMPLETE' : 'SEND_TO_USER_INBOX', publicaly_available_post_id: mode === 'direkt' ? [7311] : [] }, error: { code: 'ok' } })],
  ];
}

test('TikTok: Aufteilung laut Media Transfer Guide', () => {
  assert.deepEqual(chunkPlan(20 * 1024 * 1024), { chunkSize: 20 * 1024 * 1024, count: 1 });
  assert.deepEqual(chunkPlan(95 * 1024 * 1024), { chunkSize: 10 * 1024 * 1024, count: 9 });
});

test('TikTok: Direkt-Post mit KI-Kennzeichnung und Datei-Upload, Entwurf ins Postfach', async () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'tt-'));
  const file = path.join(dir, 'v.mp4');
  fs.writeFileSync(file, Buffer.alloc(1234, 1));
  const cfg = { tiktok: { clientKey: 'ck', clientSecret: 'cs', refreshToken: 'rt', enabled: true, username: 'ai.daily' } };
  const log = [];
  const tt = new TikTokClient({ getConfig: () => cfg, fetchImpl: mockFetch(tiktokRoutes(log, { mode: 'direkt' })), sleepImpl: async () => {} });
  const r = await tt.upload({ file, caption: 'Hello #ai', mode: 'direkt', privacy: 'PUBLIC_TO_EVERYONE' });
  const init = log.find((x) => typeof x === 'object');
  assert.equal(init.post_info.is_aigc, true);
  assert.equal(init.post_info.privacy_level, 'PUBLIC_TO_EVERYONE');
  assert.deepEqual(init.source_info, { source: 'FILE_UPLOAD', video_size: 1234, chunk_size: 1234, total_chunk_count: 1 });
  assert.ok(log.includes('put:bytes 0-1233/1234'));
  assert.equal(r.url, 'https://www.tiktok.com/@ai.daily/video/7311');

  const log2 = [];
  const tt2 = new TikTokClient({ getConfig: () => cfg, fetchImpl: mockFetch(tiktokRoutes(log2)), sleepImpl: async () => {} });
  const r2 = await tt2.upload({ file, caption: 'x', mode: 'entwurf' });
  assert.ok(log2.includes('inbox-init'));
  assert.equal(r2.draft, true);
});

test('Ein Knopf: Markt analysieren → Thema wählen → fertiges Video wartet auf OK → OK lädt parallel überall hoch', { timeout: 180e3 }, async () => {
  const { mp3, mp4 } = media();
  const claude = claudeRoute();
  const ttLog = [];
  let igForm;
  const fetch = mockFetch([
    claude.route, elevenRoute(mp3), ...falRoutes(mp4), ...tiktokRoutes(ttLog),
    ['GET', /hn\.algolia\.com/, () => ({ hits: [{ title: 'OpenAI ships a model that thinks for minutes', url: 'https://openai.com/x', points: 900, num_comments: 400, created_at_i: Math.floor(Date.parse('2026-11-08T10:00:00Z') / 1000), objectID: '1' }] })],
    ['GET', /reddit\.com/, () => ({ data: { children: [] } })],
    ['POST', /graph\.instagram\.com\/v27\.0\/178\/media$/, (u, o) => { igForm = new URLSearchParams(o.body); return { id: 'c1' }; }],
    ['GET', /graph\.instagram\.com\/v27\.0\/c1\?/, () => ({ status_code: 'FINISHED' })],
    ['POST', /\/178\/media_publish$/, () => ({ id: 'm1' })],
    ['GET', /graph\.instagram\.com\/v27\.0\/m1\?/, () => ({ permalink: 'https://www.instagram.com/reel/m1/' })],
    ['POST', /oauth2\.googleapis\.com\/token$/, () => ({ __status: 400, json: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } })],
  ]);
  const { engine } = makeEngine({ fetch, config: {
    anthropic: { apiKey: 'sk-ant-test' }, voice: { elevenKey: 'el' }, video: { falKey: 'fal' }, dryRun: false, publicUrl: 'https://1-2-3-4.sslip.io',
    instagram: { token: 'IG', userId: '178' }, tiktok: { clientKey: 'ck', clientSecret: 'cs', refreshToken: 'rt' }, youtube: { clientId: 'c', clientSecret: 's', refreshToken: 'r' },
  } });

  const v = engine.oneClick();
  assert.equal(v.status, 'analyse');
  assert.throws(() => engine.oneClick(), /Läuft schon/);
  await engine.idle();
  const done = engine.video(v.id);
  assert.equal(done.error, undefined, done.error);
  assert.equal(done.title, 'This AI model now thinks for minutes');
  assert.equal(done.status, 'fertig', 'wartet auf OK');
  const n = engine.db.notifications[0];
  assert.match(n.text, /mit OK sofort hochladen auf Instagram, TikTok, YouTube/);

  engine.postNow(done.id);
  await new Promise((r) => setTimeout(r, 50));
  for (let i = 0; i < 20 && engine.busy.size; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(done.status, 'online');
  assert.equal(done.platforms.instagram.status, 'ok');
  assert.equal(done.platforms.instagram.url, 'https://www.instagram.com/reel/m1/');
  assert.equal(done.platforms.tiktok.status, 'ok');
  assert.equal(done.platforms.tiktok.draft, true);
  assert.equal(done.platforms.youtube.status, 'fehler');
  assert.match(done.error, /Nicht hochgeladen: YouTube/);
  assert.match(igForm.get('video_url'), /^https:\/\/1-2-3-4\.sslip\.io\/v\/[\w-]+\/final\.mp4$/);
  assert.ok(engine.db.notifications.some((x) => /Online auf Instagram, TikTok/.test(x.text)));

  // Erneut: nur YouTube wird noch einmal versucht
  const before = fetch.calls.filter((c) => /graph\.instagram\.com\/v27\.0\/178\/media$/.test(c.url)).length;
  engine.postNow(done.id);
  for (let i = 0; i < 20 && engine.busy.size; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(fetch.calls.filter((c) => /graph\.instagram\.com\/v27\.0\/178\/media$/.test(c.url)).length, before, 'Instagram nicht doppelt');
  assert.equal(done.platforms.youtube.status, 'fehler');
});
