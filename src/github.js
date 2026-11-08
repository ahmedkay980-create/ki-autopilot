'use strict';
// GitHub: Selbstwartung. Der Server meldet Fehler als Ticket, Claude behebt sie im Code, der Server spielt Updates nachts ein.
const crypto = require('node:crypto');

const MARK = 'ki-autopilot-fehler';
const SECRET_RE = /(sk-ant-[\w-]+|sk-[\w-]{20,}|IGAA[\w-]+|EAA[\w-]{20,}|AIza[\w-]{20,}|Key [\w:-]{20,}|ghp_[\w]+|github_pat_[\w]+|xi-api-key[^\s]*|Bearer [\w.-]+)/g;
const scrub = (s) => String(s || '').replace(SECRET_RE, '[entfernt]');
const fingerprint = (where, msg) => crypto.createHash('sha1')
  .update(where + ':' + String(msg).replace(/„[^“]*“/g, '„…“').replace(/"[^"]*"/g, '"…"').replace(/\d+/g, '#')).digest('hex').slice(0, 12);

class GitHubClient {
  constructor({ getConfig, fetchImpl }) {
    this.getConfig = getConfig;
    this.fetch = fetchImpl || globalThis.fetch;
  }
  get cfg() { return this.getConfig().github; }
  get repo() { return this.cfg.repo || 'ahmedkay980-create/ki-autopilot'; }
  get canWrite() { return Boolean(this.cfg.token); }

  async api(method, path, body) {
    const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'ki-autopilot' };
    if (this.cfg.token) headers.authorization = `Bearer ${this.cfg.token}`;
    if (body) headers['content-type'] = 'application/json';
    const res = await this.fetch('https://api.github.com' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`GitHub: ${j.message || res.status}`);
    return j;
  }

  async latestCommit() {
    const [c] = await this.api('GET', `/repos/${this.repo}/commits?per_page=1`);
    return c ? { sha: c.sha.slice(0, 7), message: String(c.commit.message).split('\n')[0], date: c.commit.committer.date, url: c.html_url } : null;
  }

  async openIssues() {
    const list = await this.api('GET', `/repos/${this.repo}/issues?state=open&per_page=30`);
    return list.filter((i) => !i.pull_request && String(i.body || '').includes(MARK))
      .map((i) => ({ number: i.number, title: i.title, url: i.html_url, createdAt: i.created_at, comments: i.comments, body: i.body }));
  }

  /** Fehler melden: gleiches Problem → Kommentar am offenen Ticket statt neuem Ticket. */
  async report({ where, message, details = '', version = '' }) {
    if (!this.canWrite) throw new Error('Kein GitHub-Token hinterlegt.');
    const fp = fingerprint(where, message);
    const open = await this.openIssues();
    const hit = open.find((i) => i.body.includes(`fp:${fp}`));
    if (hit) {
      await this.api('POST', `/repos/${this.repo}/issues/${hit.number}/comments`, { body: scrub(`Erneut aufgetreten (Version ${version || '?'}):\n\n${message}`) });
      return { number: hit.number, url: hit.url, existing: true, fp };
    }
    const body = scrub([
      `**Wo:** ${where}`, `**Fehler:** ${message}`, `**Version:** ${version || 'unbekannt'}`, '',
      details ? '```\n' + details.slice(0, 6000) + '\n```' : '', '',
      'Dieses Ticket hat der Server selbst angelegt. Claude prüft offene Tickets täglich, behebt den Fehler und schließt das Ticket.',
      `<!-- ${MARK} fp:${fp} -->`,
    ].join('\n'));
    const j = await this.api('POST', `/repos/${this.repo}/issues`, { title: scrub(`[Auto] ${where}: ${message}`).slice(0, 140), body });
    return { number: j.number, url: j.html_url, existing: false, fp };
  }
}

module.exports = { GitHubClient, fingerprint, scrub, MARK };
