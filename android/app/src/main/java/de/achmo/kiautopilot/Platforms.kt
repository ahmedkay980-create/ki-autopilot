package de.achmo.kiautopilot

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** Instagram API mit Instagram-Login. Reels per video_url: Instagram holt das Video selbst ab. */
class Instagram(private val e: Engine) {
    private val c: JSONObject get() = e.cfg("instagram")
    val ready: Boolean get() = c.s("token").isNotEmpty() && c.s("userId").isNotEmpty()

    private fun base(): String {
        val v = c.s("apiVersion")
        return if (v.isEmpty()) "https://graph.instagram.com" else "https://graph.instagram.com/$v"
    }

    fun call(method: String, path: String, params: Map<String, String> = emptyMap(), token: String? = null, raw: Boolean = false, retries: Int = 2): JSONObject {
        val access = token ?: c.s("token")
        if (access.isEmpty()) throw UserError("Instagram ist nicht verbunden (Mehr → Plattformen).")
        val all = params + ("access_token" to access)
        val url = if (raw) path else base() + path
        val r = if (method == "GET") {
            Http.request("GET", url + "?" + Http.query(all), retries = retries)
        } else {
            Http.request(method, url, mapOf("Content-Type" to "application/x-www-form-urlencoded"), Http.query(all).toByteArray(), retries = retries)
        }
        val j = r.json()
        val err = j.optJSONObject("error")
        if (!r.ok || err != null) {
            val m = err?.s("error_user_msg")?.ifEmpty { null } ?: err?.s("message")?.ifEmpty { null } ?: r.code.toString()
            val code = err?.optInt("code") ?: 0
            val hint = if (code == 190) " – Token abgelaufen, bitte unter Mehr → Plattformen neu einfügen" else ""
            throw UserError("Instagram: $m" + (if (code != 0) " (Code $code)" else "") + hint)
        }
        return j
    }

    fun me(token: String? = null): JSONObject =
        call("GET", "/me", mapOf("fields" to "user_id,username,account_type,followers_count,media_count"), token)

    fun refresh(): JSONObject =
        call("GET", "https://graph.instagram.com/refresh_access_token", mapOf("grant_type" to "ig_refresh_token"), raw = true)

    /** Container anlegen → warten bis FINISHED → veröffentlichen. */
    fun publishReel(videoUrl: String, caption: String, onStep: (String) -> Unit): JSONObject {
        val uid = c.s("userId")
        val container = call(
            "POST", "/$uid/media",
            mapOf("media_type" to "REELS", "video_url" to videoUrl, "caption" to caption, "share_to_feed" to "true"),
            retries = 0,
        )
        val cid = container.s("id")
        onStep("Container angelegt")
        var status = "IN_PROGRESS"
        for (i in 0 until 30) {
            Thread.sleep(if (i == 0) 15_000L else 30_000L)
            val s = call("GET", "/$cid", mapOf("fields" to "status_code,status"))
            status = s.s("status_code")
            if (status == "FINISHED") break
            if (status == "ERROR" || status == "EXPIRED") throw UserError("Instagram verarbeitet das Video nicht (" + s.s("status", status) + ").")
        }
        if (status != "FINISHED") throw UserError("Instagram hat das Video nach 15 Minuten noch nicht verarbeitet.")
        onStep("Von Instagram verarbeitet")
        val pub = call("POST", "/$uid/media_publish", mapOf("creation_id" to cid), retries = 0)
        val info = try {
            call("GET", "/" + pub.s("id"), mapOf("fields" to "permalink"))
        } catch (ex: Exception) {
            JSONObject()
        }
        return JSONObject().put("id", pub.s("id")).put("url", info.s("permalink"))
    }
}

/** YouTube: Google-OAuth über die Weiterleitungsseite, Shorts per fortsetzbarem Upload. */
class YouTube(private val e: Engine) {
    companion object {
        const val SCOPES = "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly"
    }

    private val c: JSONObject get() = e.cfg("youtube")
    val configured: Boolean get() = c.s("clientId").isNotEmpty() && c.s("clientSecret").isNotEmpty()
    val ready: Boolean get() = configured && c.s("refreshToken").isNotEmpty()

    @Volatile private var cache: Pair<String, Long>? = null

    fun authUrl(state: String): String = "https://accounts.google.com/o/oauth2/v2/auth?" + Http.query(
        mapOf(
            "client_id" to c.s("clientId"), "redirect_uri" to Defaults.REDIRECT, "response_type" to "code",
            "scope" to SCOPES, "access_type" to "offline", "prompt" to "consent", "include_granted_scopes" to "true", "state" to state,
        ),
    )

    private fun token(params: Map<String, String>): JSONObject {
        val r = Http.request("POST", "https://oauth2.googleapis.com/token", mapOf("Content-Type" to "application/x-www-form-urlencoded"), Http.query(params).toByteArray())
        val j = r.json()
        if (!r.ok) {
            val err = j.s("error")
            if (err == "invalid_grant") {
                throw UserError("YouTube-Zugang abgelaufen. Bitte unter Mehr → Plattformen neu verbinden (und in der Google Cloud die App auf „In Produktion“ stellen, sonst läuft er nach 7 Tagen ab).")
            }
            throw UserError("YouTube-Anmeldung: " + j.s("error_description").ifEmpty { err.ifEmpty { r.code.toString() } })
        }
        return j
    }

    fun exchange(code: String): JSONObject {
        val j = token(
            mapOf(
                "code" to code, "client_id" to c.s("clientId"), "client_secret" to c.s("clientSecret"),
                "redirect_uri" to Defaults.REDIRECT, "grant_type" to "authorization_code",
            ),
        )
        if (j.s("refresh_token").isEmpty()) throw UserError("Google hat keinen dauerhaften Zugang geliefert. Bitte erneut verbinden.")
        cache = j.s("access_token") to (System.currentTimeMillis() + j.optLong("expires_in", 3600) * 1000)
        return j
    }

    fun accessToken(): String {
        val ch = cache
        if (ch != null && ch.second - 60_000 > System.currentTimeMillis()) return ch.first
        if (c.s("refreshToken").isEmpty()) throw UserError("YouTube ist nicht verbunden (Mehr → Plattformen).")
        val j = token(
            mapOf(
                "refresh_token" to c.s("refreshToken"), "client_id" to c.s("clientId"),
                "client_secret" to c.s("clientSecret"), "grant_type" to "refresh_token",
            ),
        )
        cache = j.s("access_token") to (System.currentTimeMillis() + j.optLong("expires_in", 3600) * 1000)
        return j.s("access_token")
    }

    fun forget() {
        cache = null
    }

    private fun error(prefix: String, r: HttpResponse): UserError {
        val err = r.json().optJSONObject("error")
        val reason = err?.optJSONArray("errors")?.optJSONObject(0)?.s("reason") ?: ""
        val m = err?.s("message")?.ifEmpty { null } ?: r.code.toString()
        val hint = when (reason) {
            "quotaExceeded" -> " – Tageskontingent der YouTube-API aufgebraucht, morgen geht es wieder"
            "uploadLimitExceeded" -> " – YouTube-Upload-Limit für heute erreicht"
            else -> ""
        }
        return UserError("$prefix: $m" + (if (reason.isNotEmpty()) " ($reason)" else "") + hint)
    }

    fun channel(): JSONObject {
        val r = Http.request("GET", "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", mapOf("Authorization" to "Bearer " + accessToken()))
        if (!r.ok) throw error("YouTube", r)
        val item = r.json().optJSONArray("items")?.optJSONObject(0) ?: throw UserError("Zu diesem Google-Konto gibt es keinen YouTube-Kanal.")
        return JSONObject().put("id", item.s("id")).put("title", item.optJSONObject("snippet")?.s("title") ?: "")
    }

    fun upload(file: File, title: String, description: String, tags: List<String>, privacy: String): JSONObject {
        val tok = accessToken()
        val meta = JSONObject()
            .put(
                "snippet",
                JSONObject().put("title", title.take(100)).put("description", description.take(4900))
                    .put("tags", JSONArray(tags.take(15))).put("categoryId", "28")
                    .put("defaultLanguage", "en").put("defaultAudioLanguage", "en"),
            )
            .put("status", JSONObject().put("privacyStatus", privacy).put("selfDeclaredMadeForKids", false).put("containsSyntheticMedia", true))
        val init = Http.request(
            "POST", "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
            mapOf(
                "Authorization" to "Bearer $tok", "Content-Type" to "application/json; charset=UTF-8",
                "X-Upload-Content-Length" to file.length().toString(), "X-Upload-Content-Type" to "video/mp4",
            ),
            meta.toString().toByteArray(), retries = 1,
        )
        if (!init.ok) throw error("YouTube-Upload", init)
        val loc = init.header("Location") ?: throw UserError("YouTube-Upload: keine Upload-Adresse erhalten.")
        val put = Http.request("PUT", loc, mapOf("Content-Type" to "video/mp4"), file = file, timeoutMs = 600_000, retries = 0)
        val j = put.json()
        if (!put.ok || j.s("id").isEmpty()) throw error("YouTube-Upload", put)
        val got = j.optJSONObject("status")?.s("privacyStatus")?.ifEmpty { null } ?: privacy
        val res = JSONObject().put("id", j.s("id")).put("url", "https://www.youtube.com/shorts/" + j.s("id")).put("privacy", got)
        if (privacy == "public" && got != "public") res.put("note", "YouTube hat es auf „$got“ gesetzt – Uploads aus ungeprüften API-Projekten bleiben privat, bis Google das Projekt geprüft hat.")
        return res
    }
}

/** TikTok Content Posting API: Datei-Upload direkt posten oder als Entwurf ins TikTok-Postfach. */
class TikTok(private val e: Engine) {
    companion object {
        const val BASE = "https://open.tiktokapis.com"
        const val SCOPES = "user.info.basic,video.publish,video.upload"
        const val MB = 1024L * 1024L
    }

    private val c: JSONObject get() = e.cfg("tiktok")
    val configured: Boolean get() = c.s("clientKey").isNotEmpty() && c.s("clientSecret").isNotEmpty()
    val ready: Boolean get() = configured && c.s("refreshToken").isNotEmpty()

    @Volatile private var cache: Pair<String, Long>? = null

    fun authUrl(state: String): String = "https://www.tiktok.com/v2/auth/authorize/?" + Http.query(
        mapOf("client_key" to c.s("clientKey"), "scope" to SCOPES, "response_type" to "code", "redirect_uri" to Defaults.REDIRECT, "state" to state),
    )

    private fun token(params: Map<String, String>): JSONObject {
        val r = Http.request(
            "POST", "$BASE/v2/oauth/token/",
            mapOf("Content-Type" to "application/x-www-form-urlencoded", "Cache-Control" to "no-cache"),
            Http.query(params).toByteArray(),
        )
        val j = r.json()
        val err = if (j.opt("error") is String) j.s("error") else ""
        if (!r.ok || err.isNotEmpty() || j.s("access_token").isEmpty()) {
            throw UserError("TikTok-Anmeldung: " + j.s("error_description").ifEmpty { err.ifEmpty { r.code.toString() } })
        }
        return j
    }

    fun exchange(code: String): JSONObject {
        val j = token(
            mapOf(
                "client_key" to c.s("clientKey"), "client_secret" to c.s("clientSecret"), "code" to code,
                "grant_type" to "authorization_code", "redirect_uri" to Defaults.REDIRECT,
            ),
        )
        cache = j.s("access_token") to (System.currentTimeMillis() + j.optLong("expires_in", 86_400) * 1000)
        return j
    }

    fun accessToken(): String {
        val ch = cache
        if (ch != null && ch.second - 60_000 > System.currentTimeMillis()) return ch.first
        if (c.s("refreshToken").isEmpty()) throw UserError("TikTok ist nicht verbunden (Mehr → Plattformen).")
        val j = token(
            mapOf(
                "client_key" to c.s("clientKey"), "client_secret" to c.s("clientSecret"),
                "grant_type" to "refresh_token", "refresh_token" to c.s("refreshToken"),
            ),
        )
        cache = j.s("access_token") to (System.currentTimeMillis() + j.optLong("expires_in", 86_400) * 1000)
        val rt = j.s("refresh_token")
        if (rt.isNotEmpty() && rt != c.s("refreshToken")) e.store.edit { c.put("refreshToken", rt) }
        return j.s("access_token")
    }

    fun forget() {
        cache = null
    }

    private fun api(path: String, body: JSONObject): JSONObject {
        val r = Http.request(
            "POST", BASE + path,
            mapOf("Authorization" to "Bearer " + accessToken(), "Content-Type" to "application/json; charset=UTF-8"),
            body.toString().toByteArray(), retries = 1,
        )
        val j = r.json()
        val err = j.optJSONObject("error")
        val code = err?.s("code") ?: ""
        if (!r.ok || (code.isNotEmpty() && code != "ok")) {
            val m = err?.s("message")?.ifEmpty { null } ?: r.code.toString()
            throw UserError("TikTok: $m" + if (code.isNotEmpty() && code != "ok") " ($code)" else "")
        }
        return j.optJSONObject("data") ?: JSONObject()
    }

    fun user(): JSONObject {
        val r = Http.request("GET", "$BASE/v2/user/info/?fields=open_id,display_name,username", mapOf("Authorization" to "Bearer " + accessToken()))
        val j = r.json()
        val code = j.optJSONObject("error")?.s("code") ?: ""
        if (!r.ok || (code.isNotEmpty() && code != "ok")) throw UserError("TikTok: " + (j.optJSONObject("error")?.s("message") ?: r.code.toString()))
        return j.optJSONObject("data")?.optJSONObject("user") ?: JSONObject()
    }

    /** mode "direkt" = sofort veröffentlichen, "entwurf" = ins TikTok-Postfach (ein Tipp in TikTok veröffentlicht). */
    fun upload(file: File, caption: String, mode: String, privacy: String): JSONObject {
        val size = file.length()
        val chunk = if (size <= 64 * MB) size else 10 * MB
        val count = if (size <= 64 * MB) 1 else (size / chunk).toInt()
        val source = JSONObject().put("source", "FILE_UPLOAD").put("video_size", size).put("chunk_size", chunk).put("total_chunk_count", count)
        var level = ""
        val init = if (mode == "direkt") {
            val opts = api("/v2/post/publish/creator_info/query/", JSONObject()).optJSONArray("privacy_level_options")?.strings() ?: emptyList()
            level = when {
                privacy in opts -> privacy
                "PUBLIC_TO_EVERYONE" in opts -> "PUBLIC_TO_EVERYONE"
                opts.isNotEmpty() -> opts[0]
                else -> "SELF_ONLY"
            }
            api(
                "/v2/post/publish/video/init/",
                JSONObject().put(
                    "post_info",
                    JSONObject().put("title", caption.take(2200)).put("privacy_level", level)
                        .put("disable_duet", false).put("disable_stitch", false).put("disable_comment", false)
                        .put("video_cover_timestamp_ms", 1200).put("brand_content_toggle", false)
                        .put("brand_organic_toggle", false).put("is_aigc", true),
                ).put("source_info", source),
            )
        } else {
            api("/v2/post/publish/inbox/video/init/", JSONObject().put("source_info", source))
        }
        val uploadUrl = init.s("upload_url")
        val publishId = init.s("publish_id")
        if (uploadUrl.isEmpty() || publishId.isEmpty()) throw UserError("TikTok: keine Upload-Adresse erhalten.")
        for (i in 0 until count) {
            val start = i * chunk
            val end = if (i == count - 1) size - 1 else start + chunk - 1
            val r = Http.request(
                "PUT", uploadUrl,
                mapOf("Content-Type" to "video/mp4", "Content-Range" to "bytes $start-$end/$size"),
                file = file, offset = start, length = end - start + 1, timeoutMs = 600_000, retries = 1,
            )
            if (!r.ok) throw UserError("TikTok-Upload: Teil ${i + 1} von $count abgelehnt (${r.code}).")
        }
        var st = JSONObject()
        for (i in 0 until 40) {
            Thread.sleep(if (i < 3) 3000L else 8000L)
            st = api("/v2/post/publish/status/fetch/", JSONObject().put("publish_id", publishId))
            val s = st.s("status")
            if (s == "PUBLISH_COMPLETE" || s == "SEND_TO_USER_INBOX") break
            if (s == "FAILED") throw UserError("TikTok hat das Video abgelehnt: " + st.s("fail_reason", "unbekannter Grund"))
        }
        val s = st.s("status")
        if (s != "PUBLISH_COMPLETE" && s != "SEND_TO_USER_INBOX") throw UserError("TikTok verarbeitet das Video noch – bitte später in der TikTok-App nachsehen.")
        val ids = st.optJSONArray("publicaly_available_post_id") ?: st.optJSONArray("publicly_available_post_id")
        val postId = ids?.opt(0)?.toString() ?: ""
        val user = c.s("username")
        val res = JSONObject().put("publishId", publishId).put("privacy", level)
        if (postId.isNotEmpty() && user.isNotEmpty()) res.put("url", "https://www.tiktok.com/@$user/video/$postId")
        when {
            s == "SEND_TO_USER_INBOX" -> res.put("note", "Liegt in deinem TikTok-Postfach – in TikTok antippen und veröffentlichen.")
            level == "SELF_ONLY" -> res.put("note", "Nur privat sichtbar – TikTok erlaubt öffentliche Direkt-Posts erst nach der App-Prüfung.")
        }
        return res
    }
}
