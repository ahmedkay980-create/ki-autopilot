'use strict';
const { makeEngine, mockFetch, media } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { SCRIPT, claudeRoute, elevenRoute, falRoutes } = require('./mocks');

const KEYS = { anthropic: { apiKey: 'sk-ant-test' }, voice: { elevenKey: 'el-test' }, video: { falKey: 'fal-test' }, autoPost: true };

test('Komplettlauf: Radar → Thema → Video (KI-Szenen, Stimme, Untertitel) → eingeplant → Trockenlauf-Post', { timeout: 180e3 }, async () => {
  const { mp3, mp4 } = media();
  const claude = claudeRoute();
  const fetch = mockFetch([
    claude.route, elevenRoute(mp3), ...falRoutes(mp4),
    ['GET', /hn\.algolia\.com/, () => ({ hits: [{ title: 'OpenAI ships a model that thinks for minutes', url: 'https://openai.com/x', points: 900, num_comments: 400, created_at_i: Math.floor(Date.parse('2026-11-08T10:00:00Z') / 1000), objectID: '1' }] })],
    ['GET', /reddit\.com/, () => ({ data: { children: [] } })],
  ]);
  const { engine } = makeEngine({ fetch, config: KEYS });

  const radar = await engine.jobRadar();
  assert.match(radar, /1 Themen aus 2 Signalen/);
  const topic = engine.db.topics.find((t) => t.status === 'neu');
  assert.equal(topic.format, 'news60');
  assert.ok(topic.evidence.length >= 1);

  const v = engine.produce(topic.id);
  await engine.idle();
  const done = engine.video(v.id);
  assert.equal(done.error, undefined, done.error);
  assert.equal(done.status, 'geplant');
  assert.equal(done.script.scenes[1].narration, 'OpenAI says it handles harder math problems.', 'Faktencheck-Korrektur übernommen');
  assert.equal(done.factCheck.pass, true);
  assert.deepEqual(done.script.hashtags, ['AI', 'openai', 'technews']);
  assert.equal(done.scenes.length, 4);
  assert.ok(done.scenes.every((s) => s.status === 'fertig'));
  const total = done.scenes.reduce((a, s) => a + s.durationS, 0);
  assert.ok(Math.abs(total - done.render.durationS) < 0.05, 'Szenen füllen die ganze Länge');

  const final = path.join(engine.vdir(done), 'final.mp4');
  assert.ok(fs.statSync(final).size > 50e3);
  const probe = await require('../src/render').probe(final);
  const vs = probe.streams.find((s) => s.codec_type === 'video');
  assert.equal(vs.width, 1080);
  assert.equal(vs.height, 1920);
  assert.ok(probe.streams.some((s) => s.codec_type === 'audio' && s.codec_name === 'aac'));
  assert.ok(fs.existsSync(path.join(engine.vdir(done), 'cover.jpg')));

  // Kosten: 4 Szenen × 6 s × 0,10 $ = 2,40 $ plus Claude
  const month = engine.db.costs['2026-11'];
  assert.ok(Math.abs(month.video - 2.4) < 1e-9);
  assert.ok(month.claude > 0 && month.search > 0);

  // Sendeplatz: nächster freier Slot 12:00 oder 19:00 New York
  const at = new Date(done.schedule.at);
  assert.equal(at.toISOString(), '2026-11-08T17:00:00.000Z', '15:00 Berlin = 09:00 New York → nächster Slot 12:00 New York = 17:00 UTC');

  engine.cfgStore.data.postTiming = 'slot';
  const clockNow = Date.parse(done.schedule.at) + 60e3;
  engine.clock = () => new Date(clockNow);
  assert.match(await engine.jobPublishDue(), /Posten gestartet/);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(done.status, 'online');
  assert.equal(done.published.dryRun, true);
});

test('Faktencheck mit Bedenken stoppt vor dem Geldausgeben, „Trotzdem freigeben“ macht weiter', { timeout: 180e3 }, async () => {
  const { mp3, mp4 } = media();
  const claude = claudeRoute({ factPass: false });
  const fetch = mockFetch([claude.route, elevenRoute(mp3), ...falRoutes(mp4)]);
  const { engine } = makeEngine({ fetch, config: { ...KEYS, video: { falKey: 'fal-test', mode: 'sparsam' } } });
  const t = engine.addTopic({ title: 'Is AI slowing down?' });
  const v = engine.produce(t.id);
  await engine.idle();
  assert.equal(engine.video(v.id).status, 'pruefen');
  assert.ok(!fetch.calls.some((c) => /elevenlabs/.test(c.url)), 'keine Stimme, keine Kosten vor der Prüfung');
  assert.match(engine.db.notifications[0].text, /Faktencheck hat Bedenken/);
  engine.approve(v.id);
  await engine.idle();
  const done = engine.video(v.id);
  assert.equal(done.status, 'geplant', done.error);
  assert.ok(done.scenes.every((s) => s.status === 'grafik'), 'sparsam: animierte Grafik statt KI-Szenen');
  assert.equal(engine.db.costs['2026-11'].video || 0, 0);
});

test('Monatsbudget schützt vor Überziehen', () => {
  const { engine } = makeEngine({ config: { ...KEYS, budget: { monthlyUsd: 3 } } });
  engine.addCost('video', 2);
  const t = engine.addTopic({ title: 'Robots at home' });
  assert.throws(() => engine.produce(t.id), /Monatsbudget erreicht/);
});

test('Ohne Claude-Schlüssel startet keine Produktion', () => {
  const { engine } = makeEngine();
  const t = engine.addTopic({ title: 'x' });
  assert.throws(() => engine.produce(t.id), /Claude-Schlüssel fehlt/);
});

