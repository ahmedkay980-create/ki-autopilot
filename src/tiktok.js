'use strict';
// TikTok Content Posting API: Anmeldung (Login Kit), Video per Datei-Upload direkt posten oder als Entwurf ins TikTok-Postfach legen.
// Hinweis von TikTok: Solange die App nicht geprüft ist, sind Direkt-Posts nur privat und nur auf privaten Konten möglich.
// Der Entwurfsmodus legt das fertige Video in dein TikTok-Postfach; ein Tipp in der TikTok-App veröffentlicht es.
const fs = require('node:fs');
const { sleep } = require('./util');

const BASE = 'https://open.tiktokapis.com';
const SCOPES = ['user.info.basic', 'video.publish', 'video.upload'];
const MB = 1024 * 1024;

/** Aufteilung laut TikTok Media Transfer Guide: bis 64 MB in einem Stück, sonst 10-MB-Stücke (Rest im letzten). */
function chunkPlan(size) {
  if (size <= 64 * MB) return { chunkSize: size, count: 1 };
  const chunkSize = 10 * MB;
  return { chunkSize, count: Math.floor(size / chunkSize) };
}

class TikTokClient {
  constructor({ getConfig, fetchImpl, clock, sleepImpl, onRefreshToken }) {
    this.getConfig = getConfig;
    this.fetch = fetchImpl || globalThis.fetch;
    this.clock = clock || (() => new Date());
    this.sleep = sleepImpl || sleep;
    this.onRefreshToken = onRefreshToken || (() => {});
    this.cache = null;
  }

  get cfg() { return this.getConfig().tiktok; }
  get configured() { return Boolean(this.cfg.clientKey && this.cfg.clientSecret); }
  get ready() { return Boolean(this.cfg.enabled && this.configured && this.cfg.refreshToken); }
  redirectUri(base) { return `${base}/oauth/tiktok`; }

  authUrl(base, state) {
    const u = new URL('https://www.tiktok.com/v2/auth/authorize/');
    Object.entries({ client_key: this.cfg.clientKey, scope: SCOPES.join(','), response_type: 'code', redirect_uri: this.redirectUri(base), state })
      .forEach(([k, v]) => u.searchParams.set(k, v));
    return u.toString();
  }

  async token(params) {
    const res = await this.fetch(`${BASE}/v2/oauth/token/`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'cache-control': 'no-cache' }, body: new URLSearchParams(params).toString(),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.error) throw new Error('TikTok-Anmeldung: ' + (j.error_description || j.error || res.status));
    return j;
  }

  async exchange(code, base) {
    const j = await this.token({ client_key: this.cfg.clientKey, client_secret: this.cfg.clientSecret, code, grant_type: 'authorization_code', redirect_uri: this.redirectUri(base) });
    this.cache = { token: j.access_token, exp: this.clock().getTime() + (j.expires_in || 86400) * 1000 };
    return j;
  }

  async accessToken() {
    if (this.cache && this.cache.exp - 60e3 > this.clock().getTime()) return this.cache.token;
    if (!this.cfg.refreshToken) throw new Error('TikTok ist nicht verbunden.');
    const j = await this.token({ client_key: this.cfg.clientKey, client_secret: this.cfg.clientSecret, grant_type: 'refresh_token', refresh_token: this.cfg.refreshToken });
    this.cache = { token: j.access_token, exp: this.clock().getTime() + (j.expires_in || 86400) * 1000 };
    if (j.refresh_token && j.refresh_token !== this.cfg.refreshToken) this.onRefreshToken(j.refresh_token);
    return j.access_token;
  }

  async api(path, body, token) {
    const tok = token || await this.accessToken();
    const res = await this.fetch(BASE + path, {
      method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json; charset=UTF-8' }, body: JSON.stringify(body || {}),
    });
    const j = await res.json().catch(() => ({}));
    const err = j.error || {};
    if (!res.ok || (err.code && err.code !== 'ok')) throw new Error(`TikTok: ${err.message || res.status}${err.code && err.code !== 'ok' ? ` (${err.code})` : ''}`);
    return j.data || {};
  }

  async user(token) {
    const tok = token || await this.accessToken();
    const res = await this.fetch(`${BASE}/v2/user/info/?fields=open_id,display_name,username`, { headers: { authorization: `Bearer ${tok}` } });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || (j.error && j.error.code !== 'ok')) throw new Error('TikTok: ' + ((j.error && j.error.message) || res.status));
    const u = (j.data && j.data.user) || {};
    return { openId: u.open_id, name: u.display_name, username: u.username || '' };
  }

  creatorInfo() { return this.api('/v2/post/publish/creator_info/query/', {}); }

  /** Video hochladen. mode 'direkt' = sofort veröffentlichen, 'entwurf' = ins TikTok-Postfach. */
  async upload({ file, caption, mode = 'entwurf', privacy = 'PUBLIC_TO_EVERYONE' }) {
    const size = fs.statSync(file).size;
    const { chunkSize, count } = chunkPlan(size);
    const source = { source: 'FILE_UPLOAD', video_size: size, chunk_size: chunkSize, total_chunk_count: count };
    let level = null;
    let init;
    if (mode === 'direkt') {
      const info = await this.creatorInfo();
      const opts = info.privacy_level_options || [];
      level = opts.includes(privacy) ? privacy : opts.includes('PUBLIC_TO_EVERYONE') ? 'PUBLIC_TO_EVERYONE' : opts[0] || 'SELF_ONLY';
      init = await this.api('/v2/post/publish/video/init/', {
        post_info: {
          title: String(caption || '').slice(0, 2200), privacy_level: level, disable_duet: false, disable_stitch: false, disable_comment: false,
          video_cover_timestamp_ms: 1200, brand_content_toggle: false, brand_organic_toggle: false, is_aigc: true,
        },
        source_info: source,
      });
    } else {
      init = await this.api('/v2/post/publish/inbox/video/init/', { source_info: source });
    }
    if (!init.upload_url || !init.publish_id) throw new Error('TikTok: keine Upload-Adresse erhalten.');
    const buf = fs.readFileSync(file);
    for (let i = 0; i < count; i++) {
      const start = i * chunkSize;
      const end = i === count - 1 ? size - 1 : start + chunkSize - 1;
      const res = await this.fetch(init.upload_url, {
        method: 'PUT', headers: { 'content-type': 'video/mp4', 'content-range': `bytes ${start}-${end}/${size}` }, body: buf.subarray(start, end + 1),
      });
      if (!res.ok) throw new Error(`TikTok-Upload: Teil ${i + 1} von ${count} abgelehnt (${res.status}).`);
    }
    let st = {};
    for (let i = 0; i < 30; i++) {
      await this.sleep(i < 3 ? 3000 : 8000);
      st = await this.api('/v2/post/publish/status/fetch/', { publish_id: init.publish_id });
      if (st.status === 'PUBLISH_COMPLETE' || st.status === 'SEND_TO_USER_INBOX') break;
      if (st.status === 'FAILED') throw new Error('TikTok hat das Video abgelehnt: ' + (st.fail_reason || 'unbekannter Grund'));
    }
    const done = st.status === 'PUBLISH_COMPLETE' || st.status === 'SEND_TO_USER_INBOX';
    if (!done) throw new Error('TikTok verarbeitet das Video noch – bitte später in der TikTok-App nachsehen.');
    const postId = (st.publicaly_available_post_id || st.publicly_available_post_id || [])[0];
    const user = this.cfg.username;
    return {
      publishId: init.publish_id, status: st.status, mode, privacy: level,
      draft: st.status === 'SEND_TO_USER_INBOX',
      url: postId && user ? `https://www.tiktok.com/@${user}/video/${postId}` : null,
    };
  }
}

module.exports = { TikTokClient, chunkPlan, SCOPES };
