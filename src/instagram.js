'use strict';
// Instagram API mit Instagram-Login (graph.instagram.com). Keine Facebook-Seite nötig.
// Reels werden per video_url veröffentlicht: Instagram holt das fertige Video selbst vom Server ab.
const { sleep } = require('./util');

const REEL_METRICS = ['views', 'reach', 'likes', 'comments', 'shares', 'saved', 'total_interactions', 'ig_reels_avg_watch_time', 'ig_reels_video_view_total_time'];
const CORE_METRICS = ['reach', 'likes', 'comments', 'shares', 'saved'];

class InstagramClient {
  constructor({ getConfig, fetchImpl, log, sleepImpl }) {
    this.getConfig = getConfig;
    this.fetch = fetchImpl || globalThis.fetch;
    this.log = log || (() => {});
    this.sleep = sleepImpl || sleep;
  }

  get cfg() { return this.getConfig().instagram; }
  get ready() { return Boolean(this.cfg.token && this.cfg.userId); }
  base() { return `https://graph.instagram.com/${this.cfg.apiVersion || 'v27.0'}`; }

  async call(method, path, params = {}, { token, raw } = {}) {
    const access = token || this.cfg.token;
    if (!access) throw new Error('Instagram ist nicht verbunden (Einstellungen).');
    const url = new URL(raw ? path : this.base() + path);
    const opts = { method, headers: {} };
    const all = { ...params, access_token: access };
    if (method === 'GET') {
      for (const [k, v] of Object.entries(all)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    } else {
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries(all)) if (v !== undefined && v !== null) form.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
      opts.headers['content-type'] = 'application/x-www-form-urlencoded';
      opts.body = form.toString();
    }
    const res = await this.fetch(url.toString(), opts);
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { error: { message: text.slice(0, 200) } }; }
    if (!res.ok || json.error) {
      const e = json.error || {};
      const err = new Error(`Instagram: ${e.error_user_msg || e.message || res.status}${e.code ? ` (Code ${e.code}${e.error_subcode ? '/' + e.error_subcode : ''})` : ''}`);
      err.code = e.code;
      err.status = res.status;
      throw err;
    }
    return json;
  }

  /** Konto zum Token: Profi-Konto-ID und Name. */
  async me(token) {
    const j = await this.call('GET', '/me', { fields: 'user_id,username,account_type,followers_count,media_count' }, { token });
    return { userId: String(j.user_id || j.id), username: j.username, accountType: j.account_type, followers: j.followers_count, mediaCount: j.media_count };
  }

  /** Kurzlebiges Token (1 Std.) gegen ein 60-Tage-Token tauschen. Braucht den App-Geheimschlüssel. */
  async exchange(shortToken, appSecret) {
    return this.call('GET', 'https://graph.instagram.com/access_token', { grant_type: 'ig_exchange_token', client_secret: appSecret }, { token: shortToken, raw: true });
  }

  /** 60-Tage-Token verlängern (geht ab 24 Std. nach Ausstellung). */
  async refresh() {
    return this.call('GET', 'https://graph.instagram.com/refresh_access_token', { grant_type: 'ig_refresh_token' }, { raw: true });
  }

  async publishingLimit() {
    const j = await this.call('GET', `/${this.cfg.userId}/content_publishing_limit`, { fields: 'quota_usage,config' });
    return (j.data && j.data[0]) || null;
  }

  /**
   * Reel veröffentlichen. Ablauf laut Meta: Container mit video_url anlegen → Status abfragen bis FINISHED
   * (Meta empfiehlt etwa einmal pro Minute) → media_publish.
   */
  async publishReel({ videoUrl, caption, shareToFeed = true, thumbOffsetMs, onStep = () => {} }) {
    const uid = this.cfg.userId;
    const container = await this.call('POST', `/${uid}/media`, {
      media_type: 'REELS', video_url: videoUrl, caption, share_to_feed: shareToFeed ? 'true' : 'false',
      thumb_offset: thumbOffsetMs != null ? Math.round(thumbOffsetMs) : undefined,
    });
    onStep('Container angelegt: ' + container.id);
    let status = 'IN_PROGRESS';
    for (let i = 0; i < 20; i++) {
      await this.sleep(i === 0 ? 20e3 : 45e3);
      const s = await this.call('GET', `/${container.id}`, { fields: 'status_code,status' });
      status = s.status_code;
      if (status === 'FINISHED') break;
      if (status === 'ERROR' || status === 'EXPIRED') throw new Error(`Instagram verarbeitet das Video nicht (${s.status || status}).`);
    }
    if (status !== 'FINISHED') throw new Error('Instagram hat das Video nach 15 Minuten noch nicht verarbeitet.');
    onStep('Von Instagram verarbeitet');
    const pub = await this.call('POST', `/${uid}/media_publish`, { creation_id: container.id });
    let info = {};
    try { info = await this.call('GET', `/${pub.id}`, { fields: 'permalink,timestamp' }); } catch { /* egal */ }
    return { mediaId: pub.id, permalink: info.permalink || null, timestamp: info.timestamp || null };
  }

  async insights(mediaId) {
    const read = (j) => {
      const out = {};
      for (const m of j.data || []) out[m.name] = m.values ? (m.values[0] || {}).value : m.total_value ? m.total_value.value : null;
      return out;
    };
    try {
      return read(await this.call('GET', `/${mediaId}/insights`, { metric: REEL_METRICS.join(',') }));
    } catch (e) {
      this.log('warn', 'Insights (voll) fehlgeschlagen, versuche Grundwerte: ' + e.message);
      return read(await this.call('GET', `/${mediaId}/insights`, { metric: CORE_METRICS.join(',') }));
    }
  }

  async comments(mediaId) {
    const j = await this.call('GET', `/${mediaId}/comments`, { fields: 'id,text,username,timestamp,like_count', limit: 50 });
    return j.data || [];
  }

  async reply(commentId, message) {
    return this.call('POST', `/${commentId}/replies`, { message });
  }
}

module.exports = { InstagramClient, REEL_METRICS };
