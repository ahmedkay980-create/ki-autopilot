'use strict';
// Claude-Schnittstelle (Messages API): Kostenzählung, erzwungenes JSON über ein Werkzeug, Websuche mit Quellen.
const { sleep } = require('./util');

// US-$ pro 1 Mio. Token (Eingabe, Ausgabe), Stand November 2026.
const PRICES = {
  'claude-haiku-5-5': [0.10, 0.50],
  'claude-sonnet-5-5': [2, 10],
  'claude-opus-5-5': [4, 20],
  'claude-fable-5-1': [10, 50],
};
const SEARCH_USD = 0.01;

class ClaudeClient {
  constructor({ getConfig, onUsage, fetchImpl, sleepImpl }) {
    this.getConfig = getConfig;
    this.onUsage = onUsage || (() => {});
    this.fetch = fetchImpl || globalThis.fetch;
    this.sleep = sleepImpl || sleep;
  }

  get ready() { return Boolean(this.getConfig().anthropic.apiKey); }

  async messages(body) {
    const cfg = this.getConfig().anthropic;
    if (!cfg.apiKey) throw new Error('Kein Claude-API-Schlüssel hinterlegt (Einstellungen).');
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await this.fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { json = { error: { message: text.slice(0, 300) } }; }
      if (res.ok) {
        this.track(body.model, json.usage);
        return json;
      }
      const raw = (json.error && json.error.message) || res.status;
      lastErr = new Error(res.status === 401 ? 'Claude lehnt den API-Schlüssel ab. Bitte in den Einstellungen prüfen.' : res.status === 400 && /credit|billing/i.test(String(raw)) ? 'Claude: Guthaben aufgebraucht (Claude Console → Billing).' : 'Claude: ' + raw);
      lastErr.status = res.status;
      if (![429, 500, 502, 503, 529].includes(res.status)) throw lastErr;
      await this.sleep(2000 * (attempt + 1) ** 2);
    }
    throw lastErr;
  }

  track(model, usage) {
    if (!usage) return;
    const [pin, pout] = PRICES[model] || PRICES['claude-sonnet-5-5'];
    const inTok = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
    const outTok = usage.output_tokens || 0;
    const searches = (usage.server_tool_use && usage.server_tool_use.web_search_requests) || 0;
    const usd = (inTok / 1e6) * pin + (outTok / 1e6) * pout + searches * SEARCH_USD;
    this.onUsage({ model, inTok, outTok, searches, usd });
  }

  /** Strukturierte Antwort: Claude muss das Werkzeug `name` mit passendem JSON aufrufen. */
  async structured({ system, prompt, name, description, schema, model, maxTokens = 4000 }) {
    const cfg = this.getConfig().anthropic;
    const json = await this.messages({
      model: model || cfg.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: prompt }],
      tools: [{ name, description, input_schema: schema }],
      tool_choice: { type: 'tool', name },
    });
    const block = (json.content || []).find((b) => b.type === 'tool_use' && b.name === name);
    if (!block) throw new Error('Claude hat keine strukturierte Antwort geliefert.');
    return block.input;
  }

  /** Freitext, optional mit Websuche. Liefert Text und alle gefundenen Quellen. */
  async research({ system, prompt, model, maxTokens = 3000, webSearch = true, maxUses = 5 }) {
    const cfg = this.getConfig().anthropic;
    const messages = [{ role: 'user', content: prompt }];
    const body = { model: model || cfg.model, max_tokens: maxTokens, system, messages };
    if (webSearch) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxUses }];
    const content = [];
    for (let turn = 0; turn < 4; turn++) {
      const json = await this.messages(body);
      content.push(...(json.content || []));
      if (json.stop_reason !== 'pause_turn') break;
      messages.push({ role: 'assistant', content: json.content });
    }
    const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    const sources = new Map();
    for (const b of content) {
      if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
        for (const r of b.content) if (r.url) sources.set(r.url, { url: r.url, title: r.title || r.url });
      }
      for (const c of b.citations || []) if (c.url) sources.set(c.url, { url: c.url, title: c.title || c.url });
    }
    return { text, sources: [...sources.values()] };
  }

  async text(opts) {
    return (await this.research({ webSearch: false, ...opts })).text;
  }

  async test() {
    return this.text({ prompt: 'Reply with exactly: ready', maxTokens: 10 });
  }
}

module.exports = { ClaudeClient, PRICES, SEARCH_USD };
