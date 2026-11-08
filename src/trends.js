'use strict';
// Trend-Radar: sammelt, was gerade viel gesehen und diskutiert wird.
// Quellen: YouTube (Aufrufe), Hacker News (Punkte), Reddit (Upvotes), Claude-Websuche (News der letzten 48 Std.).
const { extractJson } = require('./util');

const AI_RE = /\b(ai|a\.i\.|llms?|gpt[-\d.o]*|chatgpt|openai|anthropic|claude|gemini|deepmind|llama|mistral|copilot|agents?|agentic|neural|machine learning|robots?|robotics|humanoid|nvidia|sora|veo|midjourney|deepseek|grok|xai|transformer|diffusion|chatbot|superintelligence|agi)\b/i;
const UA = 'ki-autopilot/1.0 (trend radar for a personal channel)';

const nfmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1).replace('.0', '') + ' Mio.' : n >= 1e3 ? Math.round(n / 1e3) + ' Tsd.' : String(n));

async function getJson(fetch, url, headers = {}) {
  const res = await fetch(url, { headers: { 'user-agent': UA, ...headers } });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`${new URL(url).hostname}: keine gültige Antwort (${res.status})`); }
  if (!res.ok) throw new Error(`${new URL(url).hostname}: ${(json.error && (json.error.message || json.error)) || res.status}`);
  return json;
}

async function youtube({ key, keywords, fetch, now }) {
  if (!key) return { items: [], skipped: 'kein YouTube-Schlüssel' };
  const after = new Date(now - 7 * 864e5).toISOString();
  const ids = new Set();
  for (const q of keywords.slice(0, 6)) {
    const u = new URL('https://www.googleapis.com/youtube/v3/search');
    Object.entries({ part: 'snippet', type: 'video', order: 'viewCount', publishedAfter: after, q, maxResults: 12, relevanceLanguage: 'en', key })
      .forEach(([k, v]) => u.searchParams.set(k, String(v)));
    const j = await getJson(fetch, u.toString());
    for (const it of j.items || []) if (it.id && it.id.videoId) ids.add(it.id.videoId);
  }
  const all = [...ids];
  const items = [];
  for (let i = 0; i < all.length; i += 50) {
    const u = new URL('https://www.googleapis.com/youtube/v3/videos');
    Object.entries({ part: 'snippet,statistics', id: all.slice(i, i + 50).join(','), key }).forEach(([k, v]) => u.searchParams.set(k, v));
    const j = await getJson(fetch, u.toString());
    for (const v of j.items || []) {
      const views = Number((v.statistics || {}).viewCount || 0);
      const ageH = Math.max(1, (now - Date.parse(v.snippet.publishedAt)) / 3600e3);
      items.push({
        source: 'youtube', title: v.snippet.title, url: `https://www.youtube.com/watch?v=${v.id}`, metric: views,
        label: `${nfmt(views)} Aufrufe in ${Math.max(1, Math.round(ageH / 24))} Tagen`, velocity: views / ageH, by: v.snippet.channelTitle,
      });
    }
  }
  return { items };
}

async function hackerNews({ fetch, now }) {
  const ts = Math.floor((now - 48 * 3600e3) / 1000);
  const j = await getJson(fetch, `https://hn.algolia.com/api/v1/search?tags=story&numericFilters=created_at_i>${ts},points>40&hitsPerPage=100`);
  const items = (j.hits || []).filter((h) => h.title && AI_RE.test(h.title)).map((h) => {
    const ageH = Math.max(1, (now / 1000 - h.created_at_i) / 3600);
    return {
      source: 'hn', title: h.title, url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`, metric: h.points,
      label: `${h.points} Punkte, ${h.num_comments || 0} Kommentare`, velocity: h.points / ageH,
    };
  });
  return { items };
}

async function reddit({ subs, fetch, now }) {
  const j = await getJson(fetch, `https://www.reddit.com/r/${encodeURIComponent(subs).replace(/%2B/g, '+')}/top.json?t=day&limit=60`);
  const items = ((j.data && j.data.children) || []).map((c) => c.data)
    .filter((d) => d && d.score > 150 && !d.stickied && !d.over_18)
    .map((d) => {
      const ageH = Math.max(1, (now / 1000 - d.created_utc) / 3600);
      return {
        source: 'reddit', title: d.title, url: `https://www.reddit.com${d.permalink}`, metric: d.score,
        label: `${nfmt(d.score)} Upvotes in r/${d.subreddit}`, velocity: d.score / ageH,
      };
    });
  return { items };
}

async function webScan({ claude, now }) {
  const date = new Date(now).toISOString().slice(0, 10);
  const { text, sources } = await claude.research({
    prompt: `Today is ${date}. Use web search to find the 10 most talked-about AI and tech stories, launches or viral AI tools of the last 48 hours that regular people care about. ` +
      'Return ONLY a JSON array, no prose: [{"title":"...","summary":"one sentence","url":"source url","buzz":"why people talk about it, with a number if possible"}]',
    maxTokens: 2500, maxUses: 5,
  });
  const arr = extractJson(text);
  const items = (Array.isArray(arr) ? arr : []).filter((x) => x && x.title).slice(0, 12).map((x, i) => ({
    source: 'web', title: String(x.title), url: x.url || (sources[i] && sources[i].url) || '', metric: null,
    label: x.buzz || x.summary || 'in den News', summary: x.summary || '', velocity: null,
  }));
  return { items };
}

/** Innerhalb jeder Quelle nach Tempo ranken und auf 0–100 abbilden, damit Quellen vergleichbar werden. */
function scoreSignals(items) {
  const bySource = {};
  for (const it of items) (bySource[it.source] = bySource[it.source] || []).push(it);
  for (const list of Object.values(bySource)) {
    const ranked = list.filter((x) => Number.isFinite(x.velocity)).sort((a, b) => b.velocity - a.velocity);
    ranked.forEach((x, i) => { x.heat = Math.round(100 - (i / Math.max(1, ranked.length)) * 70); });
    list.filter((x) => !Number.isFinite(x.velocity)).forEach((x, i) => { x.heat = Math.max(40, 80 - i * 4); });
  }
  const seen = new Set();
  return items.filter((x) => {
    const key = x.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => b.heat - a.heat);
}

/** Alle Quellen abfragen. Fehler einer Quelle stoppen die anderen nicht. */
async function collectSignals({ cfg, fetch, claude, now }) {
  const t = cfg.trends;
  const keywords = String(t.keywords || '').split(',').map((s) => s.trim()).filter(Boolean);
  const tasks = {
    youtube: () => youtube({ key: t.youtubeKey, keywords, fetch, now }),
    hn: () => (t.hn ? hackerNews({ fetch, now }) : { items: [], skipped: 'aus' }),
    reddit: () => (t.reddit ? reddit({ subs: t.subreddits, fetch, now }) : { items: [], skipped: 'aus' }),
    web: () => (t.webSearch && claude.ready ? webScan({ claude, now }) : { items: [], skipped: claude.ready ? 'aus' : 'kein Claude-Schlüssel' }),
  };
  const sources = {};
  const errors = [];
  let items = [];
  await Promise.all(Object.entries(tasks).map(async ([name, fn]) => {
    try {
      const r = await fn();
      sources[name] = r.skipped ? { count: 0, skipped: r.skipped } : { count: r.items.length };
      items = items.concat(r.items);
    } catch (e) {
      const msg = /fetch failed|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN/i.test(e.message + (e.cause ? e.cause.code : '')) ? 'nicht erreichbar' : e.message;
      sources[name] = { count: 0, error: msg };
      errors.push(`${{ youtube: 'YouTube', hn: 'Hacker News', reddit: 'Reddit', web: 'Websuche' }[name]}: ${msg}`);
    }
  }));
  return { signals: scoreSignals(items), sources, errors };
}

module.exports = { collectSignals, scoreSignals, AI_RE, youtube, hackerNews, reddit, webScan };
