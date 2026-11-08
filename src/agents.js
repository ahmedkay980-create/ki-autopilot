'use strict';
// Die Redaktion: Themen aus Signalen, Recherche, Skript, Faktencheck, Kommentar-Antworten, Wochen-Review.

const FORMATS = {
  news60: 'AI News in 60s – what happened, why it matters, what comes next',
  explainer: 'Explainer – how something works, with one strong analogy',
  tool: 'Useful AI – one tool or use case and what it means for the viewer',
  myth: 'Myth vs. fact – a common belief, then the surprising truth',
  list: 'Top 3 – three quick, concrete items with a payoff at the end',
  future: 'What this means for you – job, money, daily life, grounded in facts',
};
const FORMAT_KEYS = Object.keys(FORMATS);

function channelSystem(cfg, learnings) {
  const c = cfg.channel;
  return `You are the head writer of "${c.name}", a faceless short-video channel: ${c.niche}.
All spoken and on-screen content is in ${c.language}.
Audience: curious non-experts aged 18–40 who want to understand what is happening in AI and tech and how it affects them.
Voice: confident, clear, a little witty. Never hype, never clickbait you cannot back up. Short sentences. Concrete numbers. Explain jargon in five words.
Every video: a hook in the first two seconds (surprising fact, bold but true claim, or sharp question), exactly one idea, a payoff, and a last line that invites a comment.

Honesty rules – non-negotiable:
- State only facts from the provided fact sheet. Never invent numbers, quotes, dates, benchmarks or product features.
- Company claims are attributed ("OpenAI says …"). Rumors are called rumors.
- No financial, medical or legal advice.
- Visual prompts go to an AI video generator: symbolic, cinematic scenes. Never real identifiable people, real company logos, real product interfaces, screenshots or readable text. No violence, no sexual content.
${learnings ? '\nWhat worked on this channel so far (use it):\n' + learnings : ''}`;
}

// ---------- Schemas ----------
const TOPICS_SCHEMA = {
  type: 'object',
  properties: {
    topics: {
      type: 'array', minItems: 3, maxItems: 10,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Video title in the channel language, max 70 characters, specific and curiosity-driven' },
          hook: { type: 'string', description: 'Spoken first sentence in the channel language, max 14 words' },
          angle: { type: 'string', description: 'GERMAN: our specific angle in one sentence' },
          whyNow: { type: 'string', description: 'GERMAN: why this works right now, citing a number from the signals' },
          format: { type: 'string', enum: FORMAT_KEYS },
          demand: { type: 'integer', minimum: 0, maximum: 100, description: 'Expected audience demand from the signals' },
          competition: { type: 'string', enum: ['niedrig', 'mittel', 'hoch'] },
          evergreen: { type: 'boolean' },
          signals: { type: 'array', items: { type: 'integer' }, description: 'Indices of the supporting signals' },
        },
        required: ['title', 'hook', 'angle', 'whyNow', 'format', 'demand', 'competition', 'evergreen', 'signals'],
      },
    },
  },
  required: ['topics'],
};

function scriptSchema(maxScenes) {
  return {
    type: 'object',
    properties: {
      title: { type: 'string' },
      hook: { type: 'string', description: 'On-screen hook text for the first 2.5 seconds, max 6 words, no emojis' },
      format: { type: 'string', enum: FORMAT_KEYS },
      scenes: {
        type: 'array', minItems: 4, maxItems: maxScenes,
        items: {
          type: 'object',
          properties: {
            narration: { type: 'string', description: 'Spoken text for this scene, 1–3 short sentences. Write numbers the way they should be spoken.' },
            visual: { type: 'string', description: 'Prompt for the AI video generator: one continuous cinematic shot, symbolic, no text, no real people or logos' },
          },
          required: ['narration', 'visual'],
        },
      },
      caption: { type: 'string', description: 'Instagram caption: 2–4 short lines, value first, ends with a question to the viewer. No hashtags here.' },
      hashtags: { type: 'array', items: { type: 'string' }, minItems: 4, maxItems: 8 },
      claims: { type: 'array', items: { type: 'string' }, description: 'Every factual claim made in the narration, one per item' },
      sources: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, url: { type: 'string' } }, required: ['title', 'url'] } },
      why: { type: 'string', description: 'GERMAN: one sentence why this script should perform' },
    },
    required: ['title', 'hook', 'format', 'scenes', 'caption', 'hashtags', 'claims', 'sources', 'why'],
  };
}

const FACTCHECK_SCHEMA = {
  type: 'object',
  properties: {
    pass: { type: 'boolean', description: 'true if no serious problem remains after your fixes' },
    summary: { type: 'string', description: 'GERMAN: one or two sentences' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          scene: { type: 'integer', description: 'Scene index (0-based), -1 for caption' },
          claim: { type: 'string' },
          problem: { type: 'string', description: 'GERMAN' },
          severity: { type: 'string', enum: ['hoch', 'mittel', 'niedrig'] },
          fixedNarration: { type: 'string', description: 'Full corrected narration for that scene, or empty if no safe fix exists' },
        },
        required: ['scene', 'claim', 'problem', 'severity', 'fixedNarration'],
      },
    },
  },
  required: ['pass', 'summary', 'issues'],
};

const COMMENT_SCHEMA = {
  type: 'object',
  properties: {
    replies: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          category: { type: 'string', enum: ['frage', 'lob', 'kritik', 'fehlerhinweis', 'spam', 'sonstiges'] },
          reply: { type: 'string', description: 'Reply in the language of the comment, 1–2 sentences, friendly, no emojis spam. Empty for spam.' },
          videoIdea: { type: 'string', description: 'If the comment asks something worth its own video: the video title, else empty' },
        },
        required: ['id', 'category', 'reply', 'videoIdea'],
      },
    },
  },
  required: ['replies'],
};

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'GERMAN, 2–3 sentences' },
    learnings: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 4, description: 'GERMAN, concrete' },
    doMore: { type: 'array', items: { type: 'string' }, description: 'ENGLISH, short rules for the writer' },
    doLess: { type: 'array', items: { type: 'string' }, description: 'ENGLISH, short rules for the writer' },
  },
  required: ['summary', 'learnings', 'doMore', 'doLess'],
};

class Agents {
  constructor({ claude, getConfig, getLearnings }) {
    this.claude = claude;
    this.getConfig = getConfig;
    this.getLearnings = getLearnings || (() => '');
  }
  get cfg() { return this.getConfig(); }
  get live() { return this.claude.ready; }
  system() { return channelSystem(this.cfg, this.getLearnings()); }

  /** Signale → Themenvorschläge. Ohne Claude: die stärksten Signale direkt. */
  async topicsFromSignals({ signals, recentTitles = [], formatStats = {} }) {
    const list = signals.slice(0, 60);
    if (!this.live) return fallbackTopics(list);
    const lines = list.map((s, i) => `[${i}] (${s.source}, Hitze ${s.heat}, ${s.label}) ${s.title}`).join('\n');
    const perf = Object.entries(formatStats).map(([f, v]) => `${f}: Score ${v.score?.toFixed(2) ?? '–'} aus ${v.count} Videos`).join('; ');
    const out = await this.claude.structured({
      system: this.system(),
      prompt: `Signals from the last days (heat 0–100 = how fast it is growing within its source):\n${lines}\n\n` +
        (recentTitles.length ? `Already covered recently – do not repeat:\n- ${recentTitles.join('\n- ')}\n\n` : '') +
        (perf ? `Format performance on this channel: ${perf}\n\n` : '') +
        `Formats: ${FORMAT_KEYS.map((k) => `${k} = ${FORMATS[k]}`).join('; ')}.\n\n` +
        'Pick 8 video topics with the highest potential for this channel. Merge signals about the same story. Prefer stories regular people care about over niche developer news. ' +
        'Mix formats. At least one evergreen topic. Rank by demand.',
      name: 'propose_topics', description: 'Ranked video topics', schema: TOPICS_SCHEMA, maxTokens: 3500,
    });
    return (out.topics || []).map((t) => ({ ...t, evidence: (t.signals || []).map((i) => list[i]).filter(Boolean).slice(0, 4) }));
  }

  async research(topic) {
    const date = new Date().toISOString().slice(0, 10);
    const ev = (topic.evidence || []).map((e) => `- ${e.title} (${e.url})`).join('\n');
    return this.claude.research({
      system: 'You are a meticulous tech research assistant. You verify facts with primary sources when possible.',
      prompt: `Today is ${date}. Topic: ${topic.title}\nAngle: ${topic.angle || ''}\n${ev ? 'Signals:\n' + ev + '\n' : ''}\n` +
        'Research this topic with web search. Write a compact fact sheet in English: 8–15 bullet points. Each bullet is one concrete fact (numbers, dates, product and company names) followed by its source URL in parentheses. ' +
        'Mark anything unconfirmed as (claim) or (rumor). End with one line starting with "Best angle:".',
      webSearch: this.cfg.trends.webSearch !== false, maxTokens: 3000, maxUses: 6,
    });
  }

  async writeScript({ topic, research, maxScenes }) {
    const out = await this.claude.structured({
      system: this.system(),
      prompt: `Topic: ${topic.title}\nPlanned hook: ${topic.hook || ''}\nFormat: ${topic.format} = ${FORMATS[topic.format] || ''}\nAngle (German note from the producer): ${topic.angle || ''}\n\n` +
        `FACT SHEET (the only allowed source of facts):\n${research.text}\n\n` +
        `Write the video script. ${4}–${maxScenes} scenes, 110–150 spoken words in total (about 45–55 seconds). Scene 1 is the hook. ` +
        `Each visual prompt describes one continuous ${this.cfg.video.clipSeconds}-second cinematic shot that symbolizes the narration. ` +
        'List every factual claim in "claims" and the URLs you relied on in "sources" (only URLs from the fact sheet).',
      name: 'write_script', description: 'Short-form video script', schema: scriptSchema(maxScenes), maxTokens: 4000,
    });
    out.hashtags = (out.hashtags || []).map((h) => String(h).replace(/^#+/, '').replace(/\s+/g, '')).filter(Boolean);
    return out;
  }

  async factCheck({ script, research }) {
    const scenes = script.scenes.map((s, i) => `[${i}] ${s.narration}`).join('\n');
    return this.claude.structured({
      system: 'You are a strict fact checker for a tech news channel. You compare a script against its fact sheet. You are not creative; you are precise.',
      prompt: `FACT SHEET:\n${research.text}\n\nSCRIPT SCENES:\n${scenes}\n\nCAPTION:\n${script.caption}\n\n` +
        'Check every factual statement. A statement fails if it is not supported by the fact sheet, overstates it, presents a claim or rumor as fact, or has a wrong number or date. ' +
        'For each problem give a corrected narration for that scene that stays supported (keep length and tone). severity hoch = factually wrong or invented, mittel = overstated, niedrig = style. ' +
        'pass is true when no hoch problem would remain after applying your fixes.',
      name: 'fact_check', description: 'Fact check result', schema: FACTCHECK_SCHEMA, model: this.cfg.anthropic.reviewModel, maxTokens: 3000,
    });
  }

  async classifyComments(items) {
    if (!this.live) return items.map(ruleComment);
    const out = await this.claude.structured({
      system: this.system(),
      prompt: 'Classify these Instagram comments on our videos and draft a reply for each (as the channel). Video title in brackets.\n' +
        items.map((c) => `id=${c.id} [${c.videoTitle}] @${c.username}: ${c.text}`).join('\n'),
      name: 'triage_comments', description: 'Comment triage', schema: COMMENT_SCHEMA, maxTokens: 3000,
    });
    const map = new Map((out.replies || []).map((r) => [String(r.id), r]));
    return items.map((c) => map.get(String(c.id)) || ruleComment(c));
  }

  async weeklyReview(data) {
    if (!this.live) return ruleReview(data);
    return this.claude.structured({
      system: this.system(),
      prompt: `Performance of our last videos (score 1.0 = target; retention = average watch time / length):\n${JSON.stringify(data, null, 1)}\n\n` +
        'Write the weekly review. What do the winners have in common (topic type, format, hook)? What should the writer do more and less of?',
      name: 'weekly_review', description: 'Weekly review', schema: REVIEW_SCHEMA, model: this.cfg.anthropic.reviewModel, maxTokens: 2000,
    });
  }
}

function fallbackTopics(signals) {
  return signals.slice(0, 8).map((s) => ({
    title: s.title.slice(0, 90), hook: '', angle: 'Automatisch aus dem stärksten Signal übernommen (ohne Claude).',
    whyNow: s.label, format: 'news60', demand: s.heat, competition: 'mittel', evergreen: false, evidence: [s],
  }));
}

function ruleComment(c) {
  const t = String(c.text || '').toLowerCase();
  let category = 'sonstiges';
  if (/https?:|follow me|check my|dm me|crypto|giveaway/.test(t)) category = 'spam';
  else if (/\?/.test(t)) category = 'frage';
  else if (/wrong|false|not true|fake|incorrect|falsch/.test(t)) category = 'fehlerhinweis';
  else if (/love|great|awesome|amazing|thanks|thank you|cool|nice|fire|🔥|❤|😍|👏/.test(t)) category = 'lob';
  const reply = { lob: 'Thanks a lot! More coming this week.', frage: '', kritik: '', fehlerhinweis: '', spam: '', sonstiges: '' }[category];
  return { id: c.id, category, reply, videoIdea: '' };
}

function ruleReview(data) {
  const vids = data.videos || [];
  const best = vids.slice().sort((a, b) => (b.score || 0) - (a.score || 0))[0];
  return {
    summary: vids.length ? `${vids.length} Videos ausgewertet. Bestes Video: „${best.title}“.` : 'Noch keine Daten.',
    learnings: best ? [`Das stärkste Format war ${best.format}.`] : ['Noch zu wenig Daten.'],
    doMore: best ? [`More ${best.format} videos like "${best.title}".`] : [],
    doLess: [],
  };
}

module.exports = { Agents, FORMATS, FORMAT_KEYS, TOPICS_SCHEMA, FACTCHECK_SCHEMA, scriptSchema, ruleComment, fallbackTopics };
