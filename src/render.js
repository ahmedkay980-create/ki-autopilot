'use strict';
// Schnitt mit ffmpeg: Szenen auf 1080×1920 bringen, aneinanderhängen, Stimme anlegen, Untertitel Wort für Wort einbrennen.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
const W = 1080;
const H = 1920;

function runTool(bin, args, { cwd, timeoutMs = 20 * 60e3 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`${bin}: Zeitüberschreitung`)); }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    p.on('error', (e) => { clearTimeout(timer); reject(new Error(`${bin} fehlt auf dem Server (${e.message})`)); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${bin} ist fehlgeschlagen: ${err.split('\n').filter(Boolean).slice(-3).join(' | ')}`));
    });
  });
}
const ffmpeg = (args, opts) => runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], opts);

async function duration(file) {
  const out = await runTool('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  const d = parseFloat(out);
  if (!Number.isFinite(d)) throw new Error('Dauer nicht lesbar: ' + path.basename(file));
  return d;
}

async function probe(file) {
  const out = await runTool('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate:format=duration', '-of', 'json', file]);
  return JSON.parse(out);
}

/** Szene auf Zielformat und exakte Länge bringen: zuschneiden, bei Bedarf leicht verlangsamen, notfalls letztes Bild halten. */
async function normalizeScene({ input, seconds, out }) {
  const src = await duration(input);
  const slow = src < seconds ? Math.min(1.35, seconds / src) : 1;
  const vf = [
    `scale=${W}:${H}:force_original_aspect_ratio=increase`, `crop=${W}:${H}`, 'setsar=1',
    slow > 1.001 ? `setpts=${slow.toFixed(4)}*PTS` : null,
    'fps=30', `tpad=stop_mode=clone:stop_duration=${Math.ceil(seconds + 1)}`, `trim=duration=${seconds.toFixed(3)}`, 'setpts=PTS-STARTPTS',
  ].filter(Boolean).join(',');
  await ffmpeg(['-y', '-i', input, '-an', '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30', out]);
  return out;
}

async function concat(files, out) {
  const list = out + '.txt';
  fs.writeFileSync(list, files.map((f) => `file '${path.resolve(f).replace(/'/g, "'\\''")}'`).join('\n'));
  await ffmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', out]);
  fs.unlinkSync(list);
  return out;
}

// ---------- Untertitel (ASS) ----------
const assTime = (t) => {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};
const clean = (s) => String(s || '').replace(/[{}\\]/g, '').replace(/\s+/g, ' ').trim();

/** Wörter zu kurzen Zeilen (max. 3 Wörter / 18 Zeichen, Umbruch nach Satzzeichen). */
function groupWords(words) {
  const groups = [];
  let cur = [];
  for (const w of words) {
    const len = cur.reduce((a, x) => a + x.w.length + 1, 0) + w.w.length;
    if (cur.length && (cur.length >= 3 || len > 18)) { groups.push(cur); cur = []; }
    cur.push(w);
    if (/[.!?;:,]$/.test(w.w)) { groups.push(cur); cur = []; }
  }
  if (cur.length) groups.push(cur);
  return groups;
}

/**
 * ASS-Datei: großer Hook oben in den ersten Sekunden, darunter Untertitel mit hervorgehobenem aktuellem Wort.
 * Farben im ASS-Format &HAABBGGRR.
 */
function buildAss({ words, hook, hookUntil = 2.6, highlight = '&H000AD6FF' }) {
  const lines = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Cap,Inter Black,92,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,7,3,2,70,70,600,1',
    'Style: Hook,Inter Black,80,&H00FFFFFF,&H00FFFFFF,&H00000000,&H99000000,0,0,0,0,100,100,0,0,3,26,0,8,90,90,250,1',
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  if (hook) lines.push(`Dialogue: 2,${assTime(0)},${assTime(hookUntil)},Hook,,0,0,0,,{\\fad(100,220)}${clean(hook).toUpperCase()}`);
  const groups = groupWords(words.filter((w) => clean(w.w)));
  groups.forEach((g, gi) => {
    const next = groups[gi + 1];
    const groupEnd = next && next[0].s - g[g.length - 1].e < 0.7 ? next[0].s : g[g.length - 1].e + 0.25;
    g.forEach((w, wi) => {
      const start = w.s;
      const end = wi + 1 < g.length ? g[wi + 1].s : groupEnd;
      if (end <= start) return;
      const text = g.map((x, xi) => {
        const t = clean(x.w).toUpperCase();
        return xi === wi ? `{\\c${highlight}&\\fscx106\\fscy106}${t}{\\c&H00FFFFFF&\\fscx100\\fscy100}` : t;
      }).join(' ');
      lines.push(`Dialogue: 1,${assTime(start)},${assTime(end)},Cap,,0,0,0,,${text}`);
    });
  });
  return lines.join('\n') + '\n';
}

/** Endmischung: Bild + Untertitel + Stimme (Lautheit normiert), Instagram-taugliches MP4. */
async function finalMux({ dir, visuals, voice, assFile, out, seconds }) {
  const fontsdir = FONT_DIR.replace(/\\/g, '/').replace(/:/g, '\\:');
  await ffmpeg([
    '-y', '-i', visuals, '-i', voice,
    '-filter_complex', `[0:v]ass=${path.basename(assFile)}:fontsdir=${fontsdir}[v];[1:a]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,apad[a]`,
    '-map', '[v]', '-map', '[a]', '-t', seconds.toFixed(3),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-profile:v', 'high', '-level', '4.1', '-pix_fmt', 'yuv420p', '-r', '30',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-movflags', '+faststart', out,
  ], { cwd: dir });
  return out;
}

async function coverFrame(input, out, at = 1.2) {
  await ffmpeg(['-y', '-ss', String(at), '-i', input, '-frames:v', '1', '-vf', 'scale=540:960', '-q:v', '4', out]);
  return out;
}

module.exports = { ffmpeg, duration, probe, normalizeScene, concat, buildAss, groupWords, finalMux, coverFrame, FONT_DIR, assTime };
