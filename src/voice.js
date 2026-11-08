'use strict';
// Sprecherstimme mit Wort-Zeitstempeln (für Untertitel und Szenenschnitt).
// ElevenLabs liefert die Zeiten direkt; bei OpenAI werden sie per Whisper nachträglich bestimmt.
const fs = require('node:fs');

/** Zeichen-Zeitstempel (ElevenLabs) → Wörter mit Start/Ende in Sekunden. */
function wordsFromAlignment(al) {
  const words = [];
  if (!al || !Array.isArray(al.characters)) return words;
  let cur = null;
  al.characters.forEach((ch, i) => {
    const s = al.character_start_times_seconds[i];
    const e = al.character_end_times_seconds[i];
    if (/\s/.test(ch)) { if (cur) { words.push(cur); cur = null; } return; }
    if (!cur) cur = { w: '', s, e };
    cur.w += ch;
    cur.e = e;
  });
  if (cur) words.push(cur);
  return words;
}

async function elevenlabs({ cfg, text, outFile, fetch }) {
  const v = cfg.voice;
  if (!v.elevenKey) throw new Error('Kein ElevenLabs-Schlüssel hinterlegt (Einstellungen → Stimme).');
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(v.voiceId)}/with-timestamps?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': v.elevenKey, 'content-type': 'application/json' },
    body: JSON.stringify({ text, model_id: v.model, voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.25, use_speaker_boost: true } }),
  });
  const body = await res.text();
  let j;
  try { j = JSON.parse(body); } catch { throw new Error('ElevenLabs: unerwartete Antwort ' + res.status); }
  if (!res.ok) throw new Error('ElevenLabs: ' + ((j.detail && (j.detail.message || j.detail)) || res.status));
  fs.writeFileSync(outFile, Buffer.from(j.audio_base64, 'base64'));
  const words = wordsFromAlignment(j.alignment || j.normalized_alignment);
  return { words, chars: text.length, costUsd: 0 }; // Abo-Kontingent, keine Einzelkosten
}

async function openai({ cfg, text, outFile, fetch }) {
  const v = cfg.voice;
  if (!v.openaiKey) throw new Error('Kein OpenAI-Schlüssel hinterlegt (Einstellungen → Stimme).');
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { authorization: `Bearer ${v.openaiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: v.openaiModel, voice: v.openaiVoice, input: text, response_format: 'mp3', instructions: 'Energetic, clear tech explainer narrator. Natural pace, confident, slightly warm.' }),
  });
  if (!res.ok) throw new Error('OpenAI-Stimme: ' + (await res.text()).slice(0, 200));
  const audio = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outFile, audio);

  const form = new FormData();
  form.set('file', new Blob([audio], { type: 'audio/mpeg' }), 'voice.mp3');
  form.set('model', 'whisper-1');
  form.set('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  const tr = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { authorization: `Bearer ${v.openaiKey}` }, body: form });
  const tj = await tr.json().catch(() => ({}));
  if (!tr.ok) throw new Error('OpenAI-Zeitstempel: ' + ((tj.error && tj.error.message) || tr.status));
  const words = (tj.words || []).map((w) => ({ w: w.word, s: w.start, e: w.end }));
  const minutes = (tj.duration || words.length / 2.5) / 60;
  return { words, chars: text.length, costUsd: minutes * (0.015 + 0.006) };
}

async function synthesize(opts) {
  return opts.cfg.voice.provider === 'openai' ? openai(opts) : elevenlabs(opts);
}

async function listVoices({ cfg, fetch }) {
  if (!cfg.voice.elevenKey) throw new Error('Kein ElevenLabs-Schlüssel hinterlegt.');
  const res = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': cfg.voice.elevenKey } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('ElevenLabs: ' + ((j.detail && (j.detail.message || j.detail)) || res.status));
  return (j.voices || []).map((v) => ({ id: v.voice_id, name: v.name, labels: v.labels || {}, preview: v.preview_url || '' }));
}

/**
 * Szenengrenzen aus den Wortzeiten: Szene i beginnt beim ersten Wort ihres Sprechtexts.
 * Die Wörter werden der Reihe nach verteilt (Anzahl je Szene), robust gegen kleine Abweichungen.
 */
function sceneTimes(narrations, words, totalS) {
  const counts = narrations.map((t) => String(t).trim().split(/\s+/).filter(Boolean).length);
  const sum = counts.reduce((a, b) => a + b, 0) || 1;
  const scale = words.length / sum;
  const starts = [];
  let acc = 0;
  for (let i = 0; i < counts.length; i++) {
    if (i === 0) starts.push(0);
    else if (words.length) starts.push(words[Math.min(words.length - 1, Math.round(acc * scale))].s);
    else starts.push((acc / sum) * totalS);
    acc += counts[i];
  }
  const out = starts.map((s, i) => ({ start: s, end: i + 1 < starts.length ? starts[i + 1] : totalS }));
  // Mindestlänge 1,2 s je Szene sicherstellen
  for (let i = 0; i < out.length; i++) {
    if (out[i].end - out[i].start < 1.2 && i + 1 < out.length) { out[i].end = out[i].start + 1.2; out[i + 1].start = out[i].end; }
  }
  return out.map((x) => ({ ...x, durationS: Math.max(0.5, x.end - x.start) }));
}

module.exports = { synthesize, listVoices, wordsFromAlignment, sceneTimes };
