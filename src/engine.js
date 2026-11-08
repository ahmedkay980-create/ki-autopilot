'use strict';
// Das Herz: Trend-Radar → Thema → Recherche → Skript → Faktencheck → Stimme → KI-Szenen → Schnitt → Instagram.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Store } = require('./store');
const U = require('./util');
const { DEFAULT_CONFIG, DEFAULT_DB, withDefaults } = require('./config');
const { ClaudeClient } = require('./claude');
const { InstagramClient } = require('./instagram');
const { YouTubeClient } = require('./youtube');
const { TikTokClient } = require('./tiktok');
const { GitHubClient, scrub } = require('./github');
const { Agents } = require('./agents');
const trends = require('./trends');
const voice = require('./voice');
const visuals = require('./visuals');
const R = require('./render');
const M = require('./metrics');
const webpush = require('./webpush');
const { hashPassword } = require('./auth');

const ACTIVE = ['analyse', 'wartet', 'recherche', 'skript', 'faktencheck', 'stimme', 'szenen', 'schnitt'];
class StopError extends Error {}

/** Fehler verständlich machen und erkennen, ob ein späterer neuer Versuch Sinn hat. */
function friendly(e) {
  const msg = (e && e.message) || String(e);
  const code = (e && e.cause && e.cause.code) || '';
  if (/fetch failed|socket hang up|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(msg + ' ' + code)) {
    return { text: 'Ein Dienst war nicht erreichbar (Internet des Servers?). Neuer Versuch folgt automatisch.', retryable: true };
  }
  if (/\b(429|500|502|503|529)\b|overloaded|Zeitüberschreitung|rate limit/i.test(msg)) return { text: msg, retryable: true };
  return { text: msg, retryable: false };
}
const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

class Engine {
  constructor({ dataDir, fetchImpl, clock, sleepImpl, env = process.env } = {}) {
    this.dataDir = dataDir;
    this.mediaDir = path.join(dataDir, 'videos');
    fs.mkdirSync(this.mediaDir, { recursive: true });
    this.fetch = fetchImpl || globalThis.fetch;
    this.clock = clock || (() => new Date());
    this.sleep = sleepImpl || U.sleep;
    this.env = env;

    this.cfgStore = new Store(path.join(dataDir, 'config.json'), DEFAULT_CONFIG);
    this.cfgStore.data = withDefaults(this.cfgStore.data);
    this.store = new Store(path.join(dataDir, 'db.json'), DEFAULT_DB);
    for (const [k, v] of Object.entries(DEFAULT_DB)) if (this.store.data[k] === undefined) this.store.data[k] = structuredClone(v);

    const getConfig = () => this.cfg;
    this.claude = new ClaudeClient({ getConfig, fetchImpl: this.fetch, sleepImpl: this.sleep, onUsage: (u) => this.addCost(u.searches ? 'search' : 'claude', u.usd) });
    this.ig = new InstagramClient({ getConfig, fetchImpl: this.fetch, sleepImpl: this.sleep, log: (l, m) => this.log(l, m) });
    this.agents = new Agents({ claude: this.claude, getConfig, getLearnings: () => this.db.learnings });
    this.yt = new YouTubeClient({ getConfig, fetchImpl: this.fetch, clock: () => this.now() });
    this.tt = new TikTokClient({
      getConfig, fetchImpl: this.fetch, clock: () => this.now(), sleepImpl: this.sleep,
      onRefreshToken: (t) => { const c = structuredClone(this.cfg); c.tiktok.refreshToken = t; this.saveConfig(c); },
    });
    this.gh = new GitHubClient({ getConfig, fetchImpl: this.fetch });

    this.queue = [];
    this.working = null;
    this.current = null;
    this.busy = new Set();
    this.initSecrets();
  }

  // ---------- Grundlagen ----------
  now() { return this.clock(); }
  nowIso() { return this.now().toISOString(); }
  get cfg() { return this.cfgStore.data; }
  get db() { return this.store.data; }
  saveConfig(next) { this.cfgStore.data = withDefaults(next); this.cfgStore.scheduleSave(); return this.cfg; }
  video(id) { return this.db.videos.find((v) => v.id === id); }
  topic(id) { return this.db.topics.find((t) => t.id === id); }
  vdir(v) { return path.join(this.mediaDir, v.id); }
  publicUrl() { return String(this.cfg.publicUrl || this.env.PUBLIC_URL || '').replace(/\/+$/, ''); }

  initSecrets() {
    const c = structuredClone(this.cfg);
    let changed = false;
    if (this.env.APP_PASSWORD && (!c.auth.passwordHash || this.env.RESET_PASSWORD === '1')) { c.auth.passwordHash = hashPassword(this.env.APP_PASSWORD); changed = true; }
    if (!c.push.publicKey) { Object.assign(c.push, webpush.generateVapidKeys()); changed = true; }
    if (this.env.PUBLIC_URL && !c.publicUrl) { c.publicUrl = this.env.PUBLIC_URL; changed = true; }
    if (changed) this.saveConfig(c);
  }

  /** Nach einem Neustart unterbrochene Produktionen fortsetzen (fertige Schritte werden übersprungen). */
  start() {
    for (const v of this.db.videos) {
      if (!ACTIVE.includes(v.status)) continue;
      this.hist(v, 'Nach Neustart fortgesetzt');
      if (v.status === 'analyse' || !v.topicId) this.runOneClick(v);
      else this.enqueue(v.id);
    }
  }

  log(level, msg) {
    this.store.update((db) => { db.log.unshift({ at: this.nowIso(), level, msg }); db.log.length = Math.min(db.log.length, 400); });
    if (level !== 'debug') console.log(`[${level}] ${msg}`);
  }

  hist(v, event) { this.store.update(() => { (v.history = v.history || []).push({ at: this.nowIso(), event }); v.updatedAt = this.nowIso(); }); }

  notify(text, { videoId, title = 'Autopilot', url, actions } = {}) {
    this.store.update((db) => {
      db.notifications.unshift({ id: U.uid('n_'), at: this.nowIso(), text, videoId: videoId || null, read: false });
      db.notifications.length = Math.min(db.notifications.length, 200);
    });
    this.pushAll({ title, body: text, url: url || (videoId ? `/#studio/${videoId}` : '/'), tag: videoId || 'autopilot', videoId: videoId || null, actions: actions || [] }).catch(() => {});
  }

  addCost(kind, usd) {
    if (!usd) return;
    this.store.update((db) => {
      const k = U.monthKey(this.now());
      const m = (db.costs[k] = db.costs[k] || { usd: 0, claude: 0, search: 0, voice: 0, video: 0, calls: 0 });
      m.usd += usd;
      m[kind] = (m[kind] || 0) + usd;
      m.calls++;
    });
  }
  monthSpent() { const m = this.db.costs[U.monthKey(this.now())]; return m ? m.usd : 0; }

  /** Geschätzte Kosten eines Videos in US-$. */
  estimate(scenes = this.cfg.video.maxScenes) {
    const v = this.cfg.video;
    const premium = v.mode === 'premium' && v.falKey;
    const clips = premium ? scenes * v.clipSeconds * v.pricePerSecond : 0;
    const voiceUsd = this.cfg.voice.provider === 'openai' ? 0.02 : 0;
    return Math.round((clips + 0.18 + voiceUsd) * 100) / 100;
  }

  checkBudget(est) {
    const limit = this.cfg.budget.monthlyUsd;
    const spent = this.monthSpent();
    if (limit > 0 && spent + est > limit) {
      throw new Error(`Monatsbudget erreicht: ${spent.toFixed(2)} von ${limit} $ verbraucht, dieses Video bräuchte ca. ${est.toFixed(2)} $. Budget in den Einstellungen erhöhen.`);
    }
  }

  // ---------- Sitzungen und Push ----------
  createSession(ua = '') {
    const t = U.token(32);
    this.store.update((db) => {
      db.sessions[sha(t)] = { created: this.nowIso(), lastSeen: this.nowIso(), ua: String(ua).slice(0, 120) };
      for (const [k, s] of Object.entries(db.sessions)) if (this.now() - Date.parse(s.lastSeen) > U.days(180)) delete db.sessions[k];
    });
    return t;
  }
  checkSession(t) {
    if (!t) return false;
    const s = this.db.sessions[sha(t)];
    if (!s) return false;
    if (this.now() - Date.parse(s.lastSeen) > U.hours(1)) this.store.update(() => { s.lastSeen = this.nowIso(); });
    return true;
  }
  dropSession(t) { this.store.update((db) => { delete db.sessions[sha(t)]; }); }

  addPushSub(sub) {
    if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) throw new Error('Ungültiges Push-Abo.');
    this.store.update((db) => {
      db.pushSubs = db.pushSubs.filter((s) => s.endpoint !== sub.endpoint);
      db.pushSubs.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, added: this.nowIso() });
    });
  }

  async pushAll(payload) {
    const p = this.cfg.push;
    const subs = [...(this.db.pushSubs || [])];
    if (!p.publicKey || !subs.length) return 0;
    let ok = 0;
    for (const sub of subs) {
      try {
        const r = await webpush.sendPush(sub, payload, { publicKey: p.publicKey, privateKey: p.privateKey, subject: p.subject, fetchImpl: this.fetch });
        if (r.gone) this.store.update((db) => { db.pushSubs = db.pushSubs.filter((s) => s.endpoint !== sub.endpoint); });
        else if (r.ok) ok++;
      } catch (e) { console.log('[warn] Push fehlgeschlagen: ' + e.message); }
    }
    return ok;
  }

  // ---------- Trend-Radar ----------
  async jobRadar() {
    const now = this.now().getTime();
    const { signals, sources, errors } = await trends.collectSignals({ cfg: this.cfg, fetch: this.fetch, claude: this.claude, now });
    this.store.update((db) => { db.radar = { lastRun: this.nowIso(), signals: signals.length, sources, errors }; });
    if (!signals.length) return 'keine Signale' + (errors.length ? ': ' + errors.join('; ') : '');
    const since = now - U.days(21);
    const recentTitles = [
      ...this.db.videos.filter((v) => Date.parse(v.createdAt) > since).map((v) => v.title),
    ].slice(0, 25);
    const fstats = M.formatStats(this.db.videos);
    const proposed = await this.agents.topicsFromSignals({ signals, recentTitles, formatStats: fstats });
    const factor = (f) => (fstats[f] && fstats[f].count >= 3 ? Math.max(0.7, Math.min(1.3, fstats[f].score)) : 1);
    this.store.update((db) => {
      for (const t of db.topics) if (t.status === 'neu') t.status = 'alt';
      const fresh = proposed.map((t) => ({
        id: U.uid('t_'), createdAt: this.nowIso(), status: 'neu', source: 'radar',
        title: t.title, hook: t.hook, angle: t.angle, whyNow: t.whyNow, format: t.format, demand: t.demand,
        competition: t.competition, evergreen: t.evergreen, evidence: t.evidence || [],
        score: Math.round((t.demand || 50) * factor(t.format)),
      })).sort((a, b) => b.score - a.score);
      db.topics.unshift(...fresh);
      db.topics.length = Math.min(db.topics.length, 120);
    });
    const top = this.db.topics.find((t) => t.status === 'neu');
    if (top && !this.cfg.autoProduce.enabled) this.notify(`${proposed.length} neue Themen im Radar. Top: „${top.title}“`, { title: 'Trend-Radar', url: '/#radar' });
    return `${proposed.length} Themen aus ${signals.length} Signalen`;
  }

  addTopic({ title, angle = '', format = 'news60' }) {
    if (!String(title || '').trim()) throw new Error('Titel fehlt.');
    const t = {
      id: U.uid('t_'), createdAt: this.nowIso(), status: 'neu', source: 'manuell', title: String(title).trim(), hook: '', angle,
      whyNow: 'Von dir hinzugefügt', format, demand: null, competition: null, evergreen: false, evidence: [], score: 1000,
    };
    this.store.update((db) => { db.topics.unshift(t); });
    return t;
  }

  discardTopic(id) {
    const t = this.topic(id);
    if (!t) throw new Error('Thema nicht gefunden.');
    this.store.update(() => { t.status = 'verworfen'; });
    return t;
  }

  // ---------- Produktion ----------
  /** Ein Knopf: Markt analysieren, bestes Thema wählen, Video komplett produzieren. */
  oneClick({ auto = false } = {}) {
    if (!this.claude.ready) throw new Error('Claude-Schlüssel fehlt (Mehr → Claude).');
    if (this.db.videos.some((v) => v.status === 'analyse')) throw new Error('Läuft schon – schau in die Karte „Gerade“.');
    this.checkBudget(this.estimate());
    const v = {
      id: U.uid('v_'), topicId: null, title: 'Neues Video', format: null, status: 'analyse', auto, oneClick: true,
      createdAt: this.nowIso(), updatedAt: this.nowIso(), history: [{ at: this.nowIso(), event: auto ? 'Vollautomatik gestartet' : 'Ein-Knopf gestartet' }],
    };
    this.store.update((db) => { db.videos.unshift(v); });
    this.runOneClick(v);
    return v;
  }

  runOneClick(v) {
    const job = (async () => {
      this.setStatus(v, 'analyse', { error: undefined });
      try {
        const lastRadar = this.db.radar.lastRun ? Date.parse(this.db.radar.lastRun) : 0;
        const fresh = () => this.db.topics.filter((t) => t.status === 'neu').sort((a, b) => b.score - a.score);
        if (!fresh().length || this.now() - lastRadar > U.hours(6)) {
          this.hist(v, 'Analysiert den Markt (YouTube, Hacker News, Reddit, News)');
          const res = await this.jobRadar();
          this.store.update((db) => { db.jobs.radar = { ...(db.jobs.radar || {}), lastRun: this.nowIso(), ok: true, result: res }; });
        }
        const top = fresh()[0];
        if (!top) throw new Error('Der Radar hat gerade kein passendes Thema gefunden. In einer Stunde nochmal versuchen.');
        this.store.update(() => {
          Object.assign(v, { topicId: top.id, title: top.title, format: top.format });
          top.status = 'in-produktion';
          top.videoId = v.id;
        });
        this.hist(v, `Thema gewählt (Nachfrage ${top.demand ?? '–'}): ${top.title}`);
        this.setStatus(v, 'wartet');
        this.enqueue(v.id);
      } catch (e) {
        const f = friendly(e);
        this.setStatus(v, 'fehler', { error: f.text, retryable: f.retryable });
        this.hist(v, 'Fehler: ' + e.message);
        this.notify(`Ein-Knopf: ${f.text}`, { videoId: v.id, title: 'Fehler' });
      }
    })();
    this.oneClickJob = job;
    return job;
  }

  produce(topicId, { auto = false } = {}) {
    const t = this.topic(topicId);
    if (!t) throw new Error('Thema nicht gefunden.');
    if (t.status === 'in-produktion') throw new Error('Dieses Thema wird schon produziert.');
    if (!this.claude.ready) throw new Error('Claude-Schlüssel fehlt (Einstellungen).');
    this.checkBudget(this.estimate());
    const v = {
      id: U.uid('v_'), topicId, title: t.title, format: t.format, status: 'wartet', auto,
      createdAt: this.nowIso(), updatedAt: this.nowIso(), history: [{ at: this.nowIso(), event: auto ? 'Automatisch gestartet' : 'Gestartet' }],
    };
    this.store.update((db) => { t.status = 'in-produktion'; t.videoId = v.id; db.videos.unshift(v); });
    this.enqueue(v.id);
    return v;
  }

  enqueue(id) {
    if (!this.queue.includes(id) && this.current !== id) this.queue.push(id);
    if (!this.working) this.working = this.work();
    return this.working;
  }

  async work() {
    await Promise.resolve();
    try {
      while (this.queue.length) {
        const id = this.queue.shift();
        this.current = id;
        await this.runPipeline(id);
      }
    } finally {
      this.current = null;
      this.working = null;
    }
  }

  /** Wartet, bis die Warteschlange leer ist (für Tests). */
  async idle() {
    if (this.oneClickJob) await this.oneClickJob;
    while (this.working) await this.working;
  }

  setStatus(v, status, extra = {}) {
    this.store.update(() => { Object.assign(v, extra); v.status = status; v.updatedAt = this.nowIso(); });
  }

  async runPipeline(id) {
    const v = this.video(id);
    if (!v || !ACTIVE.concat(['fehler', 'gestoppt', 'pruefen']).includes(v.status)) return;
    const cfg = this.cfg;
    const dir = this.vdir(v);
    fs.mkdirSync(dir, { recursive: true });
    const topic = this.topic(v.topicId) || { title: v.title, angle: '', format: v.format || 'news60', evidence: [] };
    const stopCheck = () => { if (this.video(id) && this.video(id).stopRequested) throw new StopError('gestoppt'); };
    this.store.update(() => { delete v.error; });
    try {
      if (!this.claude.ready) throw new Error('Claude-Schlüssel fehlt (Einstellungen).');

      if (!v.research) {
        this.setStatus(v, 'recherche');
        const r = await this.agents.research(topic);
        if (!r.text) throw new Error('Recherche ergab keinen Text.');
        this.store.update(() => { v.research = { text: r.text, sources: r.sources.slice(0, 12) }; });
        this.hist(v, `Recherche fertig (${r.sources.length} Quellen)`);
      }
      stopCheck();

      if (!v.script) {
        this.setStatus(v, 'skript');
        const s = await this.agents.writeScript({ topic, research: v.research, maxScenes: cfg.video.maxScenes });
        this.store.update(() => { v.script = s; v.title = s.title; v.format = s.format; });
        this.hist(v, `Skript fertig (${s.scenes.length} Szenen)`);
      }
      stopCheck();

      if (cfg.quality.factCheck && !v.factCheck) {
        this.setStatus(v, 'faktencheck');
        const fc = await this.agents.factCheck({ script: v.script, research: v.research });
        const issues = (fc.issues || []).map((i) => ({ ...i }));
        this.store.update(() => {
          for (const i of issues) {
            if (i.fixedNarration && i.scene >= 0 && v.script.scenes[i.scene]) { v.script.scenes[i.scene].narration = i.fixedNarration; i.fixed = true; }
          }
          const open = issues.filter((i) => i.severity === 'hoch' && !i.fixed);
          v.factCheck = { pass: Boolean(fc.pass) && open.length === 0, summary: fc.summary, issues, at: this.nowIso() };
        });
        this.hist(v, `Faktencheck: ${v.factCheck.pass ? 'bestanden' : 'Bedenken'}${issues.filter((i) => i.fixed).length ? `, ${issues.filter((i) => i.fixed).length} Stellen korrigiert` : ''}`);
      }
      if (v.factCheck && !v.factCheck.pass && cfg.quality.blockOnFail && !v.factCheck.overridden) {
        this.setStatus(v, 'pruefen');
        this.notify(`Faktencheck hat Bedenken bei „${v.title}“. Bitte kurz ansehen, dann geht es weiter.`, { videoId: v.id, title: 'Kurz prüfen' });
        return;
      }
      stopCheck();

      if (!v.voice) {
        this.checkBudget(this.estimate(v.script.scenes.length));
        this.setStatus(v, 'stimme');
        const text = v.script.scenes.map((s) => s.narration.trim()).join(' ');
        const file = path.join(dir, 'voice.mp3');
        const r = await voice.synthesize({ cfg, text, outFile: file, fetch: this.fetch });
        const durationS = await R.duration(file);
        this.addCost('voice', r.costUsd);
        this.store.update(() => { v.voice = { file: 'voice.mp3', durationS, words: r.words, chars: r.chars }; });
        this.hist(v, `Stimme fertig (${durationS.toFixed(1)} s)`);
      }
      stopCheck();

      const total = v.voice.durationS + 0.6;
      if (!v.scenes) {
        const times = voice.sceneTimes(v.script.scenes.map((s) => s.narration), v.voice.words, total);
        this.store.update(() => {
          v.scenes = v.script.scenes.map((s, i) => ({ i, prompt: s.visual, start: times[i].start, durationS: times[i].durationS, file: null, status: 'offen', costUsd: 0 }));
        });
      }
      this.setStatus(v, 'szenen');
      await this.makeScenes(v, dir, stopCheck);
      stopCheck();

      if (!v.render) {
        this.setStatus(v, 'schnitt');
        const segs = [];
        for (const s of v.scenes) {
          segs.push(await R.normalizeScene({ input: path.join(dir, s.file), seconds: s.durationS, out: path.join(dir, `seg-${s.i}.mp4`) }));
          stopCheck();
        }
        await R.concat(segs, path.join(dir, 'visuals.mp4'));
        fs.writeFileSync(path.join(dir, 'captions.ass'), R.buildAss({ words: v.voice.words, hook: v.script.hook }));
        const final = path.join(dir, 'final.mp4');
        await R.finalMux({ dir, visuals: path.join(dir, 'visuals.mp4'), voice: path.join(dir, 'voice.mp3'), assFile: path.join(dir, 'captions.ass'), out: final, seconds: total });
        await R.coverFrame(final, path.join(dir, 'cover.jpg'), Math.min(1.2, total / 2));
        const bytes = fs.statSync(final).size;
        this.store.update(() => { v.render = { file: 'final.mp4', cover: 'cover.jpg', durationS: total, bytes, token: U.token(18), at: this.nowIso() }; });
        this.hist(v, `Video geschnitten (${total.toFixed(1)} s, ${(bytes / 1e6).toFixed(1)} MB)`);
      }

      this.store.update(() => { if (this.topic(v.topicId)) this.topic(v.topicId).status = 'produziert'; v.costUsd = this.videoCost(v); });
      if (cfg.autoPost) {
        const at = this.nextPostTime();
        this.setStatus(v, 'geplant', { schedule: { at: at.toISOString() } });
        this.notify(`Fertig: „${v.title}“. Geht ${this.fmtAt(at)} online${cfg.dryRun ? ' (Trockenlauf)' : ''}.`, { videoId: v.id, title: 'Video fertig' });
      } else {
        this.setStatus(v, 'fertig');
        const where = this.targets().map((t) => ({ instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube' }[t])).join(', ');
        this.notify(`Fertig: „${v.title}“. Ansehen und mit OK sofort hochladen${where ? ' auf ' + where : ''}.`, {
          videoId: v.id, title: 'Video fertig – bitte OK', actions: [{ action: 'post', title: 'OK – hochladen' }, { action: 'open', title: 'Ansehen' }],
        });
      }
    } catch (e) {
      if (e instanceof StopError || e.message === 'gestoppt') {
        this.setStatus(v, 'gestoppt', { stopRequested: false });
        this.hist(v, 'Gestoppt');
        return;
      }
      const step = v.status;
      const f = friendly(e);
      this.setStatus(v, 'fehler', { error: f.text, retryable: f.retryable });
      this.hist(v, 'Fehler: ' + e.message);
      this.log('error', `Produktion „${v.title}“: ${e.message}`);
      if (!f.retryable || (v.autoRetries || 0) >= 3) {
        this.notify(`Produktion fehlgeschlagen: „${v.title}“ – ${f.text}`, { videoId: v.id, title: 'Fehler' });
        this.reportProblem({ where: `Produktion, Schritt ${step}`, message: e.message, stack: e.stack });
      }
    }
  }

  videoCost(v) { return Math.round(((v.scenes || []).reduce((a, s) => a + (s.costUsd || 0), 0) + 0.18) * 100) / 100; }

  async makeScenes(v, dir, stopCheck) {
    const cfg = this.cfg;
    const premium = cfg.video.mode === 'premium' && cfg.video.falKey;
    const missing = () => v.scenes.filter((s) => !s.file || !fs.existsSync(path.join(dir, s.file)));
    const save = (s, patch) => this.store.update(() => Object.assign(s, patch));
    if (!premium) {
      for (const s of missing()) {
        stopCheck();
        await visuals.fallbackClip({ seconds: s.durationS, outFile: path.join(dir, `scene-${s.i}.mp4`), index: s.i });
        save(s, { file: `scene-${s.i}.mp4`, status: 'grafik' });
      }
      return;
    }
    const todo = missing();
    for (const s of todo) {
      if (s.handle) continue;
      stopCheck();
      save(s, { handle: await visuals.submitClip({ cfg, prompt: s.prompt, fetch: this.fetch }), status: 'in Arbeit' });
    }
    this.hist(v, `${todo.length} KI-Szenen beauftragt`);
    const shouldStop = () => Boolean(this.video(v.id) && this.video(v.id).stopRequested);
    await Promise.all(todo.map(async (s) => {
      const out = path.join(dir, `scene-${s.i}.mp4`);
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          if (attempt > 0) save(s, { handle: await visuals.submitClip({ cfg, prompt: s.prompt, fetch: this.fetch }) });
          await visuals.awaitClip({ cfg, handle: s.handle, outFile: out, fetch: this.fetch, sleepImpl: this.sleep, shouldStop });
          const usd = cfg.video.clipSeconds * cfg.video.pricePerSecond;
          this.addCost('video', usd);
          save(s, { file: `scene-${s.i}.mp4`, status: 'fertig', costUsd: usd, handle: null });
          return;
        } catch (e) {
          if (e.message === 'gestoppt') throw e;
          save(s, { error: e.message });
          this.log('warn', `Szene ${s.i + 1} von „${v.title}“: ${e.message}`);
        }
      }
      await visuals.fallbackClip({ seconds: s.durationS, outFile: out, index: s.i });
      save(s, { file: `scene-${s.i}.mp4`, status: 'ersatz', handle: null });
    }));
  }

  retry(id) {
    const v = this.video(id);
    if (!v) throw new Error('Video nicht gefunden.');
    if (!v.topicId) { this.runOneClick(v); return v; }
    if (v.render && !v.published) {
      this.setStatus(v, 'geplant', { schedule: { at: this.nowIso() }, error: undefined });
      return v;
    }
    this.setStatus(v, 'wartet', { stopRequested: false });
    this.enqueue(id);
    return v;
  }

  stop(id) {
    const v = this.video(id);
    if (!v) throw new Error('Video nicht gefunden.');
    if (v.status === 'wartet') { this.queue = this.queue.filter((x) => x !== id); this.setStatus(v, 'gestoppt'); return v; }
    this.store.update(() => { v.stopRequested = true; });
    return v;
  }

  discardVideo(id) {
    const v = this.video(id);
    if (!v) throw new Error('Video nicht gefunden.');
    if (ACTIVE.includes(v.status) && v.status !== 'wartet') this.store.update(() => { v.stopRequested = true; });
    this.queue = this.queue.filter((x) => x !== id);
    this.store.update(() => { v.status = 'verworfen'; v.discardedAt = this.nowIso(); const t = this.topic(v.topicId); if (t) t.status = 'verworfen'; });
    return v;
  }

  /** Nach Faktencheck-Bedenken: „Trotzdem freigeben“. */
  approve(id) {
    const v = this.video(id);
    if (!v || v.status !== 'pruefen') throw new Error('Dieses Video wartet nicht auf eine Prüfung.');
    this.store.update(() => { v.factCheck.overridden = true; });
    this.hist(v, 'Von dir freigegeben');
    this.setStatus(v, 'wartet');
    this.enqueue(id);
    return v;
  }

  postNow(id) {
    const v = this.video(id);
    if (!v || !v.render) throw new Error('Das Video ist noch nicht fertig.');
    const open = this.targets().filter((t) => !(v.platforms && v.platforms[t] && v.platforms[t].status === 'ok'));
    if (v.published && !v.published.dryRun && !open.length) throw new Error('Schon überall veröffentlicht.');
    if (v.published && v.published.dryRun) this.store.update(() => { delete v.published; });
    this.setStatus(v, 'geplant', { schedule: { at: this.nowIso() } });
    this.publish(id).catch(() => {});
    return v;
  }

  composeCaption(v) {
    const s = v.script || {};
    const hosts = [...new Set((s.sources || []).map((x) => { try { return new URL(x.url).hostname.replace(/^www\./, ''); } catch { return null; } }).filter(Boolean))].slice(0, 3);
    const tags = (s.hashtags || []).slice(0, 8).map((h) => '#' + h).join(' ');
    return [String(s.caption || v.title).trim(), hosts.length ? 'Sources: ' + hosts.join(', ') : '', 'Visuals and voice are AI-generated.', tags]
      .filter(Boolean).join('\n\n').slice(0, 2150);
  }

  /** Nächster freier Sendeplatz in der Zeitzone der Zielgruppe. */
  nextPostTime() {
    const cfg = this.cfg;
    const now = this.now().getTime();
    if (cfg.postTiming === 'sofort') return new Date(now + 60e3);
    const tz = U.validTz(cfg.channel.audienceTz) ? cfg.channel.audienceTz : 'UTC';
    const taken = this.db.videos.filter((v) => v.schedule && ['geplant', 'postet'].includes(v.status)).map((v) => Date.parse(v.schedule.at));
    const today = U.zonedParts(now, tz);
    const slots = [...(cfg.slots || [])].filter((t) => /^\d{1,2}:\d{2}$/.test(t)).sort();
    for (let d = 0; d < 21 && slots.length; d++) {
      const day = new Date(Date.UTC(today.y, today.m - 1, today.d + d));
      for (const t of slots) {
        const [hh, mm] = t.split(':').map(Number);
        const at = U.zonedToDate(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh, mm, tz);
        if (at.getTime() < now + 10 * 60e3) continue;
        if (taken.some((x) => Math.abs(x - at.getTime()) < 30 * 60e3)) continue;
        return at;
      }
    }
    return new Date(now + 3600e3);
  }

  fmtAt(d) {
    const x = new Date(d);
    const local = x.toLocaleString('de-DE', { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: this.env.TZ || 'Europe/Berlin' });
    return `${local} Uhr`;
  }

  /** Verbundene Plattformen in fester Reihenfolge. */
  targets() {
    return [['instagram', this.ig.ready], ['tiktok', this.tt.ready], ['youtube', this.yt.ready]].filter(([, ok]) => ok).map(([k]) => k);
  }

  async publishTo(target, v, file) {
    if (target === 'instagram') {
      const base = this.publicUrl();
      if (!base.startsWith('https://')) throw new Error('Öffentliche HTTPS-Adresse des Servers fehlt (Einstellungen → Server).');
      const r = await this.ig.publishReel({
        videoUrl: `${base}/v/${v.render.token}/${v.render.file}`, caption: this.composeCaption(v), shareToFeed: this.cfg.instagram.shareToFeed, thumbOffsetMs: 1200,
        onStep: (m) => this.hist(v, 'Instagram: ' + m),
      });
      return { mediaId: r.mediaId, url: r.permalink, at: r.timestamp ? new Date(r.timestamp).toISOString() : this.nowIso() };
    }
    if (target === 'youtube') {
      const r = await this.yt.upload({ file, title: v.title, description: this.composeCaption(v) + '\n\n#Shorts', tags: (v.script && v.script.hashtags) || [], privacy: this.cfg.youtube.privacy });
      return { id: r.id, url: r.url, privacy: r.privacy, restricted: r.restricted, at: this.nowIso() };
    }
    if (target === 'tiktok') {
      const r = await this.tt.upload({ file, caption: this.composeCaption(v), mode: this.cfg.tiktok.mode, privacy: this.cfg.tiktok.privacy });
      return { publishId: r.publishId, url: r.url, draft: r.draft, privacy: r.privacy, at: this.nowIso() };
    }
    throw new Error('Unbekannte Plattform: ' + target);
  }

  /** Auf allen verbundenen Plattformen gleichzeitig veröffentlichen. Bereits erfolgreiche werden übersprungen. */
  async publish(id) {
    const v = this.video(id);
    if (!v || this.busy.has('pub:' + id)) return v;
    this.busy.add('pub:' + id);
    const NAME = { instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube' };
    try {
      this.setStatus(v, 'postet');
      if (this.cfg.dryRun) {
        this.setStatus(v, 'online', { published: { at: this.nowIso(), dryRun: true } });
        this.hist(v, 'Trockenlauf: wäre jetzt gepostet worden');
        this.notify(`Trockenlauf: „${v.title}“ wäre jetzt auf ${this.targets().map((t) => NAME[t]).join(', ') || 'deinen Kanälen'} online gegangen.`, { videoId: v.id });
        return v;
      }
      const targets = this.targets();
      if (!targets.length) throw new Error('Kein Kanal verbunden. Mehr → Instagram, TikTok oder YouTube verbinden.');
      const file = v.render && path.join(this.vdir(v), v.render.file);
      if (!file || !fs.existsSync(file)) throw new Error('Videodatei fehlt.');
      const plat = { ...(v.platforms || {}) };
      const todo = targets.filter((t) => !(plat[t] && plat[t].status === 'ok'));
      this.store.update(() => { for (const t of todo) plat[t] = { status: 'läuft', at: this.nowIso() }; v.platforms = plat; });
      this.hist(v, `Lädt hoch: ${todo.map((t) => NAME[t]).join(', ')}`);
      const results = await Promise.allSettled(todo.map((t) => this.publishTo(t, v, file)));
      const failed = [];
      this.store.update(() => {
        results.forEach((r, i) => {
          const t = todo[i];
          if (r.status === 'fulfilled') plat[t] = { status: 'ok', ...r.value };
          else { plat[t] = { status: 'fehler', error: friendly(r.reason).text, raw: r.reason.message, at: this.nowIso() }; failed.push({ t, e: r.reason }); }
        });
        v.platforms = plat;
        if (plat.youtube && plat.youtube.status === 'ok') v.youtube = { ...(v.youtube || {}), ...plat.youtube };
        if (plat.tiktok && plat.tiktok.status === 'ok') v.tiktok = plat.tiktok;
      });
      const okList = Object.keys(plat).filter((k) => plat[k].status === 'ok');
      if (!okList.length) throw new Error(failed.map((x) => `${NAME[x.t]}: ${x.e.message}`).join(' · '));
      const ig = plat.instagram && plat.instagram.status === 'ok' ? plat.instagram : null;
      const firstAt = okList.map((k) => plat[k].at).sort()[0];
      this.setStatus(v, 'online', {
        published: { at: (v.published && v.published.at) || firstAt, mediaId: ig ? ig.mediaId : undefined, permalink: ig ? ig.url : undefined },
        error: failed.length ? `Nicht hochgeladen: ${failed.map((x) => NAME[x.t]).join(', ')}` : undefined,
      });
      for (const t of okList) if (todo.includes(t)) this.hist(v, `${NAME[t]}: ${t === 'tiktok' && plat[t].draft ? 'liegt im TikTok-Postfach' : 'online'}${plat[t].privacy && plat[t].privacy !== 'public' && plat[t].privacy !== 'PUBLIC_TO_EVERYONE' ? ` (${plat[t].privacy})` : ''}`);
      const extras = [];
      if (plat.tiktok && plat.tiktok.draft && todo.includes('tiktok')) extras.push('TikTok: in der TikTok-App auf die Benachrichtigung tippen und posten');
      if (plat.youtube && plat.youtube.restricted && todo.includes('youtube')) extras.push('YouTube vorerst privat (Google-Prüfung)');
      this.notify(`Online auf ${okList.map((k) => NAME[k]).join(', ')}: „${v.title}“${extras.length ? '. ' + extras.join('. ') : ''}`, {
        videoId: v.id, title: 'Veröffentlicht', url: (ig && ig.url) || (plat.youtube && plat.youtube.url) || undefined,
      });
      for (const x of failed) {
        this.hist(v, `${NAME[x.t]} fehlgeschlagen: ${x.e.message}`);
        this.notify(`${NAME[x.t]}: „${v.title}“ konnte dort nicht hochgeladen werden – ${friendly(x.e).text}`, { videoId: v.id, title: 'Teilweise veröffentlicht' });
        this.reportProblem({ where: `Veröffentlichen auf ${NAME[x.t]}`, message: x.e.message, stack: x.e.stack });
      }
      return v;
    } catch (e) {
      const f = friendly(e);
      this.setStatus(v, 'fehler', { error: 'Posten: ' + f.text, retryable: f.retryable, retries: (v.retries || 0) + 1 });
      this.hist(v, 'Posten fehlgeschlagen: ' + e.message);
      if (!f.retryable || (v.autoRetries || 0) >= 3) {
        this.notify(`„${v.title}“ konnte nicht gepostet werden: ${f.text}`, { videoId: v.id, title: 'Fehler beim Posten' });
        this.reportProblem({ where: 'Veröffentlichen', message: e.message, stack: e.stack });
      }
      throw e;
    } finally {
      this.busy.delete('pub:' + id);
    }
  }

  // ---------- Aufgaben für den Zeitplaner ----------
  async jobPublishDue() {
    const now = this.now().getTime();
    const due = this.db.videos.filter((v) => v.status === 'geplant' && v.schedule && Date.parse(v.schedule.at) <= now)
      .sort((a, b) => Date.parse(a.schedule.at) - Date.parse(b.schedule.at));
    if (!due.length) return 'nichts fällig';
    const v = due[0];
    if (now - Date.parse(v.schedule.at) > U.hours(6) && this.cfg.postTiming === 'slot') {
      const at = this.nextPostTime();
      this.setStatus(v, 'geplant', { schedule: { at: at.toISOString() } });
      this.hist(v, 'Termin verpasst (Server war aus) – neu geplant');
      return 'verpassten Termin neu geplant';
    }
    this.publish(v.id).catch(() => {});
    return `Posten gestartet: ${v.title}`;
  }

  /** Vorübergehende Fehler (Netz, Überlastung) bis zu dreimal selbst neu versuchen. */
  async jobRetryFailed() {
    const now = this.now().getTime();
    const list = this.db.videos.filter((v) => v.status === 'fehler' && v.retryable && (v.autoRetries || 0) < 3 && now - Date.parse(v.updatedAt) >= 10 * 60e3);
    for (const v of list) {
      this.store.update(() => { v.autoRetries = (v.autoRetries || 0) + 1; });
      this.hist(v, `Automatischer neuer Versuch (${v.autoRetries}/3)`);
      this.retry(v.id);
    }
    return list.length ? `${list.length} neu gestartet` : 'nichts zu tun';
  }

  async jobAutoProduce() {
    const cfg = this.cfg;
    if (!cfg.autoProduce.enabled) return 'Vollautomatik aus';
    const today = U.isoDate(this.now());
    if (this.db.videos.some((v) => v.auto && U.isoDate(v.createdAt) === today)) return 'heute schon produziert';
    const v = this.oneClick({ auto: true });
    await this.oneClickJob;
    return v.topicId ? `produziere: ${v.title}` : 'kein Thema gefunden';
  }

  async jobInsights() {
    const now = this.now().getTime();
    let calls = 0;
    for (const v of this.db.videos) {
      if (!this.ig.ready) break;
      if (calls >= 15) break;
      const pub = v.published;
      if (!pub || pub.dryRun || !pub.mediaId) continue;
      const age = now - Date.parse(pub.at);
      const ins = v.insights || {};
      let take = null;
      if (!ins.h24 && age >= U.hours(24)) take = 'h24';
      else if (!ins.d7 && age >= U.days(7)) take = 'd7';
      else if (age < U.days(30) && (!ins.latestAt || now - Date.parse(ins.latestAt) >= U.hours(6))) take = 'latest';
      if (!take) continue;
      calls++;
      try {
        const data = await this.ig.insights(pub.mediaId);
        this.store.update(() => {
          v.insights = { ...ins, [take]: data, latest: data, latestAt: this.nowIso() };
          if (take === 'd7') v.status = 'gemessen';
        });
      } catch (e) { this.log('warn', `Insights für „${v.title}“: ${e.message}`); }
    }
    let ytCount = 0;
    if (this.yt.ready) {
      const ytVids = this.db.videos.filter((v) => v.youtube && v.youtube.id && now - Date.parse(v.youtube.at || v.createdAt) < U.days(60));
      if (ytVids.length) {
        try {
          const stats = await this.yt.stats(ytVids.map((v) => v.youtube.id));
          this.store.update(() => { for (const v of ytVids) if (stats[v.youtube.id]) { v.youtube.stats = stats[v.youtube.id]; v.youtube.privacy = stats[v.youtube.id].privacy || v.youtube.privacy; ytCount++; } });
        } catch (e) { this.log('warn', 'YouTube-Zahlen: ' + e.message); }
      }
    }
    if (!this.ig.ready && !ytCount) return this.yt.ready ? 'nichts fällig' : 'nichts verbunden';
    return `${calls} Instagram-, ${ytCount} YouTube-Videos gemessen`;
  }

  async jobComments() {
    if (!this.ig.ready && !this.yt.ready) return 'nichts verbunden';
    const now = this.now().getTime();
    const own = String(this.cfg.instagram.username || '').toLowerCase();
    const ownYt = this.cfg.youtube.channelId;
    const known = new Set(this.db.comments.map((c) => c.id));
    const fresh = [];
    for (const v of this.db.videos) {
      const pub = v.published;
      if (!pub || pub.dryRun || now - Date.parse(pub.at) > U.days(14)) continue;
      if (this.ig.ready && pub.mediaId) {
        try {
          for (const c of await this.ig.comments(pub.mediaId)) {
            if (known.has(c.id) || String(c.username || '').toLowerCase() === own) continue;
            fresh.push({ id: c.id, platform: 'instagram', videoId: v.id, videoTitle: v.title, username: c.username, text: c.text || '', timestamp: c.timestamp });
          }
        } catch (e) { this.log('warn', `Instagram-Kommentare „${v.title}“: ${e.message}`); }
      }
      if (this.yt.ready && v.youtube && v.youtube.id && v.youtube.privacy !== 'private') {
        try {
          for (const c of await this.yt.comments(v.youtube.id)) {
            if (known.has(c.id) || (ownYt && c.authorChannelId === ownYt)) continue;
            fresh.push({ id: c.id, platform: 'youtube', videoId: v.id, videoTitle: v.title, username: c.username, text: c.text, timestamp: c.timestamp });
          }
        } catch (e) { this.log('warn', `YouTube-Kommentare „${v.title}“: ${e.message}`); }
      }
    }
    if (!fresh.length) return 'keine neuen Kommentare';
    const results = [];
    for (let i = 0; i < fresh.length; i += 25) results.push(...(await this.agents.classifyComments(fresh.slice(i, i + 25))));
    const mode = this.cfg.commentMode;
    let auto = 0;
    let drafts = 0;
    for (let i = 0; i < fresh.length; i++) {
      const c = fresh[i];
      const r = results[i] || {};
      const rec = { ...c, category: r.category || 'sonstiges', draft: r.reply || '', status: r.category === 'spam' ? 'ignoriert' : 'entwurf', at: this.nowIso() };
      this.store.update((db) => { db.comments.unshift(rec); db.comments.length = Math.min(db.comments.length, 1000); });
      if (r.videoIdea) this.addTopic({ title: r.videoIdea, angle: `Frage aus den Kommentaren von @${c.username}` });
      const autoOk = rec.status === 'entwurf' && rec.draft && (mode === 'auto-alle' ? rec.category !== 'kritik' && rec.category !== 'fehlerhinweis' : mode === 'auto-lob' && rec.category === 'lob');
      if (autoOk) {
        try { await this.sendReply(rec.id, rec.draft); auto++; } catch (e) { this.log('warn', 'Auto-Antwort: ' + e.message); }
      } else if (rec.status === 'entwurf') drafts++;
    }
    if (drafts) this.notify(`${drafts} Kommentar${drafts === 1 ? '' : 'e'} mit Antwortentwurf`, { title: 'Kommentare', url: '/#kommentare' });
    return `${fresh.length} neu, ${auto} automatisch beantwortet, ${drafts} Entwürfe`;
  }

  async sendReply(commentId, text) {
    const c = this.db.comments.find((x) => x.id === commentId);
    if (!c) throw new Error('Kommentar nicht gefunden.');
    const msg = String(text || '').trim();
    if (!msg) throw new Error('Antwort ist leer.');
    if (!this.cfg.dryRun) {
      if (c.platform === 'youtube') await this.yt.reply(commentId, msg);
      else await this.ig.reply(commentId, msg);
    }
    this.store.update(() => { c.status = 'beantwortet'; c.reply = { text: msg, at: this.nowIso(), dryRun: this.cfg.dryRun }; });
    return c;
  }

  ignoreComment(commentId) {
    const c = this.db.comments.find((x) => x.id === commentId);
    if (!c) throw new Error('Kommentar nicht gefunden.');
    this.store.update(() => { c.status = 'ignoriert'; });
    return c;
  }

  async jobFollowers() {
    if (!this.ig.ready) return 'Instagram nicht verbunden';
    const me = await this.ig.me();
    const date = U.isoDate(this.now());
    this.store.update((db) => {
      db.followers = db.followers.filter((f) => f.date !== date);
      db.followers.push({ date, count: me.followers || 0 });
      db.followers.length = Math.min(db.followers.length, 400);
    });
    return `${me.followers} Follower`;
  }

  async jobTokenRefresh() {
    const ig = this.cfg.instagram;
    if (!ig.token) return 'kein Token';
    if (ig.tokenRefreshed && this.now() - Date.parse(ig.tokenRefreshed) < U.days(7)) return 'noch frisch';
    try {
      const r = await this.ig.refresh();
      const c = structuredClone(this.cfg);
      c.instagram.token = r.access_token;
      c.instagram.tokenRefreshed = this.nowIso();
      c.instagram.tokenExpires = new Date(this.now().getTime() + (r.expires_in || 5184000) * 1000).toISOString();
      this.saveConfig(c);
      return 'Instagram-Zugang verlängert';
    } catch (e) {
      const exp = ig.tokenExpires ? Date.parse(ig.tokenExpires) : 0;
      if (exp && exp - this.now() < U.days(5)) this.notify('Instagram-Zugang läuft bald ab. Bitte in den Einstellungen neu verbinden.', { title: 'Instagram' });
      throw e;
    }
  }

  async jobWeeklyReview() {
    const since = this.now() - U.days(14);
    const vids = this.db.videos.filter((v) => v.published && !v.published.dryRun && Date.parse(v.published.at) >= since)
      .map((v) => ({ v, m: M.videoMetrics(v) })).filter((x) => x.m);
    if (!vids.length) return 'noch keine gemessenen Videos';
    const data = {
      videos: vids.map(({ v, m }) => ({
        title: v.title, format: v.format, hook: v.script && v.script.hook, views: m.views, retention: m.retention && Math.round(m.retention),
        sharesK: m.sharesK && +m.sharesK.toFixed(1), savesK: m.savesK && +m.savesK.toFixed(1), score: m.score && +m.score.toFixed(2),
      })),
    };
    const r = await this.agents.weeklyReview(data);
    const learnings = [...(r.doMore || []).map((x) => 'Do more: ' + x), ...(r.doLess || []).map((x) => 'Do less: ' + x)].join('\n');
    this.store.update((db) => {
      db.reports.unshift({ id: U.uid('r_'), at: this.nowIso(), count: vids.length, ...r });
      db.reports.length = Math.min(db.reports.length, 52);
      db.learnings = learnings;
    });
    this.notify(`Wochen-Review: ${r.summary}`, { title: 'Wochen-Review', url: '/#kanal' });
    return 'Review gespeichert';
  }

  async jobCleanup() {
    const now = this.now().getTime();
    let freed = 0;
    const rm = (f) => { try { freed += fs.statSync(f).size; fs.unlinkSync(f); } catch { /* weg */ } };
    for (const v of this.db.videos) {
      const dir = this.vdir(v);
      if (!fs.existsSync(dir)) continue;
      if (v.status === 'verworfen' && now - Date.parse(v.discardedAt || v.updatedAt) > U.days(2)) {
        for (const f of fs.readdirSync(dir)) rm(path.join(dir, f));
        fs.rmSync(dir, { recursive: true, force: true });
        continue;
      }
      if (v.render && now - Date.parse(v.render.at) > U.days(3)) {
        for (const f of fs.readdirSync(dir)) if (/^(scene|seg)-\d+\.mp4$|^visuals\.mp4$/.test(f)) rm(path.join(dir, f));
      }
      if (v.published && now - Date.parse(v.published.at) > U.days(45) && v.render && !v.render.deleted) {
        rm(path.join(dir, v.render.file));
        this.store.update(() => { v.render.deleted = true; });
      }
    }
    this.store.update((db) => { for (const t of db.topics) if (t.status === 'neu' && now - Date.parse(t.createdAt) > U.days(4)) t.status = 'alt'; });
    return `${(freed / 1e6).toFixed(1)} MB freigegeben`;
  }

  // ---------- Selbstwartung über GitHub ----------
  version() {
    try {
      const [sha, ...rest] = fs.readFileSync(path.join(this.dataDir, 'version.txt'), 'utf8').trim().split(/\s+/);
      return { sha: sha || null, date: rest.join(' ') || null };
    } catch { return { sha: null, date: null }; }
  }

  /** Fehler als GitHub-Ticket melden (gleicher Fehler höchstens alle 12 Std.). */
  async reportProblem({ where, message, stack = '' }) {
    try {
      const key = where + ':' + String(message).replace(/\d+/g, '#').slice(0, 160);
      const last = this.db.reported[key];
      if (last && this.now() - Date.parse(last) < U.hours(12)) return null;
      this.store.update((db) => { db.reported[key] = this.nowIso(); });
      if (!this.gh.canWrite) return null;
      const c = this.cfg;
      const details = [
        `Zeit: ${this.nowIso()}`, `Node: ${process.version}`,
        `Einstellungen: Trockenlauf=${c.dryRun}, Video=${c.video.mode}/${c.video.model}, Stimme=${c.voice.provider}, Claude=${c.anthropic.model}`,
        '', 'Stack:', scrub(stack).split('\n').slice(0, 12).join('\n'),
        '', 'Letzte Protokollzeilen:', ...this.db.log.slice(0, 25).map((l) => `${l.at} [${l.level}] ${scrub(l.msg)}`),
      ].join('\n');
      const r = await this.gh.report({ where, message: scrub(message), details, version: this.version().sha });
      this.log('info', `Fehler an GitHub gemeldet (#${r.number}${r.existing ? ', bekannt' : ''})`);
      return r;
    } catch (e) {
      this.log('warn', 'GitHub-Meldung fehlgeschlagen: ' + e.message);
      return null;
    }
  }

  async jobGithubSync() {
    const [latest, issues] = await Promise.all([
      this.gh.latestCommit().catch((e) => { throw e; }),
      this.gh.openIssues().catch(() => []),
    ]);
    this.store.update((db) => {
      db.maintenance = { checkedAt: this.nowIso(), latest, issues: issues.map(({ body, ...rest }) => rest), error: null };
    });
    const v = this.version().sha;
    return latest ? `${issues.length} offene Tickets · ${v && latest.sha !== v ? 'Update bereit' : 'aktuell'}` : 'kein Commit gefunden';
  }

  /** Update anfordern: der Server-Wächter (Cron, alle 5 Min.) spielt dann die neueste Version ein. */
  requestUpdate() {
    fs.writeFileSync(path.join(this.dataDir, 'update-request'), this.nowIso());
    this.log('info', 'Update angefordert');
    return { ok: true };
  }

  // ---------- TikTok-Anmeldung ----------
  tiktokAuthUrl() {
    const base = this.publicUrl();
    if (!base.startsWith('https://')) throw new Error('Die öffentliche HTTPS-Adresse des Servers fehlt noch.');
    if (!this.tt.configured) throw new Error('Erst Client Key und Client Secret von TikTok eintragen und speichern.');
    const state = U.token(16);
    this.store.update((db) => { db.oauthState = { state, at: this.nowIso(), provider: 'tiktok' }; });
    return this.tt.authUrl(base, state);
  }

  async tiktokCallback({ code, state }) {
    const st = this.db.oauthState;
    if (!st || st.state !== state || st.provider !== 'tiktok' || this.now() - Date.parse(st.at) > U.hours(1)) throw new Error('Anmeldung abgelaufen. Bitte in der App erneut „Mit TikTok verbinden“ tippen.');
    const tok = await this.tt.exchange(code, this.publicUrl());
    let user = { openId: tok.open_id, name: '', username: '' };
    try { user = await this.tt.user(tok.access_token); } catch (e) { this.log('warn', 'TikTok-Profil: ' + e.message); }
    const c = structuredClone(this.cfg);
    Object.assign(c.tiktok, { refreshToken: tok.refresh_token, openId: user.openId || tok.open_id, username: user.username || user.name || '', enabled: true });
    this.saveConfig(c);
    this.store.update((db) => { db.oauthState = null; });
    this.log('info', `TikTok verbunden: ${user.username || user.name || user.openId}`);
    return user;
  }

  // ---------- YouTube-Anmeldung ----------
  youtubeAuthUrl() {
    const base = this.publicUrl();
    if (!base.startsWith('https://')) throw new Error('Die öffentliche HTTPS-Adresse des Servers fehlt noch.');
    if (!this.yt.configured) throw new Error('Erst Client-ID und Client-Geheimnis von Google eintragen und speichern.');
    const state = U.token(16);
    this.store.update((db) => { db.oauthState = { state, at: this.nowIso(), provider: 'youtube' }; });
    return this.yt.authUrl(base, state);
  }

  async youtubeCallback({ code, state }) {
    const st = this.db.oauthState;
    if (!st || st.state !== state || st.provider !== 'youtube' || this.now() - Date.parse(st.at) > U.hours(1)) throw new Error('Anmeldung abgelaufen. Bitte in der App erneut „Mit YouTube verbinden“ tippen.');
    const tok = await this.yt.exchange(code, this.publicUrl());
    const ch = await this.yt.channel(tok.access_token);
    const c = structuredClone(this.cfg);
    Object.assign(c.youtube, { refreshToken: tok.refresh_token, channelId: ch.id, channelTitle: ch.title, enabled: true });
    this.saveConfig(c);
    this.store.update((db) => { db.oauthState = null; });
    this.log('info', `YouTube verbunden: ${ch.title}`);
    return ch;
  }

  // ---------- Verbindungen ----------
  async connectInstagram({ token, appSecret }) {
    let tok = String(token || '').trim();
    if (!tok) throw new Error('Bitte den Zugangsschlüssel (Token) einfügen.');
    let expiresIn = null;
    if (appSecret) {
      try { const ex = await this.ig.exchange(tok, appSecret); tok = ex.access_token; expiresIn = ex.expires_in; } catch (e) { this.log('info', 'Token-Tausch übersprungen: ' + e.message); }
    }
    const me = await this.ig.me(tok);
    const c = structuredClone(this.cfg);
    Object.assign(c.instagram, {
      token: tok, userId: me.userId, username: me.username, tokenRefreshed: this.nowIso(),
      tokenExpires: new Date(this.now().getTime() + (expiresIn || 5184000) * 1000).toISOString(),
    });
    if (appSecret) c.instagram.appSecret = appSecret;
    if (!c.channel.handle) c.channel.handle = '@' + me.username;
    this.saveConfig(c);
    this.log('info', `Instagram verbunden: @${me.username}`);
    return me;
  }

  async testService(name) {
    const cfg = this.cfg;
    if (name === 'claude') { await this.claude.test(); return 'Claude antwortet.'; }
    if (name === 'instagram') {
      const me = await this.ig.me();
      let quota = '';
      try { const l = await this.ig.publishingLimit(); if (l) quota = ` · ${l.quota_usage} von ${(l.config && l.config.quota_total) || 100} Posts in 24 Std. genutzt`; } catch { /* egal */ }
      return `Verbunden mit @${me.username} (${me.followers ?? '?'} Follower)${quota}`;
    }
    if (name === 'voice') {
      if (cfg.voice.provider === 'openai') {
        const r = await this.fetch('https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${cfg.voice.openaiKey}` } });
        if (!r.ok) throw new Error('OpenAI lehnt den Schlüssel ab (' + r.status + ').');
        return 'OpenAI-Schlüssel funktioniert.';
      }
      const voices = await voice.listVoices({ cfg, fetch: this.fetch });
      return `ElevenLabs verbunden, ${voices.length} Stimmen verfügbar.`;
    }
    if (name === 'fal') {
      if (!cfg.video.falKey) throw new Error('Kein fal.ai-Schlüssel hinterlegt.');
      const app = cfg.video.model.split('/').slice(0, 2).join('/');
      const r = await this.fetch(`https://queue.fal.run/${app}/requests/00000000-0000-0000-0000-000000000000/status`, { headers: { authorization: `Key ${cfg.video.falKey}` } });
      if (r.status === 401 || r.status === 403) throw new Error('fal.ai lehnt den Schlüssel ab.');
      return `fal.ai-Schlüssel angenommen. Modell: ${cfg.video.model}, ca. ${(cfg.video.clipSeconds * cfg.video.pricePerSecond).toFixed(2)} $ pro Szene.`;
    }
    if (name === 'youtube') {
      const r = await trends.youtube({ key: cfg.trends.youtubeKey, keywords: ['AI'], fetch: this.fetch, now: this.now().getTime() });
      if (r.skipped) throw new Error('Kein YouTube-Schlüssel hinterlegt.');
      return `YouTube funktioniert (${r.items.length} Videos gefunden).`;
    }
    if (name === 'tiktok') {
      const info = await this.tt.creatorInfo();
      return `TikTok verbunden: ${info.creator_nickname || info.creator_username || 'Konto'} · erlaubte Sichtbarkeit: ${(info.privacy_level_options || []).join(', ') || 'keine Angabe'}`;
    }
    if (name === 'yt') {
      const ch = await this.yt.channel();
      return `YouTube verbunden: ${ch.title} (${ch.subscribers} Abonnenten).`;
    }
    if (name === 'github') {
      const latest = await this.gh.latestCommit();
      if (this.gh.canWrite) await this.gh.openIssues();
      return `GitHub erreichbar · neueste Version ${latest ? latest.sha : '–'}${this.gh.canWrite ? ' · Fehlermeldungen aktiv' : ' · ohne Token keine automatischen Fehlermeldungen'}`;
    }
    if (name === 'push') {
      const n = await this.pushAll({ title: 'Autopilot', body: 'Push funktioniert. So meldet sich die App, wenn ein Video fertig ist.', url: '/' });
      if (!n) throw new Error('Kein Gerät für Push angemeldet. Erst „Push aktivieren“ tippen.');
      return `Testnachricht an ${n} Gerät${n === 1 ? '' : 'e'} geschickt.`;
    }
    throw new Error('Unbekannter Dienst: ' + name);
  }
}

module.exports = { Engine, ACTIVE, StopError };
