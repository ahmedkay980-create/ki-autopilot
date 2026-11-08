'use strict';
// Zeitplaner: prüft alle 30 Sekunden, welche Aufgabe fällig ist. Uhrzeiten in Serverzeit (Europe/Berlin).

const LABELS = {
  publishDue: 'Posten zum Termin', radar: 'Trend-Radar', autoProduce: 'Vollautomatik', insights: 'Zahlen einsammeln',
  comments: 'Kommentare', retryFailed: 'Neue Versuche nach Fehlern', followers: 'Follower zählen', tokenRefresh: 'Instagram-Zugang verlängern', weeklyReview: 'Wochen-Review', cleanup: 'Aufräumen', githubSync: 'Updates und Tickets prüfen',
};

function atToday(now, time) {
  const [h, m] = String(time || '00:00').split(':').map(Number);
  const d = new Date(now);
  d.setHours(h || 0, m || 0, 0, 0);
  return d;
}

class Scheduler {
  constructor(engine) {
    this.engine = engine;
    this.timer = null;
    this.running = new Set();
  }

  jobs() {
    const c = this.engine.cfg;
    return [
      { name: 'publishDue', every: 60e3 },
      { name: 'retryFailed', every: 5 * 60e3 },
      { name: 'comments', every: 15 * 60e3 },
      { name: 'insights', every: 30 * 60e3 },
      { name: 'radar', daily: c.trends.at },
      { name: 'autoProduce', daily: c.autoProduce.at, enabled: c.autoProduce.enabled },
      { name: 'followers', daily: '07:30' },
      { name: 'tokenRefresh', daily: '04:10' },
      { name: 'cleanup', daily: '03:20' },
      { name: 'weeklyReview', weekly: { dow: 0, time: '10:00' } },
      { name: 'githubSync', every: 60 * 60e3 },
    ].map((j) => ({ ...j, label: LABELS[j.name] }));
  }

  /** Letzter planmäßiger Zeitpunkt ≤ now (für tägliche und wöchentliche Aufgaben). */
  lastScheduled(job, now) {
    if (job.daily) {
      const t = atToday(now, job.daily);
      if (t > now) t.setDate(t.getDate() - 1);
      return t;
    }
    if (job.weekly) {
      const t = atToday(now, job.weekly.time);
      const back = (t.getDay() - job.weekly.dow + 7) % 7;
      t.setDate(t.getDate() - back);
      if (t > now) t.setDate(t.getDate() - 7);
      return t;
    }
    return null;
  }

  isDue(job, now, state) {
    if (job.enabled === false) return false;
    const last = state && state.lastRun ? new Date(state.lastRun) : null;
    if (job.every) return !last || now - last >= job.every;
    const sched = this.lastScheduled(job, now);
    const window = job.weekly ? 3 * 864e5 : 864e5 / 2;
    if (now - sched > window) return false;
    return !last || last < sched;
  }

  nextRun(job, now, state) {
    if (job.every) return new Date((state && state.lastRun ? Date.parse(state.lastRun) : now.getTime()) + job.every);
    const sched = this.lastScheduled(job, now);
    if (this.isDue(job, now, state)) return now;
    const n = new Date(sched);
    n.setDate(n.getDate() + (job.weekly ? 7 : 1));
    return n;
  }

  start() {
    this.timer = setInterval(() => this.tick().catch((e) => this.engine.log('error', 'Zeitplaner: ' + e.message)), 30e3);
    setTimeout(() => this.tick().catch(() => {}), 3000);
  }

  stop() { clearInterval(this.timer); }

  async tick() {
    if (!this.engine.cfg.autopilot) return;
    const now = this.engine.now();
    for (const job of this.jobs()) {
      if (this.running.has(job.name)) continue;
      if (!this.isDue(job, now, this.engine.db.jobs[job.name])) continue;
      await this.run(job.name).catch(() => {});
    }
  }

  async run(name) {
    const fn = this.engine['job' + name[0].toUpperCase() + name.slice(1)];
    if (typeof fn !== 'function') throw new Error('Unbekannte Aufgabe: ' + name);
    if (this.running.has(name)) throw new Error('Läuft gerade schon.');
    this.running.add(name);
    const record = (patch) => this.engine.store.update((db) => { db.jobs[name] = { ...(db.jobs[name] || {}), ...patch }; });
    try {
      const result = await fn.call(this.engine);
      record({ lastRun: this.engine.nowIso(), ok: true, result: String(result || 'erledigt'), fails: 0 });
      return result;
    } catch (e) {
      const fails = ((this.engine.db.jobs[name] || {}).fails || 0) + 1;
      record({ lastRun: this.engine.nowIso(), ok: false, result: e.message, fails });
      this.engine.log('error', `${LABELS[name] || name}: ${e.message}`);
      if (fails >= 2 && name !== 'githubSync' && !/nicht erreichbar|fetch failed|ENOTFOUND|ECONN/i.test(e.message)) this.engine.reportProblem({ where: `Aufgabe „${LABELS[name] || name}“`, message: e.message, stack: e.stack });
      throw e;
    } finally {
      this.running.delete(name);
    }
  }

  overview() {
    const now = this.engine.now();
    return this.jobs().map((j) => {
      const st = this.engine.db.jobs[j.name] || {};
      return { name: j.name, label: j.label, enabled: j.enabled !== false, lastRun: st.lastRun || null, ok: st.ok, result: st.result || '', running: this.running.has(j.name), next: j.enabled === false ? null : this.nextRun(j, now, st).toISOString() };
    });
  }
}

module.exports = { Scheduler, LABELS };
