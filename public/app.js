'use strict';
// KI-Autopilot – App fürs Handy. Spricht nur mit dem eigenen Server.
(() => {
  const LS = {
    get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* egal */ } },
  };
  const S = { st: null, sig: '', tabsHtml: '', hold: false, open: new Set(LS.get('kia-open', [])), cdrafts: {}, cmt: 'entwurf', voices: null, installEvt: null, timer: null };

  const VSTATUS = {
    wartet: ['In der Warteschlange', ''], recherche: ['Recherchiert', 'accent'], skript: ['Schreibt das Skript', 'accent'], faktencheck: ['Prüft die Fakten', 'accent'],
    stimme: ['Spricht ein', 'accent'], szenen: ['Erstellt KI-Szenen', 'accent'], schnitt: ['Schneidet', 'accent'], pruefen: ['Kurz prüfen', 'warn'],
    fertig: ['Fertig', 'ok'], geplant: ['Geplant', 'ok'], postet: ['Wird gepostet', 'accent'], online: ['Online', 'ok'], gemessen: ['Online', 'ok'],
    fehler: ['Fehler', 'bad'], gestoppt: ['Gestoppt', ''], verworfen: ['Verworfen', ''],
  };
  const STEPS = ['recherche', 'skript', 'faktencheck', 'stimme', 'szenen', 'schnitt'];
  const ACTIVE = ['wartet', ...STEPS, 'postet'];
  const FORMAT_DE = { news60: 'News in 60 s', explainer: 'Erklärt', tool: 'KI-Werkzeug', myth: 'Mythos vs. Fakt', list: 'Top 3', future: 'Was es für dich heißt' };
  const SRC = { youtube: ['YouTube', 'src-yt'], hn: ['Hacker News', 'src-hn'], reddit: ['Reddit', 'src-reddit'], web: ['News', 'src-web'] };
  const TZS = [['America/New_York', 'USA Ostküste (New York)'], ['America/Chicago', 'USA Mitte (Chicago)'], ['America/Los_Angeles', 'USA Westküste (Los Angeles)'], ['Europe/London', 'Großbritannien (London)'], ['Europe/Berlin', 'Deutschland (Berlin)'], ['Asia/Kolkata', 'Indien (Delhi)'], ['Australia/Sydney', 'Australien (Sydney)']];
  const MODELS = [['claude-sonnet-5-5', 'Sonnet 5.5 – empfohlen'], ['claude-haiku-5-5', 'Haiku 5.5 – günstig'], ['claude-opus-5-5', 'Opus 5.5 – beste Qualität']];
  const FAL_MODELS = ['fal-ai/veo3/fast', 'fal-ai/veo3', 'fal-ai/kling-video/v2.1/standard/text-to-video', 'fal-ai/minimax/hailuo-02/standard/text-to-video'];
  const OPENAI_VOICES = ['onyx', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'sage', 'shimmer'];

  // ---------- Helfer ----------
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const DOW = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const nf = (v, d = 0) => (isNum(v) ? v.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d }) : '–');
  const usd = (v) => (isNum(v) ? v.toLocaleString('de-DE', { style: 'currency', currency: 'USD' }) : '–');
  const big = (n) => (!isNum(n) ? '–' : n >= 1e6 ? nf(n / 1e6, 1) + ' Mio.' : n >= 1e4 ? nf(n / 1e3, 0) + ' Tsd.' : nf(n));
  const when = (iso) => {
    if (!iso) return '–';
    const d = new Date(iso);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const day = new Date(d); day.setHours(0, 0, 0, 0);
    const diff = Math.round((day - today) / 864e5);
    const t = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (diff === 0) return `heute ${t}`;
    if (diff === 1) return `morgen ${t}`;
    if (diff === -1) return `gestern ${t}`;
    return `${DOW[d.getDay()]} ${pad(d.getDate())}.${pad(d.getMonth() + 1)}. ${t}`;
  };
  const ago = (iso) => {
    if (!iso) return 'noch nie';
    const m = Math.round((Date.now() - Date.parse(iso)) / 60e3);
    if (m < 1) return 'gerade eben';
    if (m < 60) return `vor ${m} Min.`;
    if (m < 48 * 60) return `vor ${Math.round(m / 60)} Std.`;
    return `vor ${Math.round(m / 1440)} Tagen`;
  };
  const audienceTime = (iso, tz) => {
    try { return new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: tz }); } catch { return ''; }
  };
  const tzCity = (tz) => (tz || '').split('/').pop().replace(/_/g, ' ');
  const spin = '<span class="spin" aria-hidden="true"></span>';
  const chip = (text, cls = '') => `<span class="chip ${cls}">${text}</span>`;
  const vchip = (v) => { const [l, c] = VSTATUS[v.status] || [v.status, '']; return chip((ACTIVE.includes(v.status) ? spin : '') + esc(l), c); };
  const ICON = {
    radar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><path d="M12 12l6-6"/></svg>',
    studio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10 9.5v5l4.5-2.5z" fill="currentColor"/></svg>',
    kanal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
    kommentare: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M4 5h16v11H9l-5 4z"/></svg>',
    mehr: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>',
  };
  const VIEWS = [['radar', 'Radar'], ['studio', 'Studio'], ['kanal', 'Kanal'], ['kommentare', 'Antworten'], ['mehr', 'Mehr']];

  // ---------- Server ----------
  async function api(path, body, method = 'POST') {
    const res = await fetch(path, { method, credentials: 'same-origin', headers: method === 'GET' ? {} : { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
    let j = {};
    try { j = await res.json(); } catch { /* leer */ }
    if (res.status === 401 && path !== '/api/login') { renderLogin(); throw new Error(j.error || 'Bitte anmelden.'); }
    if (!res.ok) throw new Error(j.error || `Fehler ${res.status}`);
    return j;
  }
  async function run(el, fn, ok) {
    const html = el ? el.innerHTML : '';
    if (el) { el.disabled = true; el.innerHTML = spin + ' ' + html; }
    try {
      const r = await fn();
      if (ok) toast(typeof ok === 'function' ? ok(r) : ok);
      await load(true);
      return r || true;
    } catch (e) {
      toast(e.message, true);
      if (el && el.isConnected) { el.disabled = false; el.innerHTML = html; }
      return null;
    }
  }
  let toastT;
  function toast(msg, err) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (err ? ' err' : '');
    t.hidden = false;
    clearTimeout(toastT);
    toastT = setTimeout(() => { t.hidden = true; }, err ? 6500 : 3800);
  }
  function ask(title, text, okLabel = 'OK') {
    return new Promise((resolve) => {
      const d = $('#dialog');
      d.innerHTML = `<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-t"><h2 class="h2" id="dlg-t">${esc(title)}</h2><p class="muted">${esc(text)}</p>
        <div class="grid2"><button class="btn ghost" data-dlg="0">Abbrechen</button><button class="btn primary" data-dlg="1">${esc(okLabel)}</button></div></div>`;
      d.hidden = false;
      d.onclick = (e) => {
        const b = e.target.closest('[data-dlg]');
        if (!b && e.target !== d) return;
        d.hidden = true; d.innerHTML = ''; d.onclick = null;
        resolve(Boolean(b && b.dataset.dlg === '1'));
      };
    });
  }

  async function load(force) {
    try {
      S.st = await api('/api/state', null, 'GET');
      render(force);
    } catch (e) { if (!S.st) $('#app').innerHTML = `<div class="card empty"><strong>Keine Verbindung</strong><p>${esc(e.message)}</p></div>`; }
  }

  // ---------- Rendern ----------
  const viewId = () => { const h = location.hash.replace('#', '').split('/')[0]; return VIEWS.some(([v]) => v === h) ? h : 'radar'; };

  function render(force) {
    const st = S.st;
    if (!st) return;
    const tabs = renderTabs(st);
    const tabEl = $('#tabs');
    tabEl.hidden = false;
    if (tabs !== S.tabsHtml) { tabEl.innerHTML = tabs; S.tabsHtml = tabs; }
    const main = $('#app');
    const a = document.activeElement;
    const typing = a && main.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
    const playing = [...main.querySelectorAll('video')].some((v) => !v.paused);
    const v = viewId();
    const { now, ...rest } = st;
    const sig = v + Math.floor(Date.now() / 60e3) + JSON.stringify(rest) + (S.installEvt ? 1 : 0);
    if (!force && (typing || playing || S.hold || sig === S.sig)) return;
    S.sig = sig;
    main.innerHTML = RENDER[v](st);
    const target = location.hash.split('/')[1];
    if (target && force) { const el = document.getElementById('v-' + target); if (el) el.scrollIntoView({ block: 'start' }); }
  }

  function renderTabs(st) {
    const badge = {
      studio: st.videos.filter((x) => ACTIVE.includes(x.status) || x.status === 'pruefen' || x.status === 'fehler').length,
      kommentare: st.comments.filter((c) => c.status === 'entwurf').length,
    };
    const cur = viewId();
    return VIEWS.map(([id, label]) => `<a href="#${id}" ${id === cur ? 'aria-current="page"' : ''}>${ICON[id]}<span>${label}</span>${badge[id] ? `<span class="badge">${badge[id]}</span>` : ''}</a>`).join('');
  }

  const head = (eyebrow, title, lede = '') => `<header class="head"><div class="eyebrow">${eyebrow}</div><h1 class="h1">${title}</h1>${lede ? `<p class="lede">${lede}</p>` : ''}</header>`;
  const empty = (title, text, extra = '') => `<div class="card empty"><strong>${title}</strong><p>${text}</p>${extra}</div>`;
  const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone;

  function statusStrip(st) {
    const s = st.status;
    const b = st.budget;
    const spent = b.spent.usd || 0;
    const tz = st.cfg.channel.audienceTz;
    const next = st.videos.filter((v) => v.status === 'geplant' && v.schedule).sort((x, y) => Date.parse(x.schedule.at) - Date.parse(y.schedule.at))[0];
    return `<div class="strip">
      ${s.dryRun ? chip('Trockenlauf', 'warn') : chip('Live', 'ok')}
      ${s.autopilot ? chip('Autopilot an', 'accent') : chip('Autopilot aus', 'bad')}
      ${chip(`Budget ${usd(spent)} / ${usd(b.limit)}`, b.limit && spent / b.limit > 0.85 ? 'warn' : '')}
      ${next ? chip(`Nächster Post ${when(next.schedule.at)} (${audienceTime(next.schedule.at, tz)} ${esc(tzCity(tz))})`) : chip(`Nächster Sendeplatz ${when(st.nextSlot)}`)}
    </div>`;
  }

  function setupCard(st) {
    const s = st.status;
    const items = [
      [s.claude, 'Claude', 'schreibt, recherchiert, prüft'],
      [s.voice, 'Stimme', 'ElevenLabs oder OpenAI'],
      [st.cfg.video.mode !== 'premium' || s.fal, 'fal.ai', 'KI-Videoszenen'],
      [s.instagram || s.yt, 'Instagram / YouTube', 'mindestens ein Kanal zum Posten'],
      [s.pushDevices > 0, 'Push', 'Nachricht aufs Handy'],
    ];
    const open = items.filter((x) => !x[0]);
    if (!open.length) return '';
    return `<section class="card warn"><div class="row between"><b>Noch ${open.length} Schritt${open.length === 1 ? '' : 'e'} bis startklar</b><a class="btn small" href="#mehr">Einrichten</a></div>
      <div class="row">${items.map(([ok, n, d]) => `<span class="chip ${ok ? 'ok' : ''}" title="${esc(d)}">${ok ? '✓' : '○'} ${esc(n)}</span>`).join('')}</div></section>`;
  }

  // ---------- Live: was gerade passiert ----------
  function liveCard(st) {
    const cur = st.videos.find((v) => ACTIVE.includes(v.status) && v.status !== 'wartet') || st.videos.find((v) => v.status === 'wartet');
    const next = st.videos.filter((v) => v.status === 'geplant' && v.schedule).sort((a, b) => Date.parse(a.schedule.at) - Date.parse(b.schedule.at))[0];
    const running = st.jobs.filter((j) => j.running).map((j) => j.label);
    const events = st.notifications.slice(0, 3);
    const idx = cur ? STEPS.indexOf(cur.status) : -1;
    return `<section class="card ${cur ? 'hot' : ''}"><div class="row between"><b>Gerade</b><span class="small faint">aktualisiert sich selbst</span></div>
      ${cur ? `<a href="#studio/${cur.id}" style="color:inherit;text-decoration:none" class="stack"><span>${spin.replace('class="spin"', 'class="spin" style="color:var(--accent)"')} <b>${esc((VSTATUS[cur.status] || [cur.status])[0])}</b> · ${esc(cur.title)}</span>
        <div class="steps">${STEPS.map((x, i) => `<span class="${i < idx ? 'done' : i === idx ? 'now' : ''}"></span>`).join('')}</div></a>`
        : `<span class="muted">${running.length ? spin + ' ' + esc(running.join(', ')) : 'Keine Produktion. Der Radar meldet sich mit neuen Themen.'}</span>`}
      ${next ? `<span class="small">Nächster Post: <b>${esc(next.title)}</b> · ${when(next.schedule.at)}</span>` : ''}
      ${events.length ? `<div class="hist">${events.map((n) => `<div><time>${esc(when(n.at))}</time><span>${esc(n.text)}</span></div>`).join('')}</div>` : ''}
    </section>`;
  }

  // ---------- Radar ----------
  function topicCard(t, i, st) {
    const inProd = t.status === 'in-produktion';
    const ev = (t.evidence || []).slice(0, 3).map((e) => {
      const [name, cls] = SRC[e.source] || [e.source, ''];
      return `<a class="chip" href="${esc(e.url)}" target="_blank" rel="noopener"><b class="${cls}">${esc(name)}</b> ${esc(e.label || '')}</a>`;
    }).join('');
    const demand = isNum(t.demand) ? t.demand : null;
    return `<article class="card topic ${i === 0 ? 'first' : ''}" data-topic="${t.id}">
      <div class="top"><span class="rank">${i + 1}</span>
        <div class="meter">${demand !== null ? `<div class="bar"><i style="width:${demand}%"></i></div><span>Nachfrage ${demand}${t.competition ? ' · Konkurrenz ' + esc(t.competition) : ''}</span>` : '<span>Eigenes Thema</span>'}</div>
        ${chip(esc(FORMAT_DE[t.format] || t.format || ''))}</div>
      <h3>${esc(t.title)}</h3>
      ${t.hook ? `<p class="hook">„${esc(t.hook)}“</p>` : ''}
      ${t.whyNow ? `<p class="why">${esc(t.whyNow)}${t.angle ? ' ' + esc(t.angle) : ''}</p>` : ''}
      ${ev ? `<div class="evidence">${ev}</div>` : ''}
      ${inProd ? `<a class="btn block" href="#studio/${t.videoId}">In Produktion – ansehen</a>`
        : `<div class="row"><button class="btn primary" style="flex:1" data-act="produce" ${st.status.claude ? '' : 'disabled'}>Video erstellen · ca. ${usd(st.budget.estimate)}</button><button class="btn ghost small" data-act="topic-discard" aria-label="Thema verwerfen">Weg</button></div>`}
    </article>`;
  }

  function vRadar(st) {
    const r = st.radar;
    const fresh = st.topics.filter((t) => t.status === 'neu' || t.status === 'in-produktion').sort((a, b) => (b.status === 'in-produktion') - (a.status === 'in-produktion') || b.score - a.score);
    const old = st.topics.filter((t) => t.status === 'alt');
    const srcs = Object.entries(r.sources || {}).filter(([, v]) => v.count).map(([k, v]) => `${(SRC[k] || [k])[0]} ${v.count}`).join(' · ');
    const radarRunning = st.jobs.some((j) => j.name === 'radar' && j.running);
    const install = !standalone() && S.installEvt ? `<section class="card hot"><div class="row between"><div><b>Als App installieren</b><p class="small muted">Eigenes Symbol, Vollbild, Push-Nachrichten.</p></div><button class="btn primary small" data-act="install">Installieren</button></div></section>` : '';
    return `${head('Trend-Radar', 'Was gerade läuft', r.lastRun ? `Analysiert ${ago(r.lastRun)} · ${r.signals} Signale${srcs ? ' aus ' + esc(srcs) : ''}` : 'Noch nicht analysiert.')}
      ${statusStrip(st)}
      ${liveCard(st)}
      ${install}
      ${setupCard(st)}
      <button class="btn block" data-act="radar" ${radarRunning ? 'disabled' : ''}>${radarRunning ? spin + ' Analysiert den Markt …' : 'Neu analysieren'}</button>
      ${(r.errors || []).length ? `<div class="note warn small">${r.errors.map(esc).join('<br>')}</div>` : ''}
      ${st.cfg.autoProduce.enabled ? `<div class="note ok small">Vollautomatik an: Jeden Tag um ${esc(st.cfg.autoProduce.at)} Uhr wird das Top-Thema produziert und gepostet.</div>` : ''}
      <section class="sec">${fresh.length ? fresh.map((t, i) => topicCard(t, i, st)).join('') : empty('Noch keine Themen', 'Tippe auf „Neu analysieren“. Der Radar schaut auf YouTube, Hacker News, Reddit und die News der letzten 48 Stunden.')}</section>
      <form class="card" data-form="topic">
        <b>Eigenes Thema</b>
        <input type="text" name="title" placeholder="z. B. Can AI really replace Google search?" required aria-label="Eigenes Thema">
        <button class="btn" type="submit">Als Thema anlegen</button>
      </form>
      ${old.length ? `<details class="set" ${S.open.has('old') ? 'open' : ''} data-open="old"><summary>Ältere Vorschläge (${old.length})</summary><div class="body">${old.map((t) => `<div class="row between"><span class="small">${esc(t.title)}</span><button class="btn small ghost" data-act="revive" data-topic-id="${t.id}">Erstellen</button></div>`).join('')}</div></details>` : ''}`;
  }

  // ---------- Studio ----------
  function videoCard(v, st) {
    const tz = st.cfg.channel.audienceTz;
    const active = ACTIVE.includes(v.status) && v.status !== 'postet';
    const idx = STEPS.indexOf(v.status);
    let detail = '';
    if (v.status === 'wartet') detail = `Platz ${Math.max(1, st.status.queue.indexOf(v.id) + 1)} in der Warteschlange`;
    if (v.status === 'szenen') detail = `KI-Szenen: ${v.scenes.filter((s) => s.status === 'fertig' || s.status === 'ersatz' || s.status === 'grafik').length} von ${v.scenes.length} fertig`;
    if (v.status === 'faktencheck') detail = 'Jede Aussage wird mit den Quellen abgeglichen.';
    const m = v.metrics;
    const isOnline = v.status === 'online' || v.status === 'gemessen';
    const player = v.render && !v.render.deleted ? `<div class="vid-wrap"><video src="/media/${v.id}/final.mp4" poster="/media/${v.id}/cover.jpg" controls playsinline preload="none"></video></div>` : '';
    const media = isOnline ? '' : player;
    const plan = v.status === 'geplant' && v.schedule ? `Geht ${when(v.schedule.at)} online (${audienceTime(v.schedule.at, tz)} in ${esc(tzCity(tz))})` : '';
    const pub = v.published ? (v.published.dryRun ? `Trockenlauf ${when(v.published.at)} – nicht wirklich gepostet` : `Online seit ${when(v.published.at)}`) : '';
    const caption = v.script ? [v.script.caption, (v.script.hashtags || []).map((h) => '#' + h).join(' ')].filter(Boolean).join('\n\n') : '';
    const fc = v.factCheck;
    return `<article class="card ${v.status === 'pruefen' ? 'warn' : v.status === 'fehler' ? 'bad' : active ? 'hot' : ''}" id="v-${v.id}" data-video="${v.id}">
      <div class="row between">${vchip(v)}<span class="small faint">${v.costUsd ? usd(v.costUsd) + ' · ' : ''}${esc(FORMAT_DE[v.format] || '')}</span></div>
      ${isOnline && v.render ? `<div class="compact"><img class="thumb" src="/media/${v.id}/cover.jpg" alt="" loading="lazy"><h3 class="h2">${esc(v.title)}</h3></div>` : `<h3 class="h2">${esc(v.title)}</h3>`}
      ${active ? `<div class="steps">${STEPS.map((x, i) => `<span class="${i < idx ? 'done' : i === idx ? 'now' : ''}"></span>`).join('')}</div>${detail ? `<p class="small muted">${detail}</p>` : ''}
        <div class="row"><button class="btn small ghost danger" data-act="stop">Stoppen</button></div>` : ''}
      ${v.status === 'pruefen' && fc ? `<div class="note warn">${esc(fc.summary || 'Der Faktencheck hat Bedenken.')}</div>
        ${(fc.issues || []).filter((i) => !i.fixed).map((i) => `<div class="small"><b>„${esc(i.claim)}“</b><br><span class="muted">${esc(i.problem)}</span></div>`).join('')}
        <div class="grid2"><button class="btn primary" data-act="approve">Trotzdem freigeben</button><button class="btn ghost danger" data-act="discard">Verwerfen</button></div>` : ''}
      ${v.status === 'fehler' ? `<div class="note bad small">${esc(v.error || 'Unbekannter Fehler')}</div><div class="grid2"><button class="btn primary" data-act="retry">Weitermachen</button><button class="btn ghost danger" data-act="discard">Verwerfen</button></div>` : ''}
      ${v.status === 'gestoppt' ? `<div class="grid2"><button class="btn" data-act="retry">Weitermachen</button><button class="btn ghost danger" data-act="discard">Verwerfen</button></div>` : ''}
      ${media}
      ${plan || pub ? `<p class="small muted">${plan || pub}</p>` : ''}
      ${v.youtube ? `<div class="row small">${chip('YouTube ' + (v.youtube.stats ? big(v.youtube.stats.views) + ' Aufrufe' : esc(v.youtube.privacy || '')), v.youtube.privacy === 'public' ? 'ok' : 'warn')}${v.youtube.restricted || v.youtube.privacy === 'private' ? '<span class="small muted">YouTube hält den Upload privat, bis dein Google-Projekt geprüft ist (Mehr → YouTube).</span>' : ''}</div>` : ''}
      ${m ? `<div class="row small">${chip(big(m.views ?? m.reach) + ' Aufrufe')}${m.retention != null ? chip(nf(m.retention) + ' % geschaut', m.retention >= 50 ? 'ok' : 'warn') : ''}${m.sharesK != null ? chip(nf(m.sharesK, 1) + ' Shares/1.000') : ''}</div>` : ''}
      ${v.render && !v.render.deleted ? `<div class="row">
        ${!v.published ? '<button class="btn primary small" data-act="post-now">Jetzt posten</button>' : ''}
        <button class="btn small" data-act="share">Teilen</button>
        <a class="btn small ghost" href="/media/${v.id}/final.mp4" download="${esc(slug(v.title))}.mp4">Laden</a>
        ${v.published && v.published.permalink ? `<a class="btn small ghost" href="${esc(v.published.permalink)}" target="_blank" rel="noopener">Auf Instagram</a>` : ''}
        ${v.youtube && v.youtube.url ? `<a class="btn small ghost" href="${esc(v.youtube.url)}" target="_blank" rel="noopener">Auf YouTube</a>` : ''}
        ${!v.published ? '<button class="btn small ghost danger" data-act="discard">Verwerfen</button>' : ''}</div>` : ''}
      ${v.script ? `<details class="more" ${S.open.has(v.id) ? 'open' : ''} data-open="${v.id}"><summary>Skript, Quellen, Verlauf</summary>
        <div class="stack" style="margin-top:10px">
          ${isOnline ? player : ''}
          ${v.script.scenes ? `<div>${v.script.scenes.map((s, i) => `<div class="scene"><b>${i + 1}</b><span>${esc(s.narration)}</span></div>`).join('')}</div>` : ''}
          ${caption ? `<div class="stack"><div class="row between"><b class="small">Caption</b><button class="btn small ghost" data-act="copy" data-text="${esc(caption)}">Kopieren</button></div><div class="note" style="white-space:pre-line">${esc(caption)}</div></div>` : ''}
          ${fc ? `<div class="note ${fc.pass ? 'ok' : 'warn'} small"><b>Faktencheck:</b> ${esc(fc.summary || '')}${(fc.issues || []).filter((i) => i.fixed).length ? ` · ${(fc.issues || []).filter((i) => i.fixed).length} Stelle(n) korrigiert` : ''}</div>` : ''}
          ${v.research && v.research.sources.length ? `<div class="stack"><b class="small">Quellen</b>${v.research.sources.slice(0, 8).map((s) => `<a class="small" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title || s.url)}</a>`).join('')}</div>` : ''}
          <div class="hist">${(v.history || []).slice().reverse().slice(0, 14).map((h) => `<div><time>${esc(when(h.at))}</time><span>${esc(h.event)}</span></div>`).join('')}</div>
        </div></details>` : ''}
    </article>`;
  }
  const slug = (t) => String(t || 'video').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'video';

  function vStudio(st) {
    const vids = st.videos;
    const attention = vids.filter((v) => v.status === 'pruefen' || v.status === 'fehler');
    const active = vids.filter((v) => ACTIVE.includes(v.status));
    const ready = vids.filter((v) => v.status === 'fertig' || v.status === 'geplant').sort((a, b) => Date.parse((a.schedule || {}).at || 0) - Date.parse((b.schedule || {}).at || 0));
    const online = vids.filter((v) => v.status === 'online' || v.status === 'gemessen').slice(0, 12);
    const stopped = vids.filter((v) => v.status === 'gestoppt');
    const sec = (title, list) => (list.length ? `<section class="sec"><div class="sec-title"><h2 class="h2">${title}</h2><span class="small faint">${list.length}</span></div>${list.map((v) => videoCard(v, st)).join('')}</section>` : '');
    if (!vids.length) return `${head('Studio', 'Deine Videos')}${empty('Noch keine Videos', 'Tippe im Radar bei einem Thema auf „Video erstellen“. Hier siehst du dann jeden Schritt bis zum fertigen Video.', '<a class="btn primary" href="#radar">Zum Radar</a>')}`;
    return `${head('Studio', 'Deine Videos', st.status.autoPost ? 'Fertige Videos gehen automatisch zum nächsten Sendeplatz online.' : 'Fertige Videos warten auf deinen Tipp auf „Jetzt posten“.')}
      ${sec('Braucht dich', attention)}${sec('In Arbeit', active)}${sec('Fertig und geplant', ready)}${sec('Online', online)}${sec('Gestoppt', stopped)}`;
  }

  // ---------- Kanal ----------
  function spark(list) {
    if (list.length < 2) return '<p class="small muted">Die Kurve erscheint nach dem zweiten Tag.</p>';
    const W = 600, H = 120;
    const ys = list.map((f) => f.count);
    let min = Math.min(...ys), max = Math.max(...ys);
    if (min === max) { min -= 1; max += 1; }
    const x = (i) => (i / (list.length - 1)) * W;
    const y = (v) => 8 + (1 - (v - min) / (max - min)) * (H - 16);
    const d = list.map((f, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(f.count).toFixed(1)}`).join(' ');
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Follower von ${list[0].count} auf ${list[list.length - 1].count}"><path d="${d} L${W},${H} L0,${H} Z" fill="var(--accent-soft)"/><path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round"/></svg>`;
  }

  function vKanal(st) {
    const w = st.stats.week;
    const f = st.followers;
    const last = f.length ? f[f.length - 1].count : null;
    const weekAgo = f.length > 7 ? f[f.length - 8].count : f.length ? f[0].count : null;
    const rep = st.reports[0];
    const posted = st.videos.filter((v) => v.published).sort((a, b) => Date.parse(b.published.at) - Date.parse(a.published.at));
    const formats = Object.entries(st.stats.formats || {}).sort((a, b) => b[1].score - a[1].score);
    const ytViews = st.videos.filter((v) => v.youtube && v.youtube.stats && Date.now() - Date.parse(v.youtube.at || v.createdAt) < 7 * 864e5).reduce((a, v) => a + v.youtube.stats.views, 0);
    return `${head('Kanal', esc(st.cfg.channel.handle || st.cfg.channel.name), st.status.instagram || st.status.yt ? `${w.posts} Video${w.posts === 1 ? '' : 's'} in den letzten 7 Tagen${st.status.ytChannel ? ' · YouTube: ' + esc(st.status.ytChannel) : ''}` : 'Verbinde Instagram oder YouTube, dann erscheinen hier Aufrufe, Zuschauzeit und Follower.')}
      <div class="tiles">
        <div class="tile"><span class="n">${big(w.views)}</span><span class="l">Aufrufe · 7 Tage</span></div>
        <div class="tile"><span class="n">${w.retention != null ? nf(w.retention) + ' %' : '–'}</span><span class="l">Ø geschaut</span></div>
        <div class="tile"><span class="n">${big(ytViews)}</span><span class="l">YouTube-Aufrufe · 7 Tage</span></div>
        <div class="tile"><span class="n">${big(last)}</span><span class="l">Follower${last != null && weekAgo != null ? ` · ${last - weekAgo >= 0 ? '+' : ''}${nf(last - weekAgo)}` : ''}</span></div>
      </div>
      <section class="card"><b>Follower</b><div class="spark">${spark(f)}</div></section>
      ${rep ? `<section class="card"><div class="row between"><b>Wochen-Review</b><span class="small faint">${esc(when(rep.at))}</span></div><p>${esc(rep.summary)}</p>
        ${(rep.learnings || []).length ? `<ul style="margin:0;padding-left:18px;display:grid;gap:4px">${rep.learnings.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
        <p class="small muted">Die Erkenntnisse fließen automatisch in die nächsten Skripte ein.</p></section>` : ''}
      ${formats.length ? `<section class="card flat"><div class="li"><b>Formate</b></div>${formats.map(([k, v]) => `<div class="li"><div class="body"><b>${esc(FORMAT_DE[k] || k)}</b><span class="meta">${v.count} Video${v.count === 1 ? '' : 's'}</span></div><span class="chip ${v.score >= 1 ? 'ok' : 'warn'}">Score ${nf(v.score, 2)}</span></div>`).join('')}</section>` : ''}
      <section class="sec"><h2 class="h2">Veröffentlicht</h2>
        ${posted.length ? `<div class="card flat list">${posted.map((v) => {
          const m = v.metrics;
          return `<a class="li" href="#studio/${v.id}" style="color:inherit;text-decoration:none">${v.render ? `<img class="thumb" src="/media/${v.id}/cover.jpg" alt="" loading="lazy">` : ''}
            <div class="body"><b>${esc(v.title)}</b><span class="meta">${esc(when(v.published.at))}${v.published.dryRun ? ' · Trockenlauf' : ''}${m ? ` · IG ${big(m.views ?? m.reach)}${m.retention != null ? ` · ${nf(m.retention)} % geschaut` : ''}` : ''}${v.youtube && v.youtube.stats ? ` · YT ${big(v.youtube.stats.views)}` : ''}</span></div></a>`;
        }).join('')}</div>` : empty('Noch nichts veröffentlicht', 'Sobald das erste Video online ist, steht es hier mit seinen Zahlen.')}
      </section>`;
  }

  // ---------- Kommentare ----------
  function vKommentare(st) {
    const tabs = [['entwurf', 'Entwürfe'], ['beantwortet', 'Beantwortet'], ['ignoriert', 'Ignoriert']];
    const list = st.comments.filter((c) => c.status === S.cmt);
    const mode = { entwurf: 'Alle Antworten warten hier auf dich.', 'auto-lob': 'Danke-Antworten auf Lob gehen automatisch raus, der Rest wartet hier.', 'auto-alle': 'Antworten gehen automatisch raus – außer bei Kritik und Fehlerhinweisen.' }[st.cfg.commentMode];
    return `${head('Kommentare', 'Antworten', `Alle 15 Minuten holt die App neue Kommentare und schreibt Antworten. ${mode}`)}
      <div class="seg" role="group">${tabs.map(([k, l]) => `<button data-act="cmt-tab" data-v="${k}" aria-pressed="${S.cmt === k}">${l} ${st.comments.filter((c) => c.status === k).length}</button>`).join('')}</div>
      ${list.length ? list.map((c) => `<article class="card" data-cid="${esc(c.id)}">
        <div class="row between"><b>@${esc(c.username)}</b><span class="small faint">${esc(when(c.timestamp))}</span></div>
        <span class="small muted">${c.platform === 'youtube' ? 'YouTube' : 'Instagram'} · zu „${esc(c.videoTitle)}“ · ${esc(c.category)}</span>
        <blockquote>${esc(c.text)}</blockquote>
        ${c.status === 'entwurf' ? `<textarea data-cdraft="${esc(c.id)}" rows="2" aria-label="Antwort">${esc(S.cdrafts[c.id] ?? c.draft ?? '')}</textarea>
          <div class="grid2"><button class="btn primary small" data-act="cmt-send">${st.status.dryRun ? 'Antworten (Trockenlauf)' : 'Antworten'}</button><button class="btn ghost small" data-act="cmt-ignore">Ignorieren</button></div>` : ''}
        ${c.reply ? `<div class="note ok small">Deine Antwort${c.reply.dryRun ? ' (Trockenlauf)' : ''}: ${esc(c.reply.text)}</div>` : ''}
      </article>`).join('') : empty('Hier ist nichts', st.status.instagram ? 'Neue Kommentare erscheinen automatisch.' : 'Sobald Instagram verbunden ist und Videos online sind, erscheinen hier Kommentare mit fertigen Antworten.')}`;
  }

  // ---------- Mehr ----------
  const toggle = (name, on, label, hint = '') => `<label class="toggle"><span>${label}${hint ? `<small>${hint}</small>` : ''}</span><input type="checkbox" name="${name}" ${on ? 'checked' : ''}></label>`;
  const field = (label, inner, hint = '') => `<label class="f">${label}${inner}${hint ? `<span class="hint">${hint}</span>` : ''}</label>`;
  const text = (name, value, ph = '') => `<input type="text" name="${name}" value="${esc(value)}" placeholder="${esc(ph)}">`;
  const num = (name, value, attrs = '') => `<input type="number" name="${name}" value="${esc(value)}" ${attrs}>`;
  const secret = (name, set, masked, ph = '') => `<input type="password" name="${name}" autocomplete="off" placeholder="${set ? 'gespeichert ' + esc(masked) + ' – leer lassen zum Behalten' : esc(ph)}">`;
  const select = (name, value, opts) => `<select name="${name}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const okChip = (ok, a = 'verbunden', b = 'fehlt') => chip(ok ? a : b, ok ? 'ok' : 'warn');
  const set = (id, title, aside, body) => `<details class="set" ${S.open.has('set-' + id) ? 'open' : ''} data-open="set-${id}"><summary><span>${title}</span>${aside || ''}</summary>${body}</details>`;
  const saveBtn = '<button class="btn primary" type="submit">Speichern</button>';
  const testBtn = (svc, label = 'Testen') => `<button class="btn" type="button" data-act="test" data-svc="${svc}">${label}</button>`;

  function vMehr(st) {
    const c = st.cfg;
    const s = st.status;
    const v = c.video;
    const voices = S.voices ? S.voices.map((x) => [x.id, `${x.name}${x.labels.accent ? ' · ' + x.labels.accent : ''}`]) : [[c.voice.voiceId, c.voice.voiceName || c.voice.voiceId]];
    const perVideo = st.budget.estimate;
    return `${head('Einstellungen', 'Mehr')}
      ${set('app', 'App und Push', okChip(s.pushDevices > 0, s.pushDevices + ' Gerät' + (s.pushDevices === 1 ? '' : 'e'), 'Push aus'), `<div class="body">
        ${!standalone() ? (S.installEvt ? '<button class="btn primary" data-act="install">Als App installieren</button>' : '<p class="small muted">Installieren: im Chrome-Menü (⋮) auf „App installieren“ bzw. „Zum Startbildschirm hinzufügen“ tippen.</p>') : '<p class="small muted">Läuft als installierte App.</p>'}
        <div class="grid2"><button class="btn" data-act="push">Push aktivieren</button>${testBtn('push', 'Test-Nachricht')}</div>
        <p class="small muted">Push meldet sich, wenn ein Video fertig, online oder eine Prüfung nötig ist – auch wenn die App zu ist.</p></div>`)}

      ${set('betrieb', 'Betrieb', s.dryRun ? chip('Trockenlauf', 'warn') : chip('Live', 'ok'), `<form data-hold data-section="betrieb">
        ${toggle('autopilot', c.autopilot, 'Autopilot', 'Radar, Posten, Kommentare und Zahlen laufen von selbst.')}
        ${toggle('dryRun', c.dryRun, 'Trockenlauf', 'Nichts wird wirklich gepostet oder beantwortet. Ausschalten = live.')}
        ${toggle('autoPost', c.autoPost, 'Fertige Videos automatisch posten')}
        ${field('Wann posten?', select('postTiming', c.postTiming, [['slot', 'Zum nächsten Sendeplatz'], ['sofort', 'Sofort nach Fertigstellung']]))}
        ${field('Sendeplätze', `<input type="text" name="slots" data-list value="${esc(c.slots.join(', '))}">`, 'Uhrzeiten deiner Zielgruppe, z. B. 12:00, 19:00')}
        ${field('Zielgruppe', select('channel.audienceTz', c.channel.audienceTz, TZS))}
        ${toggle('autoProduce.enabled', c.autoProduce.enabled, 'Vollautomatik', 'Jeden Tag selbst das Top-Thema produzieren – ganz ohne Tippen.')}
        ${field('Vollautomatik startet um', `<input type="time" name="autoProduce.at" value="${esc(c.autoProduce.at)}">`, 'deutsche Zeit')}
        ${field('Kommentare', select('commentMode', c.commentMode, [['auto-lob', 'Dank auf Lob automatisch, Rest als Entwurf'], ['entwurf', 'Alles als Entwurf'], ['auto-alle', 'Alles automatisch außer Kritik']]))}
        ${field('Monatsbudget in US-$', num('budget.monthlyUsd', c.budget.monthlyUsd, 'min="0" step="5"'), `Diesen Monat: ${usd(st.budget.spent.usd || 0)}. Ist es erreicht, startet kein neues Video.`)}
        ${toggle('quality.factCheck', c.quality.factCheck, 'Faktencheck', 'Ein zweites Modell prüft jede Aussage gegen die Quellen.')}
        ${toggle('quality.blockOnFail', c.quality.blockOnFail, 'Bei Bedenken anhalten', 'Statt zu posten, fragt die App dich kurz.')}
        ${saveBtn}</form>`)}

      ${set('claude', 'Claude', okChip(s.claude), `<form data-hold data-section="claude">
        <p class="small muted">Recherchiert, schreibt und prüft. Schlüssel: platform.claude.com → API Keys.</p>
        ${field('API-Schlüssel', secret('anthropic.apiKey', c.anthropic.apiKeySet, c.anthropic.apiKey, 'sk-ant-…'))}
        ${field('Modell für Skripte', select('anthropic.model', c.anthropic.model, MODELS))}
        ${field('Modell für Faktencheck und Review', select('anthropic.reviewModel', c.anthropic.reviewModel, MODELS))}
        <div class="grid2">${saveBtn}${testBtn('claude')}</div></form>`)}

      ${set('video', 'KI-Video', v.mode === 'premium' ? okChip(s.fal, 'Premium', 'fal.ai fehlt') : chip('Sparsam'), `<form data-hold data-section="video">
        ${field('Bildmaterial', select('video.mode', v.mode, [['premium', 'Premium – KI-Videoszenen'], ['sparsam', 'Sparsam – animierte Grafik']]))}
        ${field('fal.ai-Schlüssel', secret('video.falKey', v.falKeySet, v.falKey, 'Key …'), 'fal.ai → Dashboard → API Keys. Ein Schlüssel für viele Videomodelle.')}
        ${field('Videomodell', `<input type="text" name="video.model" list="fal-models" value="${esc(v.model)}"><datalist id="fal-models">${FAL_MODELS.map((m) => `<option value="${m}">`).join('')}</datalist>`, 'Modell-ID von fal.ai')}
        <div class="grid2">${field('Preis pro Sekunde ($)', num('video.pricePerSecond', v.pricePerSecond, 'min="0" step="0.01"'))}${field('Sekunden pro Szene', num('video.clipSeconds', v.clipSeconds, 'min="3" max="10"'))}</div>
        <div class="grid2">${field('Max. Szenen', num('video.maxScenes', v.maxScenes, 'min="4" max="10"'))}${field('Dauer-Angabe', select('video.durationFormat', v.durationFormat, [['s', '„6s“ (Veo)'], ['plain', '„6“ (Kling, Hailuo)']]))}</div>
        ${field('Bildstil', `<textarea name="video.style" rows="3">${esc(v.style)}</textarea>`)}
        ${field('Zusatzwerte (JSON)', `<textarea name="video.extraInput" rows="3" style="font-family:var(--mono);font-size:13px">${esc(v.extraInput)}</textarea>`, 'Werden 1:1 an das Modell geschickt.')}
        <p class="small muted">≈ ${usd(perVideo)} pro Video mit ${v.maxScenes} Szenen.</p>
        <div class="grid2">${saveBtn}${testBtn('fal')}</div></form>`)}

      ${set('voice', 'Stimme', okChip(s.voice), `<form data-hold data-section="voice">
        ${field('Anbieter', select('voice.provider', c.voice.provider, [['elevenlabs', 'ElevenLabs – natürlichste Stimme'], ['openai', 'OpenAI – günstig']]))}
        ${field('ElevenLabs-Schlüssel', secret('voice.elevenKey', c.voice.elevenKeySet, c.voice.elevenKey, 'sk_…'))}
        ${field('ElevenLabs-Stimme', select('voice.voiceId', c.voice.voiceId, voices))}
        <button class="btn small" type="button" data-act="voices">Stimmen laden</button>
        ${field('ElevenLabs-Modell', text('voice.model', c.voice.model))}
        ${field('OpenAI-Schlüssel', secret('voice.openaiKey', c.voice.openaiKeySet, c.voice.openaiKey, 'sk-…'))}
        ${field('OpenAI-Stimme', select('voice.openaiVoice', c.voice.openaiVoice, OPENAI_VOICES.map((x) => [x, x])))}
        <div class="grid2">${saveBtn}${testBtn('voice')}</div></form>`)}

      ${set('trends', 'Trend-Radar', okChip(s.youtubeKey, 'mit YouTube', 'ohne YouTube'), `<form data-hold data-section="trends">
        ${field('YouTube-API-Schlüssel', secret('trends.youtubeKey', c.trends.youtubeKeySet, c.trends.youtubeKey, 'AIza…'), 'Optional, aber empfohlen: zeigt echte Aufrufzahlen. Google Cloud Console → „YouTube Data API v3“ aktivieren → Anmeldedaten → API-Schlüssel.')}
        ${field('Suchbegriffe', text('trends.keywords', c.trends.keywords), 'durch Komma getrennt')}
        ${field('Subreddits', text('trends.subreddits', c.trends.subreddits))}
        ${toggle('trends.hn', c.trends.hn, 'Hacker News')}${toggle('trends.reddit', c.trends.reddit, 'Reddit')}${toggle('trends.webSearch', c.trends.webSearch, 'Claude-Websuche', 'News der letzten 48 Stunden, ca. 5 Cent pro Lauf')}
        ${field('Täglich analysieren um', `<input type="time" name="trends.at" value="${esc(c.trends.at)}">`)}
        <div class="grid2">${saveBtn}${testBtn('youtube', 'YouTube testen')}</div></form>`)}

      ${set('instagram', 'Instagram', okChip(s.instagram, '@' + esc(c.instagram.username || ''), 'nicht verbunden'), `<form data-hold data-section="instagram">
        ${s.instagram ? `<div class="note ok small">Verbunden mit @${esc(c.instagram.username)}. Zugang gültig bis ${esc(when(c.instagram.tokenExpires))}, wird automatisch verlängert.</div>` : ''}
        <p class="small muted">Profikonto nötig (Creator oder Business). Token im Meta-Entwicklerbereich erzeugen – Schritt für Schritt in der Anleitung.</p>
        ${field('Zugangs-Token', '<input type="password" id="ig-token" autocomplete="off" placeholder="IGAA…">')}
        ${field('App-Geheimschlüssel (optional)', '<input type="password" id="ig-secret" autocomplete="off">', 'Nur nötig, wenn dein Token nach einer Stunde abläuft.')}
        <div class="grid2"><button class="btn primary" type="button" data-act="ig-connect">${s.instagram ? 'Neu verbinden' : 'Verbinden'}</button>${testBtn('instagram')}</div>
        ${toggle('instagram.shareToFeed', c.instagram.shareToFeed, 'Reels auch im Feed zeigen')}
        ${saveBtn}</form>`)}

      ${set('yt', 'YouTube Shorts', okChip(s.yt, esc(s.ytChannel || 'verbunden'), s.ytConfigured ? 'nicht verbunden' : 'fehlt'), `<form data-hold data-section="youtube">
        ${s.yt ? `<div class="note ok small">Verbunden mit dem Kanal „${esc(s.ytChannel)}“. Jedes Video geht zusätzlich als Short auf YouTube, mit KI-Kennzeichnung.</div>` : '<p class="small muted">Lädt jedes fertige Video zusätzlich als YouTube Short hoch und holt Aufrufe und Kommentare. Einrichtung in der Anleitung (Google Cloud → OAuth-Client).</p>'}
        ${st.videos.some((v) => v.youtube && (v.youtube.restricted || v.youtube.privacy === 'private')) ? '<div class="note warn small">Google hält Uploads aus neuen API-Projekten privat, bis das Projekt geprüft ist. Antrag: Formular „YouTube API Services – Audit and Quota Extension“. Bis dahin: Studio → Teilen → YouTube-App.</div>' : ''}
        ${toggle('youtube.enabled', c.youtube.enabled, 'Shorts automatisch hochladen')}
        ${field('Sichtbarkeit', select('youtube.privacy', c.youtube.privacy, [['public', 'Öffentlich'], ['unlisted', 'Nicht gelistet'], ['private', 'Privat']]))}
        ${field('OAuth-Client-ID', text('youtube.clientId', c.youtube.clientId, '…apps.googleusercontent.com'))}
        ${field('OAuth-Client-Geheimnis', secret('youtube.clientSecret', c.youtube.clientSecretSet, c.youtube.clientSecret, 'GOCSPX-…'))}
        ${s.ytRedirect ? field('Weiterleitungs-URI für Google', `<input type="text" readonly value="${esc(s.ytRedirect)}">`, '<button class="btn small ghost" type="button" data-act="copy" data-text="' + esc(s.ytRedirect) + '">Kopieren</button> In Google Cloud beim OAuth-Client eintragen.') : ''}
        <div class="grid2">${saveBtn}<button class="btn" type="button" data-act="yt-connect" ${s.ytConfigured ? '' : 'disabled'}>${s.yt ? 'Neu verbinden' : 'Mit YouTube verbinden'}</button></div>
        ${s.yt ? `<div class="grid2">${testBtn('yt')}<button class="btn ghost danger" type="button" data-act="yt-disconnect">Trennen</button></div>` : ''}
        </form>`)}

      ${set('wartung', 'Wartung und Updates', st.maintenance.issues && st.maintenance.issues.length ? chip(st.maintenance.issues.length + ' Ticket' + (st.maintenance.issues.length === 1 ? '' : 's'), 'warn') : chip('alles ok', 'ok'), `<form data-hold data-section="github">
        <p class="small muted">Fehler meldet der Server selbst als Ticket auf GitHub. Claude prüft die Tickets jede Nacht, behebt sie im Code und lädt die Korrektur hoch. Der Server spielt Updates um 03:30 Uhr ein – oder sofort per Knopf.</p>
        <dl class="kv"><dt>Läuft</dt><dd>${st.maintenance.version && st.maintenance.version.sha ? esc(st.maintenance.version.sha) + (st.maintenance.version.date ? ' · ' + esc(st.maintenance.version.date) : '') : 'unbekannt'}</dd>
          <dt>Neueste</dt><dd>${st.maintenance.latest ? `<a href="${esc(st.maintenance.latest.url)}" target="_blank" rel="noopener">${esc(st.maintenance.latest.sha)}</a> · ${esc(st.maintenance.latest.message)} · ${esc(when(st.maintenance.latest.date))}` : 'noch nicht geprüft'}</dd></dl>
        ${st.maintenance.latest && st.maintenance.version && st.maintenance.version.sha && st.maintenance.latest.sha !== st.maintenance.version.sha ? '<div class="note ok small">Neue Version bereit.</div>' : ''}
        <button class="btn" type="button" data-act="update">Update jetzt einspielen</button>
        ${(st.maintenance.issues || []).map((i) => `<a class="small" href="${esc(i.url)}" target="_blank" rel="noopener">#${i.number} ${esc(i.title)}</a>`).join('')}
        ${field('GitHub-Token (für Fehlermeldungen)', secret('github.token', c.github.tokenSet, c.github.token, 'github_pat_…'), 'Fein abgestuftes Token nur für das Repository, Berechtigung „Issues: Lesen und Schreiben“.')}
        ${field('Repository', text('github.repo', c.github.repo))}
        <div class="grid2">${saveBtn}${testBtn('github')}</div></form>`)}

      ${set('kanal', 'Kanal', '', `<form data-hold data-section="kanal">
        ${field('Name', text('channel.name', c.channel.name))}
        ${field('Thema des Kanals', `<textarea name="channel.niche" rows="2">${esc(c.channel.niche)}</textarea>`, 'Steuert, worüber Claude schreibt.')}
        ${field('Sprache der Videos', text('channel.language', c.channel.language))}
        ${saveBtn}</form>`)}

      ${set('server', 'Server und Zugang', '', `<form data-hold data-section="server">
        ${field('Öffentliche Adresse', text('publicUrl', c.publicUrl, 'https://…'), 'Instagram holt die Videos hier ab. Wird beim ersten Aufruf automatisch erkannt.')}
        ${saveBtn}</form>
        <form class="body" data-form="password" style="padding-top:0">
          ${field('Aktuelles Passwort', '<input type="password" name="current" autocomplete="current-password">')}
          ${field('Neues Passwort', '<input type="password" name="next" autocomplete="new-password" minlength="10">')}
          <div class="grid2"><button class="btn" type="submit">Passwort ändern</button><button class="btn ghost danger" type="button" data-act="logout">Abmelden</button></div>
        </form>`)}

      ${set('jobs', 'Automatik', '', `<div class="body">${st.jobs.map((j) => `<div class="row between"><div style="min-width:0;flex:1"><b class="small">${esc(j.label)}</b><div class="small ${j.ok === false ? '' : 'muted'}" style="${j.ok === false ? 'color:var(--bad)' : ''}">${j.lastRun ? esc(j.result) + ' · ' + esc(ago(j.lastRun)) : 'noch nicht gelaufen'}</div></div>
        <button class="btn small ghost" data-act="job" data-name="${esc(j.name)}" ${j.running ? 'disabled' : ''}>${j.running ? spin : 'Jetzt'}</button></div>`).join('')}</div>`)}

      ${set('log', 'Protokoll', '', `<div class="body">
        ${st.notifications.slice(0, 20).map((n) => `<div class="logline"><time>${esc(when(n.at))}</time><span>${esc(n.text)}</span></div>`).join('')}
        <b class="small" style="margin-top:8px">Technik</b>
        ${st.log.slice(0, 60).map((l) => `<div class="logline ${esc(l.level)}"><time>${esc(when(l.at))}</time><span>${esc(l.msg)}</span></div>`).join('')}</div>`)}`;
  }

  const RENDER = { radar: vRadar, studio: vStudio, kanal: vKanal, kommentare: vKommentare, mehr: vMehr };

  // ---------- Anmeldung ----------
  function renderLogin(info = {}) {
    clearInterval(S.timer);
    $('#tabs').hidden = true;
    $('#app').innerHTML = `<div class="login"><form class="card" data-form="login">
      <img src="/icons/icon-192.png" alt="">
      <h1 class="h2">KI-Autopilot</h1>
      ${info.passwordSet === false ? '<p class="note warn small">Auf dem Server ist noch kein Passwort gesetzt.</p>' : '<p class="muted small">Passwort aus der Einrichtung eingeben.</p>'}
      <input type="password" name="password" autocomplete="current-password" placeholder="Passwort" aria-label="Passwort" required>
      <button class="btn primary block" type="submit">Anmelden</button></form></div>`;
    const inp = $('input[name="password"]');
    if (inp) inp.focus();
  }

  // ---------- Formulare ----------
  function setPath(o, p, v) { const parts = p.split('.'); let x = o; for (let i = 0; i < parts.length - 1; i++) x = x[parts[i]] = x[parts[i]] || {}; x[parts[parts.length - 1]] = v; }
  function gather(form) {
    const out = {};
    form.querySelectorAll('[name]').forEach((el) => {
      let val;
      if (el.type === 'checkbox') val = el.checked;
      else if (el.type === 'number') { if (el.value === '') return; val = Number(el.value); }
      else if (el.type === 'password') { if (!el.value.trim()) return; val = el.value.trim(); }
      else if (el.hasAttribute('data-list')) val = el.value.split(',').map((x) => x.trim()).filter(Boolean);
      else val = el.value;
      setPath(out, el.name, val);
      if (el.name === 'voice.voiceId' && el.selectedOptions && el.selectedOptions[0]) setPath(out, 'voice.voiceName', el.selectedOptions[0].textContent.split(' · ')[0]);
    });
    return out;
  }

  async function submit(form) {
    const btn = form.querySelector('button[type="submit"]');
    const kind = form.dataset.form;
    if (kind === 'login') {
      try {
        await api('/api/login', { password: form.password.value });
        await load(true);
        startPolling();
      } catch (e) { toast(e.message, true); }
      return;
    }
    if (kind === 'topic') {
      const r = await run(btn, () => api('/api/topics', { title: form.title.value }), 'Thema angelegt.');
      if (r) form.reset();
      return;
    }
    if (kind === 'password') {
      const r = await run(btn, () => api('/api/password', { current: form.current.value, next: form.next.value }), 'Passwort geändert.');
      if (r) form.reset();
      return;
    }
    const patch = gather(form);
    if (form.dataset.section === 'video' && patch.video && patch.video.extraInput) {
      try { JSON.parse(patch.video.extraInput); } catch { toast('Zusatzwerte sind kein gültiges JSON.', true); return; }
    }
    if (form.dataset.section === 'betrieb' && S.st.cfg.dryRun && patch.dryRun === false) {
      if (!S.st.status.instagram) { toast('Erst Instagram verbinden, dann live schalten.', true); return; }
      if (!(await ask('Live schalten?', `Ab jetzt postet die App wirklich auf ${S.st.cfg.channel.handle || 'Instagram'} und beantwortet Kommentare.`, 'Live schalten'))) return;
    }
    const r = await run(btn, () => api('/api/config', patch), 'Gespeichert.');
    if (r) { S.hold = false; render(true); }
  }

  // ---------- Push und Installation ----------
  const b64ToU8 = (b64) => { const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(s, (c) => c.charCodeAt(0)); };
  async function enablePush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('Dieser Browser kann keine Push-Nachrichten. Bitte Chrome nutzen.');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Benachrichtigungen wurden nicht erlaubt. In den Android-Einstellungen der App freigeben.');
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(S.st.status.pushKey) });
    await api('/api/push/subscribe', sub.toJSON());
  }
  async function shareVideo(v) {
    const res = await fetch(`/media/${v.id}/final.mp4`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('Video nicht abrufbar.');
    const file = new File([await res.blob()], slug(v.title) + '.mp4', { type: 'video/mp4' });
    const textOut = v.script ? v.script.caption : v.title;
    if (navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ files: [file], title: v.title, text: textOut });
    else { const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; a.click(); }
  }

  // ---------- Aktionen ----------
  const ACT = {
    async produce(el) {
      const id = el.closest('[data-topic]').dataset.topic;
      const r = await run(el, () => api(`/api/topics/${id}/produce`), S.st.status.autoPost ? 'Video entsteht. Du bekommst eine Nachricht, wenn es online geht.' : 'Video entsteht.');
      if (r) location.hash = '#studio/' + r.id;
    },
    async revive(el) { const id = el.dataset.topicId; const r = await run(el, () => api(`/api/topics/${id}/produce`), 'Video entsteht.'); if (r) location.hash = '#studio/' + r.id; },
    async 'topic-discard'(el) { await run(el, () => api(`/api/topics/${el.closest('[data-topic]').dataset.topic}/discard`)); },
    async radar(el) { await run(el, () => api('/api/radar/run'), (r) => r.result); },
    async stop(el) { await run(el, () => api(`/api/videos/${vid(el)}/stop`), 'Wird gestoppt.'); },
    async retry(el) { await run(el, () => api(`/api/videos/${vid(el)}/retry`), 'Geht weiter.'); },
    async approve(el) { await run(el, () => api(`/api/videos/${vid(el)}/approve`), 'Freigegeben – geht weiter.'); },
    async discard(el) {
      if (!(await ask('Video verwerfen?', 'Das Video und sein Thema verschwinden aus der Liste.', 'Verwerfen'))) return;
      await run(el, () => api(`/api/videos/${vid(el)}/discard`), 'Verworfen.');
    },
    async 'post-now'(el) {
      const dry = S.st.status.dryRun;
      if (!(await ask('Jetzt posten?', dry ? 'Trockenlauf ist an: es wird nur simuliert.' : 'Das Video geht sofort auf Instagram online.', 'Posten'))) return;
      await run(el, () => api(`/api/videos/${vid(el)}/post-now`), dry ? 'Trockenlauf läuft.' : 'Wird gepostet – dauert ein paar Minuten.');
    },
    async share(el) {
      const v = S.st.videos.find((x) => x.id === vid(el));
      try { await shareVideo(v); } catch (e) { if (e.name !== 'AbortError') toast(e.message, true); }
    },
    async copy(el) { try { await navigator.clipboard.writeText(el.dataset.text); toast('Kopiert.'); } catch { toast('Kopieren ging nicht.', true); } },
    'cmt-tab'(el) { S.cmt = el.dataset.v; render(true); },
    async 'cmt-send'(el) {
      const id = el.closest('[data-cid]').dataset.cid;
      const c = S.st.comments.find((x) => x.id === id);
      const r = await run(el, () => api(`/api/comments/${encodeURIComponent(id)}/reply`, { text: S.cdrafts[id] ?? c.draft }), 'Beantwortet.');
      if (r) delete S.cdrafts[id];
    },
    async 'cmt-ignore'(el) { await run(el, () => api(`/api/comments/${encodeURIComponent(el.closest('[data-cid]').dataset.cid)}/ignore`)); },
    async test(el) { await run(el, () => api(`/api/test/${el.dataset.svc}`), (r) => r.text); },
    async job(el) { await run(el, () => api(`/api/jobs/${el.dataset.name}/run`), (r) => r.result || 'Erledigt.'); },
    async push(el) { await run(el, enablePush, 'Push ist aktiv.'); },
    async install() {
      if (!S.installEvt) return;
      S.installEvt.prompt();
      await S.installEvt.userChoice.catch(() => {});
      S.installEvt = null;
      render(true);
    },
    async voices(el) {
      const r = await run(el, () => api('/api/voices', null, 'GET'), (x) => `${x.voices.length} Stimmen geladen.`);
      if (r) { S.voices = r.voices; S.hold = false; render(true); S.open.add('set-voice'); }
    },
    async 'ig-connect'(el) {
      const r = await run(el, () => api('/api/instagram/connect', { token: $('#ig-token').value, appSecret: $('#ig-secret').value }), (x) => `Verbunden mit @${x.username}.`);
      if (r) { S.hold = false; render(true); }
    },
    async 'yt-connect'(el) {
      const r = await run(el, () => api('/api/youtube/auth-url', null, 'GET'));
      if (r && r.url) location.href = r.url;
    },
    async 'yt-disconnect'(el) {
      if (!(await ask('YouTube trennen?', 'Danach werden keine Shorts mehr hochgeladen.', 'Trennen'))) return;
      await run(el, () => api('/api/youtube/disconnect'), 'YouTube getrennt.');
    },
    async update(el) { await run(el, () => api('/api/update'), 'Update angefordert – der Server startet in den nächsten Minuten kurz neu.'); },
    async logout() { await api('/api/logout').catch(() => {}); renderLogin({}); },
  };
  const vid = (el) => el.closest('[data-video]').dataset.video;

  // ---------- Ereignisse ----------
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const fn = ACT[el.dataset.act];
    if (!fn) return;
    e.preventDefault();
    try { await fn(el); } catch (err) { toast(err.message, true); }
  });
  document.addEventListener('submit', (e) => { e.preventDefault(); submit(e.target); });
  document.addEventListener('input', (e) => {
    const el = e.target;
    if (el.dataset.cdraft) { S.cdrafts[el.dataset.cdraft] = el.value; return; }
    if (el.closest('form[data-hold]')) S.hold = true;
  });
  document.addEventListener('change', (e) => { if (e.target.closest('form[data-hold]')) S.hold = true; });
  document.addEventListener('toggle', (e) => {
    const d = e.target;
    if (!d.dataset || !d.dataset.open) return;
    if (d.open) S.open.add(d.dataset.open); else S.open.delete(d.dataset.open);
    LS.set('kia-open', [...S.open].slice(-40));
  }, true);
  window.addEventListener('hashchange', () => { S.hold = false; render(true); window.scrollTo(0, 0); });
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.installEvt = e; render(true); });
  window.addEventListener('beforeunload', (e) => { if (S.hold) { e.preventDefault(); e.returnValue = ''; } });
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.open) location.href = e.data.open; });
  }

  function startPolling() {
    clearInterval(S.timer);
    S.timer = setInterval(() => { if (!document.hidden) load(false); }, 5000);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.st) load(false); });

  (async () => {
    try {
      const s = await api('/api/session', null, 'GET');
      if (!s.authed) return renderLogin(s);
      await load(true);
      startPolling();
      const yt = document.cookie.match(/(?:^|; )yt=([^;]+)/);
      if (yt) { toast('YouTube verbunden: ' + decodeURIComponent(yt[1])); document.cookie = 'yt=; Max-Age=0; Path=/'; }
    } catch (e) {
      $('#app').innerHTML = `<div class="card empty"><strong>Server nicht erreichbar</strong><p>${esc(e.message)}</p></div>`;
    }
  })();
})();
