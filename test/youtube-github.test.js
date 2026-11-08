'use strict';
const { makeEngine, mockFetch } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function rendered(engine, patch = {}) {
  const v = {
    id: 'v_yt', topicId: 't0', title: 'AI now thinks for minutes', format: 'news60', status: 'geplant', createdAt: engine.nowIso(), updatedAt: engine.nowIso(), history: [],
    script: { caption: 'Would you wait?', hashtags: ['ai', 'openai'], sources: [], scenes: [] },
    render: { file: 'final.mp4', cover: 'cover.jpg', durationS: 40, bytes: 10, token: 'abcdefghijklmnopqrstuvwx', at: engine.nowIso() },
    schedule: { at: engine.nowIso() }, ...patch,
  };
  fs.mkdirSync(engine.vdir(v), { recursive: true });
  fs.writeFileSync(path.join(engine.vdir(v), 'final.mp4'), Buffer.from('VIDEO-BYTES'));
  engine.store.update((db) => db.videos.unshift(v));
  return v;
}

const YT = { youtube: { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'GOCSPX-x', refreshToken: 'rt', channelId: 'UC1', channelTitle: 'AI Autopilot' } };

test('YouTube: Short hochladen (fortsetzbar), KI-Kennzeichnung gesetzt, Instagram-Ausfall bremst YouTube nicht', async () => {
  let meta;
  let putBody;
  const fetch = mockFetch([
    ['POST', /oauth2\.googleapis\.com\/token$/, (u, o) => { assert.match(o.body, /grant_type=refresh_token/); return { access_token: 'AT', expires_in: 3600 }; }],
    ['POST', /upload\/youtube\/v3\/videos\?uploadType=resumable/, (u, o) => { meta = JSON.parse(o.body); assert.equal(o.headers.authorization, 'Bearer AT'); return { __status: 200, json: {}, headers: { location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=xyz' } }; }],
    ['PUT', /upload_id=xyz/, (u, o) => { putBody = o.body; return { id: 'yt123', status: { privacyStatus: 'private', uploadStatus: 'uploaded' } }; }],
    ['POST', /graph\.instagram\.com\/v27\.0\/178\/media$/, () => ({ __status: 400, json: { error: { message: 'Media type not supported', code: 9004 } } })],
  ]);
  const { engine } = makeEngine({ fetch, config: { ...YT, dryRun: false, publicUrl: 'https://1-2-3-4.sslip.io', instagram: { token: 'IG', userId: '178' } } });
  const v = rendered(engine);
  await engine.publish(v.id);
  assert.equal(meta.status.containsSyntheticMedia, true);
  assert.equal(meta.status.privacyStatus, 'public');
  assert.equal(meta.snippet.categoryId, '28');
  assert.match(meta.snippet.description, /#Shorts$/);
  assert.equal(putBody.toString(), 'VIDEO-BYTES');
  assert.equal(v.status, 'online');
  assert.equal(v.youtube.id, 'yt123');
  assert.equal(v.youtube.restricted, true, 'öffentlich angefragt, privat erhalten → Projekt ungeprüft');
  assert.ok(engine.db.notifications.some((n) => /Instagram: „AI now thinks for minutes“ konnte dort nicht hochgeladen werden/.test(n.text)));
});

test('YouTube-Anmeldung: Zustand wird geprüft, Kanal übernommen', async () => {
  const fetch = mockFetch([
    ['POST', /oauth2\.googleapis\.com\/token$/, (u, o) => { assert.match(o.body, /redirect_uri=https%3A%2F%2F1-2-3-4\.sslip\.io%2Foauth%2Fyoutube/); return { access_token: 'AT', refresh_token: 'RT-NEU', expires_in: 3600 }; }],
    ['GET', /youtube\/v3\/channels\?part=snippet,statistics&mine=true/, () => ({ items: [{ id: 'UC9', snippet: { title: 'AI Daily' }, statistics: { subscriberCount: '42' } }] })],
  ]);
  const { engine } = makeEngine({ fetch, config: { publicUrl: 'https://1-2-3-4.sslip.io', youtube: { clientId: 'cid', clientSecret: 'sec' } } });
  const url = new URL(engine.youtubeAuthUrl());
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.match(url.searchParams.get('scope'), /youtube\.upload/);
  await assert.rejects(engine.youtubeCallback({ code: 'c', state: 'falsch' }), /abgelaufen/);
  const ch = await engine.youtubeCallback({ code: 'c', state: url.searchParams.get('state') });
  assert.equal(ch.title, 'AI Daily');
  assert.equal(engine.cfg.youtube.refreshToken, 'RT-NEU');
  assert.equal(engine.yt.ready, true);
});

test('Selbstwartung: Fehler wird einmal als Ticket gemeldet, ohne Schlüssel im Text, Wiederholung als Kommentar', async () => {
  const created = [];
  const comments = [];
  let open = [];
  const fetch = mockFetch([
    ['GET', /api\.github\.com\/repos\/ahmedkay980-create\/ki-autopilot\/issues\?state=open/, () => open],
    ['POST', /api\.github\.com\/repos\/ahmedkay980-create\/ki-autopilot\/issues$/, (u, o) => {
      const b = JSON.parse(o.body); created.push(b);
      open = [{ number: 7, title: b.title, html_url: 'https://github.com/x/7', body: b.body, created_at: 'now', comments: 0 }];
      return { number: 7, html_url: 'https://github.com/x/7' };
    }],
    ['POST', /issues\/7\/comments$/, (u, o) => { comments.push(JSON.parse(o.body)); return { id: 1 }; }],
    ['GET', /commits\?per_page=1/, () => [{ sha: 'abcdef1234567', html_url: 'https://github.com/c', commit: { message: 'Fix scene timing\n\nmore', committer: { date: '2026-11-08T01:45:00Z' } } }]],
  ]);
  const { engine, clock } = makeEngine({ fetch, config: { github: { token: 'github_pat_test' } } });
  engine.log('error', 'fal.ai said Key abcdefghijklmnopqrstuvwxyz123456 is bad');
  const r = await engine.reportProblem({ where: 'Produktion, Schritt szenen', message: 'Cannot read properties of undefined (reading "file")', stack: 'Error\n at makeScenes' });
  assert.equal(r.number, 7);
  assert.match(created[0].title, /^\[Auto\] Produktion, Schritt szenen/);
  assert.ok(!created[0].body.includes('abcdefghijklmnopqrstuvwxyz123456'), 'Schlüssel werden entfernt');
  assert.match(created[0].body, /ki-autopilot-fehler fp:/);
  assert.equal(await engine.reportProblem({ where: 'Produktion, Schritt szenen', message: 'Cannot read properties of undefined (reading "file")' }), null, 'innerhalb 12 Std. nicht erneut');
  clock.add(13 * 3600e3);
  const again = await engine.reportProblem({ where: 'Produktion, Schritt szenen', message: 'Cannot read properties of undefined (reading "file")' });
  assert.equal(again.existing, true);
  assert.equal(comments.length, 1);
  assert.match(await engine.jobGithubSync(), /1 offene Tickets/);
  assert.equal(engine.db.maintenance.latest.sha, 'abcdef1');
});
