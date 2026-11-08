'use strict';
// Kennzahlen je Video und Auswertung nach Format.

const SOLL = { retention: 50, sharesK: 8, savesK: 8, er: 4 };

function videoMetrics(v) {
  const ins = v.insights || {};
  const i = ins.d7 || ins.latest || ins.h24;
  if (!i) return null;
  const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  const views = num(i.views);
  const reach = num(i.reach);
  const base = reach || views;
  const watchS = num(i.ig_reels_avg_watch_time) != null ? i.ig_reels_avg_watch_time / 1000 : null;
  const len = v.render && v.render.durationS;
  const per1k = (x) => (base && num(x) != null ? (x / base) * 1000 : null);
  const m = {
    views, reach, likes: num(i.likes), comments: num(i.comments), shares: num(i.shares), saves: num(i.saved), watchS,
    retention: watchS != null && len ? Math.min(100, (watchS / len) * 100) : null,
    sharesK: per1k(i.shares), savesK: per1k(i.saved),
    er: base ? (((i.likes || 0) + (i.comments || 0) + (i.shares || 0) + (i.saved || 0)) / base) * 100 : null,
  };
  const parts = [];
  if (m.retention != null) parts.push(m.retention / SOLL.retention);
  if (m.sharesK != null) parts.push(m.sharesK / SOLL.sharesK);
  if (m.savesK != null) parts.push((m.savesK / SOLL.savesK) * 0.5 + 0.5);
  m.score = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
  return m;
}

function formatStats(videos) {
  const out = {};
  for (const v of videos) {
    const m = videoMetrics(v);
    if (!m || m.score == null) continue;
    const f = (v.script && v.script.format) || v.format || 'news60';
    const o = (out[f] = out[f] || { count: 0, sum: 0 });
    o.count++;
    o.sum += m.score;
  }
  for (const o of Object.values(out)) o.score = o.sum / o.count;
  return out;
}

function totals(videos, now, days = 7) {
  const since = now - days * 864e5;
  const recent = videos.filter((v) => v.published && !v.published.dryRun && Date.parse(v.published.at) >= since);
  let views = 0;
  const ret = [];
  for (const v of recent) {
    const m = videoMetrics(v);
    if (!m) continue;
    views += m.views || m.reach || 0;
    if (m.retention != null) ret.push(m.retention);
  }
  return { posts: recent.length, views, retention: ret.length ? ret.reduce((a, b) => a + b, 0) / ret.length : null };
}

module.exports = { SOLL, videoMetrics, formatStats, totals };
