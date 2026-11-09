package de.achmo.kiautopilot

import org.json.JSONObject
import java.io.File

object Defaults {
    const val REPO = "ahmedkay980-create/ki-autopilot"
    const val PAGES = "https://ahmedkay980-create.github.io/ki-autopilot"
    const val REDIRECT = "$PAGES/oauth.html"

    /** Felder, die nie im Klartext an die Oberfläche gehen. */
    val SECRETS = listOf(
        "anthropic.apiKey", "voice.elevenKey", "voice.openaiKey", "video.falKey", "trends.youtubeKey",
        "instagram.token", "youtube.clientSecret", "youtube.refreshToken", "tiktok.clientSecret",
        "tiktok.refreshToken", "github.token",
    )

    fun config(): JSONObject = JSONObject(
        """
        {
          "channel": {"name": "AI Autopilot", "niche": "AI and tech news, explained simply for everyone", "language": "English"},
          "anthropic": {"apiKey": "", "model": "claude-sonnet-5-5", "reviewModel": "claude-opus-5-5"},
          "voice": {"provider": "elevenlabs", "elevenKey": "", "voiceId": "JBFqnCBsd6RMkjVDRZzb", "model": "eleven_multilingual_v2",
                    "openaiKey": "", "openaiVoice": "onyx", "openaiModel": "gpt-4o-mini-tts"},
          "video": {"falKey": "", "model": "fal-ai/veo3.1/fast", "pricePerSecond": 0.10, "resolution": "720p", "maxScenes": 7,
                    "style": "Cinematic vertical shot, rich detail, moody futuristic lighting, shallow depth of field, smooth slow camera movement, no text on screen.",
                    "negative": "text, subtitles, letters, watermark, logo, brand names, real celebrities, distorted hands"},
          "captions": {"enabled": true, "font": "Montserrat", "fontSize": 80, "color": "white", "highlight": "yellow", "position": "center", "yOffset": 220, "words": 2},
          "trends": {"youtubeKey": "", "hn": true, "reddit": true, "webSearch": true, "maxAgeHours": 3,
                     "keywords": "AI, ChatGPT, OpenAI, Claude AI, Gemini AI, AI agents, AI tools, humanoid robot",
                     "subreddits": "artificial+singularity+OpenAI+LocalLLaMA+ChatGPT+technology"},
          "instagram": {"token": "", "userId": "", "username": "", "apiVersion": "", "tokenRefreshed": ""},
          "youtube": {"clientId": "", "clientSecret": "", "refreshToken": "", "channelTitle": "", "privacy": "public"},
          "tiktok": {"clientKey": "", "clientSecret": "", "refreshToken": "", "openId": "", "username": "", "mode": "entwurf", "privacy": "PUBLIC_TO_EVERYONE"},
          "github": {"token": "", "autoReport": true},
          "budget": {"monthlyUsd": 60},
          "autopilot": {"radarHours": 24, "dailyVideo": false, "dailyTime": "17:00", "autoPost": false},
          "quality": {"factCheck": true, "blockOnFail": true}
        }
        """.trimIndent(),
    )
}

/** Alle Daten der App in einer JSON-Datei. Zugriffe laufen über [lock]. */
class Store(private val file: File) {
    val lock = Any()
    val db: JSONObject = load()

    private fun load(): JSONObject {
        val j = try {
            if (file.exists()) JSONObject(file.readText()) else JSONObject()
        } catch (e: Exception) {
            JSONObject()
        }
        merge(Defaults.config(), j.obj("config"))
        listOf("topics", "videos", "log").forEach { j.arr(it) }
        j.obj("costs")
        j.obj("radar")
        return j
    }

    fun save() {
        synchronized(lock) {
            val text = db.toString()
            val tmp = File(file.parentFile, file.name + ".tmp")
            tmp.writeText(text)
            if (!tmp.renameTo(file)) file.writeText(text)
        }
    }

    fun <T> edit(block: () -> T): T = synchronized(lock) {
        val r = block()
        save()
        r
    }

    fun <T> read(block: () -> T): T = synchronized(lock) { block() }

    companion object {
        /** Fehlende Standardwerte ergänzen, vorhandene behalten. */
        fun merge(def: JSONObject, target: JSONObject) {
            val keys = def.keys()
            while (keys.hasNext()) {
                val k = keys.next()
                val dv = def.get(k)
                val tv = target.opt(k)
                if (tv == null) target.put(k, dv)
                else if (dv is JSONObject && tv is JSONObject) merge(dv, tv)
            }
        }
    }
}
