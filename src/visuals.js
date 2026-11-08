'use strict';
// Bildmaterial: KI-Videoszenen über fal.ai (Warteschlangen-API) oder animierte Grafik als günstiger Ersatz.
const fs = require('node:fs');
const { sleep } = require('./util');
const { ffmpeg } = require('./render');

function falInput(cfg, prompt) {
  const v = cfg.video;
  let extra = {};
  try { extra = v.extraInput ? JSON.parse(v.extraInput) : {}; } catch { throw new Error('Video-Einstellung „Zusatzwerte“ ist kein gültiges JSON.'); }
  const duration = v.durationFormat === 'plain' ? String(v.clipSeconds) : `${v.clipSeconds}s`;
  return { prompt: `${prompt} ${v.style || ''}`.trim(), aspect_ratio: '9:16', duration, ...extra };
}

async function falJson(fetch, url, key, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { authorization: `Key ${key}`, 'content-type': 'application/json', ...(opts.headers || {}) } });
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); } catch { j = { detail: text.slice(0, 200) }; }
  if (!res.ok) {
    const d = Array.isArray(j.detail) ? j.detail.map((x) => x.msg || JSON.stringify(x)).join('; ') : j.detail || j.error || res.status;
    throw new Error(`fal.ai: ${d}`);
  }
  return j;
}

/** Auftrag in die fal-Warteschlange stellen. */
async function submitClip({ cfg, prompt, fetch }) {
  const v = cfg.video;
  if (!v.falKey) throw new Error('Kein fal.ai-Schlüssel hinterlegt (Einstellungen → Video).');
  const j = await falJson(fetch, `https://queue.fal.run/${v.model}`, v.falKey, { method: 'POST', body: JSON.stringify(falInput(cfg, prompt)) });
  if (!j.request_id) throw new Error('fal.ai: keine Auftragsnummer erhalten.');
  return { requestId: j.request_id, statusUrl: j.status_url, responseUrl: j.response_url };
}

/** Warten bis fertig, dann Video herunterladen. */
async function awaitClip({ cfg, handle, outFile, fetch, sleepImpl = sleep, timeoutMs = 15 * 60e3, shouldStop = () => false }) {
  const key = cfg.video.falKey;
  const started = Date.now();
  for (let i = 0; ; i++) {
    if (shouldStop()) throw new Error('gestoppt');
    const st = await falJson(fetch, handle.statusUrl, key);
    if (st.status === 'COMPLETED') break;
    if (st.status === 'FAILED' || st.error) throw new Error('fal.ai: ' + (st.error || 'Erstellung fehlgeschlagen'));
    if (Date.now() - started > timeoutMs) throw new Error('fal.ai: Zeitüberschreitung nach 15 Minuten');
    await sleepImpl(i < 3 ? 5000 : 10000);
  }
  const result = await falJson(fetch, handle.responseUrl, key);
  const url = (result.video && result.video.url) || (result.videos && result.videos[0] && result.videos[0].url);
  if (!url) throw new Error('fal.ai: Ergebnis enthält kein Video.');
  const res = await fetch(url);
  if (!res.ok) throw new Error('Video-Download fehlgeschlagen: ' + res.status);
  fs.writeFileSync(outFile, Buffer.from(await res.arrayBuffer()));
  return outFile;
}

const PALETTES = [['0x0b1026', '0x3b1d6e'], ['0x061a1f', '0x0f5f63'], ['0x1a0b1f', '0x6b1f4f'], ['0x0d1117', '0x1f3b73'], ['0x14100a', '0x6b4a12']];

/** Ersatzszene ohne KI-Video: animierter Verlauf mit langsamem Licht – kostet nichts. */
async function fallbackClip({ seconds, outFile, index = 0 }) {
  const [c0, c1] = PALETTES[index % PALETTES.length];
  const d = Math.max(1, seconds).toFixed(2);
  await ffmpeg([
    '-y', '-f', 'lavfi', '-i', `gradients=s=1080x1920:c0=${c0}:c1=${c1}:x0=0:y0=0:x1=1080:y1=1920:speed=0.012:d=${d}:r=30`,
    '-filter_complex', `[0:v]noise=alls=6:allf=t,vignette=PI/5[v]`,
    '-map', '[v]', '-t', d, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p', outFile,
  ]);
  return outFile;
}

module.exports = { submitClip, awaitClip, fallbackClip, falInput };
