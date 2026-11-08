'use strict';
// KI-Autopilot – Oberfläche der Android-App. Alle Arbeit passiert in Kotlin; hier wird nur angezeigt und angetippt.

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (n) => (Number(n) || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' $';
const LABEL = { instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube' };
const PLATS = ['instagram', 'tiktok', 'youtube'];

// ---------- Brücke zu Kotlin ----------
const pending = {};
let seq = 0;
window.__bridge = (id, json) => {
  const p = pending[id];
  if (!p) return;
  delete pending[id];
  const r = JSON.parse(json);
  if (r.ok) p.res(r.data); else p.rej(new Error(r.error || 'Fehler'));
};
function api(method, path, body) {
  return new Promise((res, rej) => {
    if (!window.Android) return rej(new Error('Nur in der App verfügbar'));
    const id = ++seq;
    pending[id] = { res, rej };
    window.Android.call(id, method, path, body ? JSON.stringify(body) : '');
  });
}
const openUrl = (url) => (window.Android ? window.Android.open(url) : window.open(url, '_blank'));

// ---------- Zustand ----------
let S = null;
let tab = 'start';
let timer = null;
let lastSig = '';
const openKeys = new Set(['keys']);

function busy() {
  if (!S) return false;
  return Boolean(S.busy.producing || S.busy.radar || S.busy.publishing.length ||
    S.videos.some((v) => ['läuft', 'posten', 'pausiert'].includes(v.status)));
}

async function refresh(force) {
  try {
    S = await api('GET', '/state');
    render(force === true);
    notice();
  } catch (e) {
    if (!S) renderError(e.message);
  }
  clearTimeout(timer);
  timer = setTimeout(refresh, busy() ? 2000 : 12000);
}
window.__refresh = () => refresh(true);
window.__resume = () => refresh();
window.__toast = (t) => toast(t);
window.__back = () => {
  if (!$('#dialog').hidden) { closeDialog(); return true; }
  if (tab !== 'start') { go('start'); return true; }
  return false;
};

function notice() {
  const n = S.notice;
  if (n && n.text) {
    toast(n.text, !n.ok);
    api('POST', '/notice/seen').catch(() => {});
    S.notice = {};
  }
}

// ---------- Rahmen ----------
const ICONS = {
  start: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 5v14l11-7z"/></svg>',
  studio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9h18M8 4v5M16 4v5"/></svg>',
  mehr: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
};

function renderTabs() {
  const waiting = S ? S.videos.filter((v) => ['fertig', 'pruefen'].includes(v.status)).length : 0;
  const missing = S ? S.missing.length : 0;
  $('#tabs').innerHTML = [['start', 'Start'], ['studio', 'Videos'], ['mehr', 'Mehr']].map(([k, l]) =>
    `<a href="#" data-tab="${k}" ${tab === k ? 'aria-current="page"' : ''}>${ICONS[k]}<span>${l}</span>` +
    (k === 'studio' && waiting ? `<i class="badge">${waiting}</i>` : '') +
    (k === 'mehr' && missing ? `<i class="badge">!</i>` : '') + '</a>').join('');
}

function go(t) {
  tab = t;
  lastSig = '';
  render(true);
  window.scrollTo(0, 0);
}

function sigFor() {
  if (tab === 'mehr') return 'mehr';
  return JSON.stringify([tab, S.videos.map((v) => [v.id, v.status, v.stepText, v.step, (v.history || []).length, v.platforms]), S.topics.map((t) => t.id), S.radar.at, S.busy, S.missing, S.update.available, S.batteryOk]);
}

function render(force) {
  if (!S) return;
  renderTabs();
  const sig = sigFor();
  if (!force && sig === lastSig) {
    if (tab === 'mehr') updateMehrLive();
    return;
  }
  lastSig = sig;
  const app = $('#app');
  app.innerHTML = tab === 'start' ? viewStart() : tab === 'studio' ? viewStudio() : viewMehr();
  $$('details[data-key]', app).forEach((d) => {
    if (openKeys.has(d.dataset.key)) d.open = true;
    d.addEventListener('toggle', () => (d.open ? openKeys.add(d.dataset.key) : openKeys.delete(d.dataset.key)));
  });
}

function renderError(msg) {
  $('#app').innerHTML = `<div class="card bad"><b>Die App konnte ihre Daten nicht laden.</b><p class="muted">${esc(msg)}</p></div>`;
}

// ---------- Bausteine ----------
const ago = (iso) => {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'gerade eben';
  if (s < 3600) return `vor ${Math.round(s / 60)} Min.`;
  if (s < 86400) return `vor ${Math.round(s / 3600)} Std.`;
  return `vor ${Math.round(s / 86400)} Tagen`;
};
const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '');
const minsSince = (iso) => Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));

function steps(v) {
  const n = S.steps.length;
  const cur = v.step ?? 0;
  const done = v.status === 'fertig' || v.status === 'online' || v.status === 'posten';
  return `<div class="steps" style="grid-template-columns:repeat(${n},minmax(0,1fr))">` +
    S.steps.map((_, i) => `<span class="${done || i < cur ? 'done' : i === cur && v.status === 'läuft' ? 'now' : ''}"></span>`).join('') + '</div>' +
    `<div class="row between small muted"><span>${esc(S.steps[Math.min(cur, n - 1)] || '')}</span><span class="num">Schritt ${Math.min(cur + 1, n)} von ${n}</span></div>`;
}

function platChips(v) {
  const p = v.platforms || {};
  const targets = PLATS.filter((k) => S.platforms[k] || p[k]);
  if (!targets.length) return '<span class="chip warn">Noch keine Plattform verbunden</span>';
  return targets.map((k) => {
    const st = p[k] || {};
    if (st.status === 'ok') {
      return st.url ? `<a class="chip ok" href="#" data-open="${esc(st.url)}">✓ ${LABEL[k]}</a>` : `<span class="chip ok">✓ ${LABEL[k]}</span>`;
    }
    if (st.status === 'läuft') return `<span class="chip accent"><i class="spin" style="width:11px;height:11px"></i> ${LABEL[k]}</span>`;
    if (st.status === 'fehler') return `<span class="chip bad">✕ ${LABEL[k]}</span>`;
    return `<span class="chip">${LABEL[k]}</span>`;
  }).join('');
}

function platNotes(v) {
  const p = v.platforms || {};
  return PLATS.filter((k) => p[k] && (p[k].error || p[k].note)).map((k) =>
    `<div class="note ${p[k].error ? 'bad' : ''} small"><b>${LABEL[k]}:</b> ${esc(p[k].error || p[k].note)}</div>`).join('');
}

function player(v) {
  if (!v.finalUrl) return '';
  return `<div class="vid-wrap"><video src="${esc(v.finalUrl)}" ${v.thumbUrl ? `poster="${esc(v.thumbUrl)}"` : ''} controls playsinline preload="metadata"></video></div>`;
}

function scriptDetails(v) {
  const s = v.script;
  if (!s) return '';
  const fc = v.factCheck;
  const src = (s.sources || []).slice(0, 8);
  return `<details class="more" data-key="sc-${v.id}"><summary>Skript, Quellen, Faktencheck</summary>
    <div class="stack" style="margin-top:10px">
      <div>${(s.scenes || []).map((sc, i) => `<div class="scene"><b>${i + 1}</b><span>${esc(sc.narration)}<br><span class="faint small">🎬 ${esc(sc.visual)}</span></span></div>`).join('')}</div>
      ${s.caption ? `<blockquote>${esc(s.caption)}<br><span class="faint">${(s.hashtags || []).map((h) => '#' + esc(h)).join(' ')}</span></blockquote>` : ''}
      ${fc ? `<div class="note ${fc.pass ? 'ok' : 'warn'} small"><b>Faktencheck:</b> ${esc(fc.summary || '')}${fc.fixes ? ` (${fc.fixes} automatisch korrigiert)` : ''}</div>` : ''}
      ${src.length ? `<div class="evidence">${src.map((x) => `<a class="chip" href="#" data-open="${esc(x.url)}">${esc(x.title || x.url)}</a>`).join('')}</div>` : ''}
      ${v.costUsd ? `<div class="small muted">Kosten dieses Videos: <b class="num">${usd(v.costUsd)}</b></div>` : ''}
      <div class="hist">${(v.history || []).slice().reverse().slice(0, 14).map((h) => `<div><time>${clock(h.at)}</time><span>${esc(h.text)}</span></div>`).join('')}</div>
    </div></details>`;
}

function videoCard(v) {
  const p = v.platforms || {};
  const connected = PLATS.filter((k) => S.platforms[k]);
  const failed = connected.filter((k) => p[k] && p[k].status === 'fehler');
  const open = connected.filter((k) => !p[k] || p[k].status !== 'ok');
  let body = '';
  let actions = '';
  switch (v.status) {
    case 'fertig':
      body = player(v) + (v.warning ? `<div class="note warn small">${esc(v.warning)}</div>` : '') + (v.error ? `<div class="note bad small">${esc(v.error)}</div>` : '');
      actions = connected.length
        ? `<button class="btn primary big block" data-act="publish" data-id="${v.id}">OK – ${failed.length ? 'erneut ' : ''}auf ${open.map((k) => LABEL[k]).join(', ')} hochladen</button>`
        : `<button class="btn primary block" data-go="mehr" data-open-key="plat">Plattformen verbinden</button>`;
      actions += `<button class="btn ghost danger small" data-act="discard" data-id="${v.id}">Verwerfen</button>`;
      break;
    case 'posten':
      body = player(v) + `<div class="live-text"><i class="spin"></i> Wird hochgeladen …</div>`;
      break;
    case 'online':
      body = player(v);
      if (open.length) actions = `<button class="btn small" data-act="publish" data-id="${v.id}">Auch auf ${open.map((k) => LABEL[k]).join(', ')} hochladen</button>`;
      break;
    case 'pruefen': {
      const fc = v.factCheck || {};
      body = `<div class="note warn"><b>Der Faktencheck hat Bedenken.</b> ${esc(fc.summary || '')}<br><span class="small">Es wurde noch kein Geld für Stimme oder Video ausgegeben.</span></div>` +
        (fc.issues || []).filter((i) => i.severity !== 'niedrig').map((i) => `<div class="issue"><span class="chip ${i.severity === 'hoch' ? 'bad' : 'warn'}" style="justify-self:start">${esc(i.severity)}</span><span>„${esc(i.claim)}“</span><span class="muted small">${esc(i.problem)}</span></div>`).join('');
      actions = `<button class="btn primary" data-act="approve" data-id="${v.id}">Trotzdem weitermachen</button><button class="btn ghost danger" data-act="discard" data-id="${v.id}">Verwerfen</button>`;
      break;
    }
    case 'fehler':
    case 'gestoppt':
      body = `<div class="note ${v.status === 'fehler' ? 'bad' : ''}">${esc(v.error || v.stepText || 'Angehalten')}</div>`;
      actions = `<button class="btn primary" data-act="retry" data-id="${v.id}">Weiter</button><button class="btn ghost danger" data-act="discard" data-id="${v.id}">Verwerfen</button>`;
      break;
    case 'pausiert':
      body = `<div class="note">${esc(v.stepText)}</div>`;
      actions = `<button class="btn primary" data-act="retry" data-id="${v.id}">Jetzt weitermachen</button>`;
      break;
    default:
      body = steps(v) + `<div class="live-text"><i class="spin"></i><span>${esc(v.stepText || '')}</span></div>`;
  }
  const chip = { fertig: ['accent', 'Wartet auf dein OK'], posten: ['accent', 'Lädt hoch'], online: ['ok', 'Online'], pruefen: ['warn', 'Bitte prüfen'], fehler: ['bad', 'Angehalten'], gestoppt: ['', 'Gestoppt'], pausiert: ['', 'Pausiert'], läuft: ['accent', 'Entsteht'] }[v.status] || ['', v.status];
  return `<article class="card ${v.status === 'fertig' ? 'hot' : v.status === 'pruefen' ? 'warn' : v.status === 'fehler' ? 'bad' : ''}">
    <div class="row between"><span class="chip ${chip[0]}">${chip[1]}</span><span class="small faint">${ago(v.createdAt)}</span></div>
    <h2 class="h2">${esc(v.title)}</h2>
    ${body}
    ${['fertig', 'posten', 'online'].includes(v.status) ? `<div class="plat">${platChips(v)}</div>${platNotes(v)}` : ''}
    ${actions ? `<div class="row">${actions}</div>` : ''}
    ${scriptDetails(v)}
  </article>`;
}

function liveCard(v) {
  const recent = (v.history || []).slice(-4).reverse();
  return `<article class="card hot">
    <div class="row between"><span class="eyebrow">Entsteht gerade</span><span class="small faint num">seit ${minsSince(v.createdAt)} Min.</span></div>
    <h2 class="h2">${esc(v.title)}</h2>
    ${steps(v)}
    <div class="live-text"><i class="spin"></i><span>${esc(v.stepText || '')}</span></div>
    ${recent.length ? `<div class="hist">${recent.map((h) => `<div><time>${clock(h.at)}</time><span>${esc(h.text)}</span></div>`).join('')}</div>` : ''}
    <p class="small faint">Du kannst die App schließen – ich melde mich, sobald das Video fertig ist.</p>
    <div class="row"><button class="btn ghost small danger" data-act="stop">Stoppen</button></div>
  </article>`;
}

function topicCard(t, i) {
  const ev = (t.evidence || []).slice(0, 3);
  const src = { youtube: 'src-yt', hn: 'src-hn', reddit: 'src-reddit', web: 'src-web' };
  return `<article class="card topic ${i === 0 ? 'first' : ''}">
    <div class="top"><span class="rank">${i + 1}</span><div class="meter"><div class="bar"><i style="width:${Math.max(4, Math.min(100, t.demand || 0))}%"></i></div><span>Nachfrage ${t.demand || 0}/100 · Konkurrenz ${esc(t.competition || '–')}</span></div></div>
    <h3>${esc(t.title)}</h3>
    ${t.hook ? `<p class="hook">„${esc(t.hook)}“</p>` : ''}
    ${t.whyNow ? `<p class="why">${esc(t.whyNow)}</p>` : ''}
    ${ev.length ? `<div class="evidence">${ev.map((e) => `<a class="chip" href="#" data-open="${esc(e.url)}"><b class="${src[e.source] || ''}">●</b> ${esc(e.label || e.title)}</a>`).join('')}</div>` : ''}
    <button class="btn block" data-act="produce" data-id="${t.id}">Daraus ein Video machen</button>
  </article>`;
}

// ---------- Start ----------
function viewStart() {
  const c = S.config;
  const active = S.videos.find((v) => ['läuft', 'pausiert'].includes(v.status));
  const waiting = S.videos.filter((v) => ['fertig', 'posten', 'pruefen', 'fehler', 'gestoppt'].includes(v.status)).slice(0, 3);
  const online = S.videos.filter((v) => v.status === 'online').slice(0, 4);
  const conn = PLATS.map((k) => `<span class="chip ${S.platforms[k] ? 'ok' : ''}">${S.platforms[k] ? '✓' : '○'} ${LABEL[k]}</span>`).join('');
  const radarAt = S.radar && S.radar.at;
  let html = `<header class="head"><span class="eyebrow">KI-Autopilot</span><h1 class="h1">${esc(c.channel.name)}</h1><div class="strip">${conn}</div></header>`;

  if (S.missing.length) {
    html += `<div class="card warn"><b>Fast startklar</b><p class="muted small">Es fehlen noch: ${S.missing.map(esc).join(', ')}. Einmal eintragen, danach reicht ein Knopf.</p><button class="btn primary" data-go="mehr" data-open-key="keys">Jetzt eintragen</button></div>`;
  }
  if (!S.batteryOk && !S.missing.length) {
    html += `<div class="card"><b>Damit ich auch bei geschlossener App arbeite</b><p class="muted small">Android bremst Apps im Hintergrund. Einmal erlauben, dann laufen Marktanalyse und tägliche Videos zuverlässig.</p><button class="btn" data-act="battery">Im Hintergrund erlauben</button></div>`;
  }
  if (S.update && S.update.available) {
    html += `<div class="card hot"><b>Update ${esc(S.update.latest)} ist da</b><p class="muted small">Antippen, herunterladen, installieren – deine Einstellungen bleiben.</p><button class="btn primary" data-open="${esc(S.update.url)}">Update laden</button></div>`;
  }
  if (active) {
    html += liveCard(active);
  } else {
    html += `<section class="card hero">
      <h2 class="h2">Ein Knopf. Ein fertiges Video.</h2>
      <p class="lede">Ich analysiere den Markt, nehme das stärkste KI-Thema, recherchiere, schreibe, prüfe die Fakten, vertone, erzeuge KI-Szenen, schneide und untertitle. Du tippst danach nur noch OK.</p>
      <button class="btn primary big block" data-act="oneclick" ${S.missing.length ? 'disabled' : ''}>Neues Video erstellen</button>
      <p class="small faint">ca. ${usd(S.estimate)} pro Video · 8–15 Minuten · läuft auch bei geschlossener App</p>
    </section>`;
  }
  html += waiting.map(videoCard).join('');
  if (online.length) {
    html += `<section class="sec"><div class="sec-title"><h2 class="h2">Zuletzt online</h2></div><div class="card flat"><div class="list">` +
      online.map((v) => `<div class="li">${v.thumbUrl ? `<img class="thumb" src="${esc(v.thumbUrl)}" alt="">` : ''}<div class="body"><b>${esc(v.title)}</b><span class="meta">${ago(v.publishedAt || v.createdAt)}</span><div class="plat">${platChips(v)}</div></div></div>`).join('') +
      '</div></div></section>';
  }
  html += `<section class="sec"><div class="sec-title"><h2 class="h2">Was gerade läuft</h2>
    <button class="btn ghost small" data-act="radar" ${S.busy.radar ? 'disabled' : ''}>${S.busy.radar ? '<i class="spin"></i> Analysiere …' : 'Neu analysieren'}</button></div>
    <p class="small faint">${radarAt ? `Marktanalyse ${ago(radarAt)} · ${S.radar.signals || 0} Signale aus YouTube, Hacker News, Reddit und News` : 'Noch keine Marktanalyse – passiert automatisch beim ersten Video.'}</p>
    ${S.radar && S.radar.error ? `<div class="note bad small">${esc(S.radar.error)}</div>` : ''}
    ${(S.radar && S.radar.errors || []).length ? `<div class="note small">Nicht erreichbar: ${S.radar.errors.map(esc).join(' · ')}</div>` : ''}
    ${S.topics.slice(0, 5).map(topicCard).join('')}
  </section>`;
  return html;
}

// ---------- Videos ----------
function viewStudio() {
  if (!S.videos.length) {
    return `<header class="head"><span class="eyebrow">Videos</span><h1 class="h1">Noch keine Videos</h1></header>
      <div class="card empty"><strong>Hier landet alles, was entsteht.</strong><p>Tippe auf „Neues Video erstellen“ – fertige Videos warten hier auf dein OK.</p><button class="btn primary" data-go="start">Zum Start</button></div>`;
  }
  return `<header class="head"><span class="eyebrow">Videos</span><h1 class="h1">${S.videos.length} Videos</h1></header>` +
    S.videos.map((v) => (['läuft'].includes(v.status) ? liveCard(v) : videoCard(v))).join('');
}

// ---------- Mehr ----------
function field(name, label, value, { type = 'text', hint = '', placeholder = '', secretSet = '' } = {}) {
  const ph = secretSet ? `✓ gespeichert ${secretSet}` : placeholder;
  return `<label class="f">${esc(label)}${hint ? ` <span class="hint">${hint}</span>` : ''}
    <input type="${type}" name="${name}" value="${esc(value)}" placeholder="${esc(ph)}" autocomplete="off" autocapitalize="off" spellcheck="false" ${type === 'password' ? 'data-secret="1"' : ''}></label>`;
}
function toggle(name, label, checked, small = '') {
  return `<label class="toggle"><span>${esc(label)}${small ? `<small>${esc(small)}</small>` : ''}</span><input type="checkbox" name="${name}" ${checked ? 'checked' : ''}></label>`;
}
function select(name, label, value, opts) {
  return `<label class="f">${esc(label)}<select name="${name}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
}
const secret = (c, sec, key, label, hint = '') => field(`${sec}.${key}`, label, '', { type: 'password', hint, secretSet: c[sec][key + 'Set'] });

function viewMehr() {
  const c = S.config;
  const m = S.costs.month || {};
  const budget = S.costs.budget || 0;
  const pct = budget ? Math.min(100, ((m.total || 0) / budget) * 100) : 0;
  const ig = c.instagram;
  const yt = c.youtube;
  const tt = c.tiktok;
  return `<header class="head"><span class="eyebrow">Mehr</span><h1 class="h1">Einstellungen</h1><p class="lede">Einmal einrichten, danach läuft alles von selbst.</p></header>

  <details class="set" data-key="keys"><summary><span>Schlüssel</span>${S.missing.length ? `<span class="chip warn">${S.missing.length} fehlen</span>` : '<span class="chip ok">komplett</span>'}</summary>
    <form class="body" data-form="cfg">
      ${secret(c, 'anthropic', 'apiKey', 'Claude API-Schlüssel', 'console.anthropic.com → API Keys')}
      ${secret(c, 'video', 'falKey', 'fal.ai-Schlüssel', 'fal.ai → Dashboard → Keys (für KI-Szenen, Schnitt, Untertitel)')}
      ${select('voice.provider', 'Stimme', c.voice.provider, [['elevenlabs', 'ElevenLabs (empfohlen)'], ['openai', 'OpenAI']])}
      ${secret(c, 'voice', 'elevenKey', 'ElevenLabs-Schlüssel', 'elevenlabs.io → Developers → API Keys')}
      ${field('voice.voiceId', 'ElevenLabs-Stimme (Voice ID)', c.voice.voiceId, { hint: 'Standard: George – tief, ruhig, glaubwürdig' })}
      ${secret(c, 'voice', 'openaiKey', 'OpenAI-Schlüssel (nur falls OpenAI-Stimme)')}
      ${secret(c, 'trends', 'youtubeKey', 'YouTube Data API-Schlüssel (optional)', 'macht die Marktanalyse genauer: echte Aufrufzahlen')}
      <div class="row"><button class="btn primary" type="submit">Speichern</button>
        <button class="btn small" type="button" data-test="claude">Claude testen</button>
        <button class="btn small" type="button" data-test="fal">fal testen</button>
        <button class="btn small" type="button" data-test="voice">Stimme testen</button></div>
    </form></details>

  <details class="set" data-key="plat"><summary><span>Plattformen</span><span class="chip ${S.platforms.instagram || S.platforms.tiktok || S.platforms.youtube ? 'ok' : 'warn'}">${PLATS.filter((k) => S.platforms[k]).length} von 3</span></summary>
    <div class="body">
      <div class="sub">Instagram</div>
      ${S.platforms.instagram
        ? `<div class="plat-row"><span><b>@${esc(ig.username)}</b><br><span class="small muted">verbunden · Zugang verlängert sich automatisch</span></span><span class="row"><button class="btn small" data-test="instagram">Testen</button><button class="btn small ghost danger" data-disconnect="instagram">Trennen</button></span></div>`
        : `<form class="stack" data-form="ig"><label class="f">Instagram-Zugangstoken<textarea name="token" rows="3" placeholder="IGAA…" autocapitalize="off" spellcheck="false"></textarea></label>
           <div class="help">Profi-Konto nötig (Creator oder Business). <ol><li>developers.facebook.com → App erstellen → Anwendungsfall „Instagram API“</li><li>„API-Einrichtung mit Instagram-Login“ → dein Konto hinzufügen → „Token generieren“</li><li>Token kopieren und hier einfügen</li></ol></div>
           <button class="btn primary" type="submit">Instagram verbinden</button></form>`}

      <div class="sub">YouTube</div>
      ${S.platforms.youtube
        ? `<div class="plat-row"><span><b>${esc(yt.channelTitle || 'Kanal verbunden')}</b><br><span class="small muted">verbunden</span></span><span class="row"><button class="btn small" data-test="youtube">Testen</button><button class="btn small ghost danger" data-disconnect="youtube">Trennen</button></span></div>`
        : `<form class="stack" data-form="cfg">
            ${field('youtube.clientId', 'Google Client-ID', yt.clientId, { placeholder: '…apps.googleusercontent.com' })}
            ${secret(c, 'youtube', 'clientSecret', 'Google Client-Geheimnis')}
            <div class="help"><ol><li>console.cloud.google.com → Projekt → „YouTube Data API v3“ aktivieren</li><li>OAuth-Zustimmungsbildschirm: Extern, dich als Testnutzer, dann <b>„In Produktion“</b> (sonst läuft der Zugang nach 7 Tagen ab)</li><li>Anmeldedaten → OAuth-Client „Webanwendung“ → Weiterleitungs-URI unten eintragen</li></ol></div>
            <div class="row"><button class="btn" type="submit">Speichern</button><button class="btn primary" type="button" data-connect="youtube" ${yt.clientId && yt.clientSecretSet ? '' : 'disabled'}>Mit Google verbinden</button></div>
          </form>`}
      ${select('youtube.privacy', 'Sichtbarkeit auf YouTube', yt.privacy, [['public', 'Öffentlich'], ['unlisted', 'Nicht gelistet'], ['private', 'Privat']]).replace('<label class="f">', '<label class="f" data-autosave="1">')}

      <div class="sub">TikTok</div>
      ${S.platforms.tiktok
        ? `<div class="plat-row"><span><b>@${esc(tt.username || 'verbunden')}</b><br><span class="small muted">verbunden</span></span><span class="row"><button class="btn small" data-test="tiktok">Testen</button><button class="btn small ghost danger" data-disconnect="tiktok">Trennen</button></span></div>`
        : `<form class="stack" data-form="cfg">
            ${field('tiktok.clientKey', 'TikTok Client Key', tt.clientKey)}
            ${secret(c, 'tiktok', 'clientSecret', 'TikTok Client Secret')}
            <div class="help"><ol><li>developers.tiktok.com → App anlegen → Produkte „Login Kit“ und „Content Posting API“</li><li>Weiterleitungs-URI unten eintragen, Datenschutz- und Nutzungsbedingungen: Links unten</li><li>Bis TikTok die App geprüft hat, geht nur „Entwurf ins Postfach“</li></ol></div>
            <div class="row"><button class="btn" type="submit">Speichern</button><button class="btn primary" type="button" data-connect="tiktok" ${tt.clientKey && tt.clientSecretSet ? '' : 'disabled'}>Mit TikTok verbinden</button></div>
          </form>`}
      ${select('tiktok.mode', 'So kommt das Video zu TikTok', tt.mode, [['entwurf', 'Entwurf ins TikTok-Postfach (ein Tipp in TikTok)'], ['direkt', 'Direkt veröffentlichen (nach TikTok-Prüfung)']]).replace('<label class="f">', '<label class="f" data-autosave="1">')}

      <div class="sub">Links für die Entwickler-Konsolen</div>
      <div class="small muted">Weiterleitungs-URI (Google und TikTok):</div>
      <div class="copy"><span>${esc(S.redirect)}</span><button class="btn small" data-copy="${esc(S.redirect)}">Kopieren</button></div>
      <div class="small muted">Datenschutz / Nutzungsbedingungen:</div>
      <div class="copy"><span>${esc(S.pages)}/privacy.html</span><button class="btn small" data-copy="${esc(S.pages)}/privacy.html">Kopieren</button></div>
      <div class="copy"><span>${esc(S.pages)}/terms.html</span><button class="btn small" data-copy="${esc(S.pages)}/terms.html">Kopieren</button></div>
    </div></details>

  <details class="set" data-key="auto"><summary><span>Autopilot</span><span class="chip ${c.autopilot.dailyVideo ? 'ok' : ''}">${c.autopilot.dailyVideo ? 'täglich ' + esc(c.autopilot.dailyTime) : 'auf Knopfdruck'}</span></summary>
    <form class="body" data-form="cfg">
      ${S.batteryOk ? '<div class="note ok small">Hintergrund erlaubt ✓</div>' : '<button class="btn" type="button" data-act="battery">Im Hintergrund erlauben (wichtig für den Autopiloten)</button>'}
      ${toggle('autopilot.dailyVideo', 'Jeden Tag automatisch ein Video', c.autopilot.dailyVideo, 'Ich erstelle es selbstständig und melde mich, wenn es fertig ist.')}
      ${field('autopilot.dailyTime', 'Uhrzeit', c.autopilot.dailyTime, { type: 'time' })}
      ${toggle('autopilot.autoPost', 'Ohne OK sofort hochladen', c.autopilot.autoPost, 'Fertige Videos gehen direkt auf alle verbundenen Plattformen.')}
      ${toggle('quality.blockOnFail', 'Bei Faktencheck-Bedenken erst fragen', c.quality.blockOnFail, 'Empfohlen – schützt deinen Kanal vor Falschaussagen.')}
      ${field('budget.monthlyUsd', 'Monatsbudget in $', c.budget.monthlyUsd, { type: 'number', hint: 'darüber startet kein neues Video' })}
      ${field('autopilot.radarHours', 'Marktanalyse alle … Stunden', c.autopilot.radarHours, { type: 'number' })}
      <button class="btn primary" type="submit">Speichern</button>
    </form></details>

  <details class="set" data-key="style"><summary><span>Kanal &amp; Stil</span></summary>
    <form class="body" data-form="cfg">
      ${field('channel.name', 'Kanalname', c.channel.name)}
      ${field('channel.niche', 'Thema des Kanals (Englisch)', c.channel.niche)}
      ${select('captions.highlight', 'Farbe des gesprochenen Worts in den Untertiteln', c.captions.highlight, [['yellow', 'Gelb'], ['purple', 'Violett'], ['cyan', 'Cyan'], ['green', 'Grün'], ['orange', 'Orange'], ['white', 'Weiß']])}
      ${select('captions.words', 'Wörter pro Untertitel', c.captions.words, [[1, '1 Wort'], [2, '2 Wörter'], [3, '3 Wörter']])}
      ${field('video.model', 'KI-Videomodell (fal.ai)', c.video.model, { hint: 'Standard: fal-ai/veo3.1/fast' })}
      ${field('video.pricePerSecond', 'Preis pro Videosekunde in $', c.video.pricePerSecond, { type: 'number' })}
      ${field('video.style', 'Bildstil (Englisch)', c.video.style)}
      <button class="btn primary" type="submit">Speichern</button>
    </form></details>

  <details class="set" data-key="cost" open><summary><span>Kosten diesen Monat</span><span class="chip num" id="cost-chip">${usd(m.total)}</span></summary>
    <div class="body">
      <div class="bar-cost"><i style="width:${pct}%"></i></div>
      <div class="kv"><dt>KI-Videoszenen</dt><dd class="num">${usd(m.video)}</dd><dt>Claude</dt><dd class="num">${usd(m.claude)}</dd><dt>Websuche</dt><dd class="num">${usd(m.search)}</dd><dt>Stimme</dt><dd class="num">${m.voice ? usd(m.voice) : 'im ElevenLabs-Abo'}</dd><dt>Budget</dt><dd class="num">${usd(budget)}</dd></div>
    </div></details>

  <details class="set" data-key="maint"><summary><span>Wartung &amp; Updates</span><span class="chip">v${esc(S.version)}</span></summary>
    <div class="body">
      <div class="row"><button class="btn" data-act="update">Nach Update suchen</button>${S.update && S.update.available ? `<button class="btn primary" data-open="${esc(S.update.url)}">Update ${esc(S.update.latest)} laden</button>` : ''}</div>
      ${S.update && S.update.checkedAt ? `<p class="small faint">Zuletzt geprüft ${ago(S.update.checkedAt)}${S.update.available ? '' : ' · du hast die neueste Version'}</p>` : ''}
      <form class="stack" data-form="cfg">
        ${secret(c, 'github', 'token', 'GitHub-Token (optional)', 'damit Fehler automatisch gemeldet und nachts von Claude behoben werden – Rechte: Issues (Lesen & Schreiben) für ki-autopilot')}
        ${toggle('github.autoReport', 'Fehler automatisch melden', c.github.autoReport)}
        <button class="btn" type="submit">Speichern</button>
      </form>
      <form class="stack" data-form="report"><label class="f">Problem melden<textarea name="text" rows="3" placeholder="Was ist passiert?"></textarea></label><button class="btn" type="submit">Senden</button></form>
      <button class="btn ghost small" data-open="https://github.com/${'ahmedkay980-create/ki-autopilot'}#readme">Anleitung öffnen</button>
      <details class="more" data-key="log"><summary>Protokoll</summary><div id="log">${logHtml()}</div></details>
    </div></details>`;
}

function logHtml() {
  return (S.log || []).slice(0, 60).map((l) => `<div class="logline ${esc(l.level)}"><time>${clock(l.at)} ${new Date(l.at).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}</time><span>${esc(l.text)}</span></div>`).join('') || '<p class="small faint">Noch nichts passiert.</p>';
}

function updateMehrLive() {
  const chip = $('#cost-chip');
  if (chip) chip.textContent = usd((S.costs.month || {}).total);
  const log = $('#log');
  if (log) log.innerHTML = logHtml();
}

// ---------- Aktionen ----------
function toast(text, err) {
  const t = $('#toast');
  t.textContent = text;
  t.className = 'toast' + (err ? ' err' : '');
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), err ? 6000 : 3200);
}

function dialog(html) {
  const d = $('#dialog');
  d.innerHTML = `<div class="dialog">${html}</div>`;
  d.hidden = false;
  d.onclick = (e) => { if (e.target === d) closeDialog(); };
}
function closeDialog() { $('#dialog').hidden = true; $('#dialog').innerHTML = ''; }

function confirmBox(text, yes, fn) {
  dialog(`<p>${esc(text)}</p><div class="row"><button class="btn primary" data-yes>${esc(yes)}</button><button class="btn ghost" data-no>Abbrechen</button></div>`);
  $('#dialog [data-yes]').onclick = () => { closeDialog(); fn(); };
  $('#dialog [data-no]').onclick = closeDialog;
}

async function run(btn, fn, okText) {
  const old = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="spin"></i>'; }
  try {
    const r = await fn();
    if (okText) toast(typeof okText === 'function' ? okText(r) : okText);
    await refresh(true);
    return r;
  } catch (e) {
    toast(e.message, true);
  } finally {
    if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = old; }
  }
}

function copy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  if (ok) toast('Kopiert');
  else if (window.Android) window.Android.share(text);
}

function formToConfig(form) {
  const out = {};
  $$('input[name], select[name], textarea[name]', form).forEach((el) => {
    const [sec, key] = el.name.split('.');
    if (!key) return;
    let v;
    if (el.type === 'checkbox') v = el.checked;
    else if (el.type === 'number') { if (el.value === '') return; v = Number(el.value); }
    else if (key === 'words') v = Number(el.value);
    else v = el.value;
    if (el.dataset.secret && v === '') return;
    (out[sec] = out[sec] || {})[key] = v;
  });
  return out;
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-tab]');
  if (a) { e.preventDefault(); go(a.dataset.tab); return; }
  const o = e.target.closest('[data-open]');
  if (o) { e.preventDefault(); openUrl(o.dataset.open); return; }
  const g = e.target.closest('[data-go]');
  if (g) { if (g.dataset.openKey) openKeys.add(g.dataset.openKey); go(g.dataset.go); return; }
  const cp = e.target.closest('[data-copy]');
  if (cp) { e.preventDefault(); copy(cp.dataset.copy); return; }
  const t = e.target.closest('[data-test]');
  if (t) { run(t, () => api('POST', '/test/' + t.dataset.test), (r) => r); return; }
  const cn = e.target.closest('[data-connect]');
  if (cn) { run(cn, async () => { const url = await api('POST', '/connect/' + cn.dataset.connect); openUrl(url); }, 'Im Browser anmelden – danach geht es automatisch zurück in die App'); return; }
  const dc = e.target.closest('[data-disconnect]');
  if (dc) { confirmBox(`${LABEL[dc.dataset.disconnect]} wirklich trennen?`, 'Trennen', () => run(null, () => api('POST', '/disconnect/' + dc.dataset.disconnect), 'Getrennt')); return; }
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const id = b.dataset.id;
  switch (b.dataset.act) {
    case 'oneclick': run(b, () => api('POST', '/oneclick'), 'Los geht’s – ich melde mich, wenn das Video fertig ist'); break;
    case 'produce': run(b, () => api('POST', `/topics/${id}/produce`), 'Video wird erstellt'); break;
    case 'radar': run(b, () => api('POST', '/radar'), 'Marktanalyse läuft'); break;
    case 'publish': run(b, () => api('POST', `/videos/${id}/publish`), 'Wird hochgeladen – läuft im Hintergrund weiter'); break;
    case 'approve': run(b, () => api('POST', `/videos/${id}/approve`), 'Geht weiter'); break;
    case 'retry': run(b, () => api('POST', `/videos/${id}/retry`), 'Geht weiter'); break;
    case 'discard': confirmBox('Dieses Video verwerfen?', 'Verwerfen', () => run(null, () => api('POST', `/videos/${id}/discard`), 'Verworfen')); break;
    case 'stop': confirmBox('Video anhalten? Bereits Erstelltes bleibt erhalten, du kannst später weitermachen.', 'Anhalten', () => run(null, () => api('POST', '/stop'), 'Wird angehalten')); break;
    case 'battery': if (window.Android && window.Android.battery) window.Android.battery(); break;
    case 'update': run(b, () => api('POST', '/update'), (u) => (u.available ? `Update ${u.latest} verfügbar` : 'Du hast die neueste Version')); break;
    default: break;
  }
});

document.addEventListener('submit', (e) => {
  const f = e.target.closest('form[data-form]');
  if (!f) return;
  e.preventDefault();
  const btn = $('button[type=submit]', f);
  if (f.dataset.form === 'cfg') {
    run(btn, () => api('POST', '/config', formToConfig(f)), 'Gespeichert').then(() => { lastSig = ''; render(true); });
  } else if (f.dataset.form === 'ig') {
    run(btn, () => api('POST', '/instagram/token', { token: f.token.value }), (r) => r).then(() => { lastSig = ''; render(true); });
  } else if (f.dataset.form === 'report') {
    run(btn, () => api('POST', '/report', { text: f.text.value }), (r) => r);
  }
});

document.addEventListener('change', (e) => {
  const lab = e.target.closest('[data-autosave]');
  if (!lab) return;
  const el = e.target;
  const [sec, key] = el.name.split('.');
  api('POST', '/config', { [sec]: { [key]: el.value } }).then(() => toast('Gespeichert')).catch((err) => toast(err.message, true));
});

document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

refresh(true);
