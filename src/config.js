'use strict';
// Einstellungen mit Standardwerten. Geheimnisse werden nach außen nur maskiert gezeigt.

const DEFAULT_CONFIG = {
  version: 1,
  channel: {
    name: 'AI Autopilot',
    handle: '',
    niche: 'AI news, tools and ideas explained simply for curious people',
    language: 'English',
    audienceTz: 'America/New_York',
  },
  autopilot: true, // Zeitplaner an
  dryRun: true, // nichts wird wirklich gepostet
  autoPost: true, // fertige Videos automatisch posten
  postTiming: 'slot', // 'slot' = nächster Sendeplatz, 'sofort'
  slots: ['12:00', '19:00'], // Wanduhrzeit der Zielgruppe
  autoProduce: { enabled: false, at: '08:00' }, // Vollautomatik: täglich das Top-Thema produzieren
  budget: { monthlyUsd: 60 },
  commentMode: 'auto-lob', // 'entwurf' | 'auto-lob' (Dank auf Lob automatisch) | 'auto-alle'
  quality: { factCheck: true, blockOnFail: true },
  anthropic: { apiKey: '', model: 'claude-sonnet-5-5', reviewModel: 'claude-opus-5-5' },
  video: {
    mode: 'premium', // 'premium' = KI-Videoszenen, 'sparsam' = animierte Grafik
    falKey: '',
    model: 'fal-ai/veo3/fast',
    pricePerSecond: 0.10,
    clipSeconds: 6,
    durationFormat: 's', // 's' → "6s", 'plain' → "6"
    maxScenes: 7,
    extraInput: '{"generate_audio": false, "resolution": "720p", "negative_prompt": "text, subtitles, letters, watermark, logo, brand names, real celebrities, distorted hands"}',
    style: 'Cinematic vertical shot, rich detail, moody futuristic lighting, shallow depth of field, smooth slow camera movement, no text on screen.',
  },
  voice: {
    provider: 'elevenlabs', // 'elevenlabs' | 'openai'
    elevenKey: '',
    voiceId: 'JBFqnCBsd6RMkjVDRZzb',
    voiceName: 'George',
    model: 'eleven_multilingual_v2',
    openaiKey: '',
    openaiVoice: 'onyx',
    openaiModel: 'gpt-4o-mini-tts',
  },
  trends: {
    at: '07:00',
    youtubeKey: '',
    keywords: 'AI, ChatGPT, OpenAI, Claude AI, Gemini AI, AI agents, AI tools, humanoid robot',
    subreddits: 'artificial+singularity+OpenAI+LocalLLaMA+ChatGPT+technology',
    hn: true,
    reddit: true,
    webSearch: true,
  },
  instagram: { token: '', appSecret: '', tokenRefreshed: null, tokenExpires: null, userId: '', username: '', apiVersion: 'v27.0', shareToFeed: true },
  youtube: { enabled: true, clientId: '', clientSecret: '', refreshToken: '', channelId: '', channelTitle: '', privacy: 'public' },
  github: { repo: 'ahmedkay980-create/ki-autopilot', token: '' },
  publicUrl: '',
  push: { publicKey: '', privateKey: '', subject: 'mailto:autopilot@example.com' },
  auth: { passwordHash: '' },
};

const SECRET_PATHS = [
  'anthropic.apiKey', 'video.falKey', 'voice.elevenKey', 'voice.openaiKey', 'trends.youtubeKey',
  'instagram.token', 'instagram.appSecret', 'push.privateKey', 'auth.passwordHash',
  'youtube.clientSecret', 'youtube.refreshToken', 'github.token',
];

const get = (obj, p) => p.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
function set(obj, p, v) {
  const parts = p.split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]] = o[parts[i]] || {};
  o[parts[parts.length - 1]] = v;
}
const isPlain = (v) => v && typeof v === 'object' && !Array.isArray(v);

function deepMerge(base, over) {
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over || {})) {
    if (isPlain(v) && isPlain(out[k])) out[k] = deepMerge(out[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

const withDefaults = (cfg) => deepMerge(DEFAULT_CONFIG, cfg || {});

/** Für die Oberfläche: Geheimnisse durch ••••1234 ersetzen und xxxSet setzen. */
function maskConfig(cfg) {
  const out = structuredClone(cfg);
  for (const p of SECRET_PATHS) {
    const v = get(cfg, p);
    set(out, p, v ? '••••' + String(v).slice(-4) : '');
    set(out, p + 'Set', Boolean(v));
  }
  out.auth = { passwordSet: Boolean(cfg.auth.passwordHash) };
  return out;
}

/** Änderungen aus der Oberfläche übernehmen. Leere oder maskierte Geheimnisse bleiben unverändert. */
function mergeConfig(cfg, patch) {
  const clean = structuredClone(patch || {});
  delete clean.auth;
  delete clean.push;
  for (const p of SECRET_PATHS) {
    const v = get(clean, p);
    if (v === undefined) continue;
    if (v === '' || String(v).startsWith('••••')) {
      const parts = p.split('.');
      const parent = get(clean, parts.slice(0, -1).join('.'));
      if (parent) delete parent[parts[parts.length - 1]];
    }
  }
  for (const p of SECRET_PATHS) {
    const parts = p.split('.');
    const parent = get(clean, parts.slice(0, -1).join('.'));
    if (parent) delete parent[parts[parts.length - 1] + 'Set'];
  }
  return deepMerge(cfg, clean);
}

const DEFAULT_DB = {
  version: 1,
  topics: [],
  videos: [],
  comments: [],
  reports: [],
  followers: [],
  notifications: [],
  jobs: {},
  costs: {},
  pushSubs: [],
  sessions: {},
  radar: { lastRun: null, signals: 0, sources: {}, errors: [] },
  learnings: '',
  maintenance: { checkedAt: null, latest: null, issues: [], error: null },
  reported: {},
  oauthState: null,
  log: [],
};

module.exports = { DEFAULT_CONFIG, DEFAULT_DB, SECRET_PATHS, withDefaults, maskConfig, mergeConfig, deepMerge, get, set };
