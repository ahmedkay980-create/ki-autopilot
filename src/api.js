'use strict';
// HTTP: App-Dateien, Anmeldung, Schnittstelle für die App, Videodateien (privat für die App, öffentlich für Instagram).
const fs = require('node:fs');
const path = require('node:path');
const { maskConfig, mergeConfig } = require('./config');
const { checkPassword, hashPassword, parseCookies, Throttle } = require('./auth');
const M = require('./metrics');
const voice = require('./voice');
const U = require('./util');

const PUBLIC = path.join(__dirname, '..', 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.ico': 'image/x-icon',
};

function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, { 'content-type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}

function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('Anfrage zu groß')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('Ungültiges JSON')); }
    });
    req.on('error', reject);
  });
}

function serveFile(req, res, file, { cache = 'no-cache' } = {}) {
  let st;
  try { st = fs.statSync(file); } catch { return send(res, 404, { error: 'Nicht gefunden' }); }
  if (!st.isFile()) return send(res, 404, { error: 'Nicht gefunden' });
  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : st.size - 1;
    start = Math.max(0, start);
    end = Math.min(st.size - 1, end);
    if (start > end) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { 'content-type': type, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${st.size}`, 'accept-ranges': 'bytes', 'cache-control': cache });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'accept-ranges': 'bytes', 'cache-control': cache });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

/** Video für die App: schwere Felder weglassen. */
function slimVideo(v) {
  const { voice: vo, research, scenes, ...rest } = v;
  return {
    ...rest,
    research: research ? { sources: research.sources, preview: String(research.text || '').slice(0, 1200) } : null,
    voice: vo ? { durationS: vo.durationS } : null,
    scenes: (scenes || []).map((s) => ({ i: s.i, status: s.status, durationS: s.durationS, error: s.error || null, prompt: s.prompt })),
    metrics: M.videoMetrics(v),
  };
}

function buildState(engine, scheduler) {
  const db = engine.db;
  const cfg = engine.cfg;
  const now = engine.now();
  const month = U.monthKey(now);
  const topics = db.topics.filter((t) => t.status === 'neu' || t.status === 'in-produktion' || t.source === 'manuell' && t.status !== 'verworfen' && t.status !== 'produziert')
    .concat(db.topics.filter((t) => t.status === 'alt').slice(0, 10));
  return {
    now: now.toISOString(),
    cfg: maskConfig(cfg),
    status: {
      autopilot: cfg.autopilot, dryRun: cfg.dryRun, autoPost: cfg.autoPost,
      claude: engine.claude.ready, fal: Boolean(cfg.video.falKey), voice: Boolean(cfg.voice.provider === 'openai' ? cfg.voice.openaiKey : cfg.voice.elevenKey),
      instagram: engine.ig.ready, youtubeKey: Boolean(cfg.trends.youtubeKey), publicUrl: engine.publicUrl(),
      yt: engine.yt.ready, ytConfigured: engine.yt.configured, ytChannel: cfg.youtube.channelTitle, ytRedirect: engine.publicUrl() ? engine.publicUrl() + '/oauth/youtube' : '',
      github: engine.gh.canWrite,
      pushKey: cfg.push.publicKey, pushDevices: (db.pushSubs || []).length,
      current: engine.current, queue: engine.queue,
    },
    budget: { month, spent: db.costs[month] || { usd: 0 }, limit: cfg.budget.monthlyUsd, estimate: engine.estimate() },
    nextSlot: engine.nextPostTime().toISOString(),
    maintenance: { ...db.maintenance, version: engine.version(), repo: engine.gh.repo },
    radar: db.radar,
    topics: topics.slice(0, 40),
    videos: db.videos.filter((v) => v.status !== 'verworfen').slice(0, 40).map(slimVideo),
    comments: db.comments.slice(0, 200),
    reports: db.reports.slice(0, 8),
    learnings: db.learnings,
    notifications: db.notifications.slice(0, 60),
    log: db.log.slice(0, 150),
    jobs: scheduler.overview(),
    followers: db.followers.slice(-90),
    stats: { week: M.totals(db.videos, now.getTime(), 7), month: M.totals(db.videos, now.getTime(), 30), formats: M.formatStats(db.videos) },
  };
}

function createHandler(engine, scheduler, { open = false } = {}) {
  const throttle = new Throttle();

  const authed = (req) => {
    if (!engine.cfg.auth.passwordHash) return open;
    return engine.checkSession(parseCookies(req.headers.cookie).sid);
  };

  const routes = [
    ['GET', /^\/api\/state$/, () => buildState(engine, scheduler)],
    ['POST', /^\/api\/logout$/, (m, b, req, res) => {
      engine.dropSession(parseCookies(req.headers.cookie).sid);
      res.setHeader('set-cookie', 'sid=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
      return { ok: true };
    }],
    ['POST', /^\/api\/config$/, (m, b) => { engine.saveConfig(mergeConfig(engine.cfg, b)); return { ok: true }; }],
    ['POST', /^\/api\/password$/, (m, b) => {
      if (engine.cfg.auth.passwordHash && !checkPassword(b.current || '', engine.cfg.auth.passwordHash)) throw Object.assign(new Error('Das aktuelle Passwort stimmt nicht.'), { status: 400 });
      if (String(b.next || '').length < 10) throw Object.assign(new Error('Das neue Passwort braucht mindestens 10 Zeichen.'), { status: 400 });
      const c = structuredClone(engine.cfg);
      c.auth.passwordHash = hashPassword(b.next);
      engine.saveConfig(c);
      return { ok: true };
    }],
    ['POST', /^\/api\/radar\/run$/, async () => ({ result: await scheduler.run('radar') })],
    ['POST', /^\/api\/topics$/, (m, b) => engine.addTopic(b)],
    ['POST', /^\/api\/topics\/([\w-]+)\/produce$/, (m) => slimVideo(engine.produce(m[1]))],
    ['POST', /^\/api\/topics\/([\w-]+)\/discard$/, (m) => engine.discardTopic(m[1])],
    ['POST', /^\/api\/videos\/([\w-]+)\/retry$/, (m) => slimVideo(engine.retry(m[1]))],
    ['POST', /^\/api\/videos\/([\w-]+)\/stop$/, (m) => slimVideo(engine.stop(m[1]))],
    ['POST', /^\/api\/videos\/([\w-]+)\/discard$/, (m) => slimVideo(engine.discardVideo(m[1]))],
    ['POST', /^\/api\/videos\/([\w-]+)\/approve$/, (m) => slimVideo(engine.approve(m[1]))],
    ['POST', /^\/api\/videos\/([\w-]+)\/post-now$/, (m) => slimVideo(engine.postNow(m[1]))],
    ['POST', /^\/api\/comments\/([\w-]+)\/reply$/, async (m, b) => engine.sendReply(m[1], b.text)],
    ['POST', /^\/api\/comments\/([\w-]+)\/ignore$/, (m) => engine.ignoreComment(m[1])],
    ['POST', /^\/api\/jobs\/(\w+)\/run$/, async (m) => ({ result: await scheduler.run(m[1]) })],
    ['POST', /^\/api\/test\/(\w+)$/, async (m) => ({ text: await engine.testService(m[1]) })],
    ['GET', /^\/api\/voices$/, async () => ({ voices: await voice.listVoices({ cfg: engine.cfg, fetch: engine.fetch }) })],
    ['POST', /^\/api\/instagram\/connect$/, async (m, b) => engine.connectInstagram(b)],
    ['GET', /^\/api\/youtube\/auth-url$/, () => ({ url: engine.youtubeAuthUrl() })],
    ['POST', /^\/api\/youtube\/disconnect$/, () => { const c = structuredClone(engine.cfg); c.youtube.refreshToken = ''; c.youtube.channelId = ''; c.youtube.channelTitle = ''; engine.saveConfig(c); return { ok: true }; }],
    ['POST', /^\/api\/update$/, () => engine.requestUpdate()],
    ['POST', /^\/api\/push\/subscribe$/, (m, b) => { engine.addPushSub(b); return { ok: true }; }],
    ['POST', /^\/api\/notifications\/read$/, () => { engine.store.update((db) => db.notifications.forEach((n) => { n.read = true; })); return { ok: true }; }],
  ];

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = decodeURIComponent(url.pathname);
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    try {
      // Öffentlich: fertiges Video für Instagram (unratbarer Schlüssel im Pfad)
      let m = /^\/v\/([\w-]{16,})\/(final\.mp4)$/.exec(p);
      if (m && method === 'GET') {
        const v = engine.db.videos.find((x) => x.render && x.render.token === m[1]);
        if (!v) return send(res, 404, { error: 'Nicht gefunden' });
        return serveFile(req, res, path.join(engine.vdir(v), m[2]));
      }

      if (p === '/oauth/youtube' && method === 'GET') {
        if (!authed(req)) return send(res, 302, '', { location: '/' });
        const page = (title, text) => send(res, 200, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font:16px system-ui;background:#0b0d12;color:#eef0f6;padding:32px"><h1 style="font-size:22px">${title}</h1><p>${text}</p><p><a style="color:#b4aaff" href="/#mehr">Zurück zur App</a></p></body>`, { 'content-type': 'text/html; charset=utf-8' });
        const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        if (url.searchParams.get('error')) return page('YouTube nicht verbunden', esc(url.searchParams.get('error')));
        try {
          const ch = await engine.youtubeCallback({ code: url.searchParams.get('code'), state: url.searchParams.get('state') });
          return send(res, 302, '', { location: '/#mehr', 'set-cookie': `yt=${encodeURIComponent(ch.title)}; Path=/; Max-Age=60; SameSite=Lax` });
        } catch (e) { return page('YouTube nicht verbunden', esc(e.message)); }
      }

      if (p === '/api/session' && method === 'GET') {
        return send(res, 200, { authed: authed(req), passwordSet: Boolean(engine.cfg.auth.passwordHash), open });
      }
      if (p === '/api/login' && method === 'POST') {
        const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
        if (throttle.blocked(ip)) return send(res, 429, { error: 'Zu viele Versuche. Bitte 15 Minuten warten.' });
        const b = await readBody(req);
        if (!checkPassword(b.password || '', engine.cfg.auth.passwordHash)) { throttle.fail(ip); return send(res, 401, { error: 'Falsches Passwort.' }); }
        throttle.reset(ip);
        const sid = engine.createSession(req.headers['user-agent']);
        const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
        return send(res, 200, { ok: true }, { 'set-cookie': `sid=${sid}; Path=/; Max-Age=15552000; HttpOnly; SameSite=Lax${secure}` });
      }

      if (p.startsWith('/api/') || p.startsWith('/media/')) {
        if (!authed(req)) {
          const msg = engine.cfg.auth.passwordHash ? 'Bitte anmelden.' : 'Auf dem Server ist kein Passwort gesetzt (APP_PASSWORD).';
          return send(res, 401, { error: msg });
        }
        // Öffentliche Adresse beim ersten Aufruf über HTTPS automatisch merken
        const fwdHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
        if (!engine.cfg.publicUrl && req.headers['x-forwarded-proto'] === 'https' && fwdHost && !/^(127\.|localhost)/.test(fwdHost)) {
          const c = structuredClone(engine.cfg);
          c.publicUrl = 'https://' + fwdHost;
          engine.saveConfig(c);
        }
      }

      m = /^\/media\/([\w-]+)\/(final\.mp4|cover\.jpg|voice\.mp3)$/.exec(p);
      if (m && method === 'GET') {
        const v = engine.video(m[1]);
        if (!v) return send(res, 404, { error: 'Nicht gefunden' });
        return serveFile(req, res, path.join(engine.vdir(v), m[2]), { cache: 'private, max-age=3600' });
      }

      for (const [rm, re, fn] of routes) {
        const mm = rm === method && re.exec(p);
        if (!mm) continue;
        const body = method === 'POST' ? await readBody(req) : {};
        const out = await fn(mm, body, req, res);
        return send(res, 200, out === undefined ? { ok: true } : out);
      }
      if (p.startsWith('/api/')) return send(res, 404, { error: 'Unbekannte Anfrage' });

      // App-Dateien
      const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
      const file = path.normalize(path.join(PUBLIC, rel));
      if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, { error: 'Verboten' });
      if (!fs.existsSync(file)) return serveFile(req, res, path.join(PUBLIC, 'index.html'));
      return serveFile(req, res, file, { cache: /\/icons\//.test(file) ? 'public, max-age=604800' : 'no-cache' });
    } catch (e) {
      const status = e.status && e.status < 500 ? e.status : 400;
      return send(res, status, { error: e.message });
    }
  };
}

module.exports = { createHandler, buildState, slimVideo };
