'use strict';
// YouTube: Anmeldung per Google-OAuth, Shorts hochladen (fortsetzbarer Upload), Zahlen und Kommentare.
// Hinweis von Google: Uploads aus ungeprüften API-Projekten bleiben privat, bis das Projekt die YouTube-API-Prüfung bestanden hat.
const fs = require('node:fs');

const SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.force-ssl'];
const API = 'https://www.googleapis.com/youtube/v3';

class YouTubeClient {
  constructor({ getConfig, fetchImpl, clock }) {
    this.getConfig = getConfig;
    this.fetch = fetchImpl || globalThis.fetch;
    this.clock = clock || (() => new Date());
    this.cache = null;
  }

  get cfg() { return this.getConfig().youtube; }
  get configured() { return Boolean(this.cfg.clientId && this.cfg.clientSecret); }
  get ready() { return Boolean(this.cfg.enabled && this.configured && this.cfg.refreshToken); }
  redirectUri(base) { return `${base}/oauth/youtube`; }

  authUrl(base, state) {
    const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    Object.entries({
      client_id: this.cfg.clientId, redirect_uri: this.redirectUri(base), response_type: 'code', scope: SCOPES.join(' '),
      access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
    }).forEach(([k, v]) => u.searchParams.set(k, v));
    return u.toString();
  }

  async token(params) {
    const res = await this.fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString(),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error('YouTube-Anmeldung: ' + (j.error_description || j.error || res.status));
    return j;
  }

  async exchange(code, base) {
    const j = await this.token({ code, client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, redirect_uri: this.redirectUri(base), grant_type: 'authorization_code' });
    if (!j.refresh_token) throw new Error('Google hat keinen dauerhaften Zugang geliefert. Bitte erneut verbinden.');
    this.cache = { token: j.access_token, exp: this.clock().getTime() + (j.expires_in || 3600) * 1000 };
    return j;
  }

  async accessToken() {
    if (this.cache && this.cache.exp - 60e3 > this.clock().getTime()) return this.cache.token;
    if (!this.cfg.refreshToken) throw new Error('YouTube ist nicht verbunden.');
    const j = await this.token({ refresh_token: this.cfg.refreshToken, client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, grant_type: 'refresh_token' });
    this.cache = { token: j.access_token, exp: this.clock().getTime() + (j.expires_in || 3600) * 1000 };
    return j.access_token;
  }

  async api(method, url, { body, token } = {}) {
    const tok = token || await this.accessToken();
    const res = await this.fetch(url, {
      method, headers: { authorization: `Bearer ${tok}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = j.error || {};
      const reason = e.errors && e.errors[0] && e.errors[0].reason;
      throw new Error(`YouTube: ${e.message || res.status}${reason ? ` (${reason})` : ''}`);
    }
    return j;
  }

  async channel(token) {
    const j = await this.api('GET', `${API}/channels?part=snippet,statistics&mine=true`, { token });
    const c = (j.items || [])[0];
    if (!c) throw new Error('Zu diesem Google-Konto gibt es keinen YouTube-Kanal.');
    return { id: c.id, title: c.snippet.title, subscribers: Number((c.statistics || {}).subscriberCount || 0) };
  }

  /** Short hochladen: erst Metadaten (liefert Upload-Adresse), dann die Videodatei. */
  async upload({ file, title, description, tags = [], privacy = 'public' }) {
    const tok = await this.accessToken();
    const size = fs.statSync(file).size;
    const meta = {
      snippet: { title: String(title).slice(0, 100), description: String(description).slice(0, 4900), tags: tags.slice(0, 15), categoryId: '28', defaultLanguage: 'en', defaultAudioLanguage: 'en' },
      status: { privacyStatus: privacy, selfDeclaredMadeForKids: false, containsSyntheticMedia: true },
    };
    const init = await this.fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-length': String(size), 'x-upload-content-type': 'video/mp4' },
      body: JSON.stringify(meta),
    });
    if (!init.ok) {
      const j = await init.json().catch(() => ({}));
      const e = j.error || {};
      throw new Error(`YouTube-Upload: ${e.message || init.status}${e.errors && e.errors[0] ? ` (${e.errors[0].reason})` : ''}`);
    }
    const loc = init.headers.get('location');
    if (!loc) throw new Error('YouTube-Upload: keine Upload-Adresse erhalten.');
    const put = await this.fetch(loc, { method: 'PUT', headers: { 'content-type': 'video/mp4' }, body: fs.readFileSync(file) });
    const j = await put.json().catch(() => ({}));
    if (!put.ok || !j.id) throw new Error('YouTube-Upload: ' + ((j.error && j.error.message) || put.status));
    const got = (j.status && j.status.privacyStatus) || privacy;
    return { id: j.id, url: `https://www.youtube.com/shorts/${j.id}`, privacy: got, restricted: privacy === 'public' && got !== 'public' };
  }

  async stats(ids) {
    if (!ids.length) return {};
    const j = await this.api('GET', `${API}/videos?part=statistics,status&id=${ids.slice(0, 50).join(',')}`);
    const out = {};
    for (const v of j.items || []) {
      const s = v.statistics || {};
      out[v.id] = { views: Number(s.viewCount || 0), likes: Number(s.likeCount || 0), comments: Number(s.commentCount || 0), privacy: v.status && v.status.privacyStatus };
    }
    return out;
  }

  async comments(videoId) {
    const j = await this.api('GET', `${API}/commentThreads?part=snippet&videoId=${encodeURIComponent(videoId)}&maxResults=50&order=time&textFormat=plainText`);
    return (j.items || []).map((t) => {
      const c = t.snippet.topLevelComment;
      return { id: c.id, text: c.snippet.textOriginal || c.snippet.textDisplay || '', username: c.snippet.authorDisplayName || '', timestamp: c.snippet.publishedAt, authorChannelId: (c.snippet.authorChannelId || {}).value };
    });
  }

  async reply(parentId, text) {
    return this.api('POST', `${API}/comments?part=snippet`, { body: { snippet: { parentId, textOriginal: text } } });
  }
}

module.exports = { YouTubeClient, SCOPES };
