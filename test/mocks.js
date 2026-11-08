'use strict';
// Simulierte Antworten von Claude, ElevenLabs und fal.ai für die Tests.
const assert = require('node:assert/strict');

const SCRIPT = {
  title: 'This AI model now thinks for minutes',
  hook: 'AI that thinks for minutes',
  format: 'news60',
  scenes: [
    { narration: 'OpenAI just released a model that can think for minutes.', visual: 'A glowing brain made of light pulses in a dark server room' },
    { narration: 'The company says it solves harder math problems.', visual: 'Floating equations dissolve into particles' },
    { narration: 'That matters because slower thinking means fewer mistakes.', visual: 'An hourglass with digital sand' },
    { narration: 'Would you wait a minute for a better answer?', visual: 'A person silhouette waiting at a neon window' },
  ],
  caption: 'Slower AI, smarter answers?\nWould you wait?',
  hashtags: ['#AI', 'openai', 'tech news'],
  claims: ['OpenAI released a model that can think for minutes'],
  sources: [{ title: 'OpenAI', url: 'https://openai.com/news/thinking' }],
  why: 'Klare Neuigkeit mit Alltagsbezug.',
};

function claudeRoute({ factPass = true } = {}) {
  const seen = [];
  const handler = (u, o) => {
    const body = JSON.parse(o.body);
    seen.push(body);
    const usage = { input_tokens: 1000, output_tokens: 500 };
    if (body.tools && body.tools[0].type === 'web_search_20250305') {
      if (/most talked-about/.test(body.messages[0].content)) {
        return { content: [{ type: 'text', text: '[{"title":"OpenAI ships a slow-thinking model","summary":"s","url":"https://openai.com/news/thinking","buzz":"everywhere"}]' }], usage: { ...usage, server_tool_use: { web_search_requests: 2 } }, stop_reason: 'end_turn' };
      }
      return {
        content: [
          { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://openai.com/news/thinking', title: 'OpenAI news' }] },
          { type: 'text', text: '- OpenAI released a model that can think for minutes (https://openai.com/news/thinking)\nBest angle: patience pays.' },
        ],
        usage: { ...usage, server_tool_use: { web_search_requests: 3 } }, stop_reason: 'end_turn',
      };
    }
    const name = body.tool_choice && body.tool_choice.name;
    const input = {
      propose_topics: { topics: [{ title: 'This AI model now thinks for minutes', hook: 'AI now thinks for minutes', angle: 'Warum langsamer besser ist', whyNow: 'Top auf Hacker News', format: 'news60', demand: 88, competition: 'mittel', evergreen: false, signals: [0] }] },
      write_script: SCRIPT,
      fact_check: factPass
        ? { pass: true, summary: 'Passt, eine Stelle entschärft.', issues: [{ scene: 1, claim: 'solves harder math', problem: 'Firmenangabe', severity: 'mittel', fixedNarration: 'OpenAI says it handles harder math problems.' }] }
        : { pass: false, summary: 'Eine Zahl ist erfunden.', issues: [{ scene: 2, claim: 'fewer mistakes', problem: 'Nicht belegt', severity: 'hoch', fixedNarration: '' }] },
      triage_comments: { replies: [] },
    }[name];
    return { content: [{ type: 'tool_use', name, input }], usage, stop_reason: 'tool_use' };
  };
  return { route: ['POST', /api\.anthropic\.com\/v1\/messages$/, handler], seen };
}

function elevenRoute(mp3) {
  return ['POST', /api\.elevenlabs\.io\/v1\/text-to-speech\/.+\/with-timestamps/, (u, o) => {
    const { text } = JSON.parse(o.body);
    const chars = [...text];
    const step = 5.5 / chars.length;
    return {
      audio_base64: mp3.toString('base64'),
      alignment: { characters: chars, character_start_times_seconds: chars.map((_, i) => i * step), character_end_times_seconds: chars.map((_, i) => (i + 1) * step) },
    };
  }];
}

function falRoutes(mp4) {
  let n = 0;
  return [
    ['POST', /queue\.fal\.run\/fal-ai\/veo3\/fast$/, (u, o) => {
      const b = JSON.parse(o.body);
      assert.equal(b.aspect_ratio, '9:16');
      assert.equal(b.duration, '6s');
      assert.equal(b.generate_audio, false);
      n++;
      return { request_id: 'r' + n, status_url: `https://queue.fal.run/fal-ai/veo3/requests/r${n}/status`, response_url: `https://queue.fal.run/fal-ai/veo3/requests/r${n}` };
    }],
    ['GET', /queue\.fal\.run\/fal-ai\/veo3\/requests\/r\d+\/status$/, () => ({ status: 'COMPLETED' })],
    ['GET', /queue\.fal\.run\/fal-ai\/veo3\/requests\/r\d+$/, (u) => ({ video: { url: `https://v3.fal.media/files/${u.split('/').pop()}.mp4` } })],
    ['GET', /fal\.media\/files\//, () => mp4],
  ];
}

module.exports = { SCRIPT, claudeRoute, elevenRoute, falRoutes };
