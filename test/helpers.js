'use strict';
// Test-Werkzeuge: feste Zeitzone, verstellbare Uhr, gefälschtes fetch (JSON und Binärdaten), echte Mini-Medien per ffmpeg.
process.env.TZ = 'Europe/Berlin';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

if (!process.env.VERBOSE) { console.log = () => {}; }

const { Engine } = require('../src/engine');
const { mergeConfig } = require('../src/config');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kia-test-'));

function makeClock(iso) {
  const c = { t: new Date(iso).getTime(), now: () => new Date(c.t), set(v) { c.t = new Date(v).getTime(); }, add(ms) { c.t += ms; } };
  return c;
}

function response(status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return {
    ok: status >= 200 && status < 300, status, headers: new Map(Object.entries(headers)),
    text: async () => buf.toString('utf8'), json: async () => JSON.parse(buf.toString('utf8')),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

/** routes: [[METHODE, /regex/, (url, opts) => antwort | {__status, json}]] */
function mockFetch(routes = []) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || 'GET').toUpperCase();
    calls.push({ url: u, method, opts });
    for (const [m, re, handler] of routes) {
      if (m === method && re.test(u)) {
        const r = await handler(u, opts);
        if (r && r.__status) return response(r.__status, r.json ?? {});
        return response(200, r);
      }
    }
    return response(404, { error: { message: `keine Route für ${method} ${u}` } });
  };
  fn.calls = calls;
  fn.routes = routes;
  return fn;
}

const MEDIA = tmpDir();
function media() {
  const mp3 = path.join(MEDIA, 'voice.mp3');
  const mp4 = path.join(MEDIA, 'clip.mp4');
  if (!fs.existsSync(mp3)) execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=180:duration=6', '-c:a', 'libmp3lame', '-b:a', '96k', mp3]);
  if (!fs.existsSync(mp4)) execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=720x1280:d=6:r=24', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', mp4]);
  return { mp3: fs.readFileSync(mp3), mp4: fs.readFileSync(mp4) };
}

function makeEngine({ now = '2026-11-08T15:00:00', fetch, config, env = {} } = {}) {
  const dir = tmpDir();
  const clock = makeClock(now);
  const engine = new Engine({ dataDir: dir, clock: clock.now, fetchImpl: fetch || mockFetch(), sleepImpl: async () => {}, env });
  if (config) engine.saveConfig(mergeConfig(engine.cfg, config));
  return { engine, dir, clock };
}

module.exports = { tmpDir, makeClock, mockFetch, response, media, makeEngine };
