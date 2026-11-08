package de.achmo.kiautopilot

import android.util.Base64
import org.json.JSONObject
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** Sprecherstimme: ElevenLabs (mit Wort-Zeitstempeln) oder OpenAI. */
class Voice(private val e: Engine) {
    class Word(val w: String, val start: Double, val end: Double)
    class Result(val audio: ByteArray, val mime: String, val ext: String, val words: List<Word>, val durationS: Double, val costUsd: Double)
    class Span(val start: Double, val end: Double) {
        val durationS: Double get() = end - start
    }

    fun synthesize(text: String): Result =
        if (e.cfg("voice").s("provider") == "openai") openai(text) else eleven(text)

    private fun eleven(text: String): Result {
        val v = e.cfg("voice")
        val key = v.s("elevenKey")
        if (key.isEmpty()) throw UserError("Kein ElevenLabs-Schlüssel hinterlegt (Mehr → Schlüssel).")
        val body = JSONObject().put("text", text).put("model_id", v.s("model", "eleven_multilingual_v2"))
            .put(
                "voice_settings",
                JSONObject().put("stability", 0.45).put("similarity_boost", 0.8).put("style", 0.25).put("use_speaker_boost", true),
            )
        val r = Http.request(
            "POST",
            "https://api.elevenlabs.io/v1/text-to-speech/" + Http.enc(v.s("voiceId", "JBFqnCBsd6RMkjVDRZzb")) + "/with-timestamps?output_format=mp3_44100_128",
            mapOf("xi-api-key" to key, "Content-Type" to "application/json"),
            body.toString().toByteArray(), timeoutMs = 180_000, retries = 1,
        )
        val j = r.json()
        if (!r.ok) {
            val d = j.opt("detail")
            val msg = when (d) {
                is JSONObject -> d.s("message", d.toString())
                null -> r.code.toString()
                else -> d.toString()
            }
            throw UserError("ElevenLabs: $msg")
        }
        val audio = Base64.decode(j.getString("audio_base64"), Base64.DEFAULT)
        val words = wordsFromAlignment(j.optJSONObject("alignment") ?: j.optJSONObject("normalized_alignment"))
        val spoken = words.lastOrNull()?.end ?: (text.split(Regex("\\s+")).size / 2.6)
        // mp3_44100_128 ist konstante Bitrate: Bytes → Sekunden
        val byBytes = audio.size * 8.0 / 128_000
        val dur = min(max(spoken + 0.25, byBytes), spoken + 1.5)
        return Result(audio, "audio/mpeg", "mp3", words, dur, 0.0)
    }

    private fun openai(text: String): Result {
        val v = e.cfg("voice")
        val key = v.s("openaiKey")
        if (key.isEmpty()) throw UserError("Kein OpenAI-Schlüssel hinterlegt (Mehr → Schlüssel).")
        val body = JSONObject().put("model", v.s("openaiModel", "gpt-4o-mini-tts")).put("voice", v.s("openaiVoice", "onyx"))
            .put("input", text).put("response_format", "wav")
            .put("instructions", "Energetic, clear tech explainer narrator. Natural pace, confident, slightly warm.")
        val r = Http.request(
            "POST", "https://api.openai.com/v1/audio/speech",
            mapOf("Authorization" to "Bearer $key", "Content-Type" to "application/json"),
            body.toString().toByteArray(), timeoutMs = 180_000, retries = 1,
        )
        if (!r.ok) {
            val m = r.json().optJSONObject("error")?.s("message")?.ifEmpty { null } ?: r.code.toString()
            throw UserError("OpenAI-Stimme: $m")
        }
        val dur = wavDuration(r.bytes)
        if (dur < 3) throw UserError("OpenAI-Stimme: Audio ist leer oder unlesbar.")
        return Result(r.bytes, "audio/wav", "wav", emptyList(), dur + 0.2, dur / 60 * 0.015)
    }

    private fun wavDuration(b: ByteArray): Double {
        fun le32(i: Int): Int = (b[i].toInt() and 0xff) or ((b[i + 1].toInt() and 0xff) shl 8) or
            ((b[i + 2].toInt() and 0xff) shl 16) or ((b[i + 3].toInt() and 0xff) shl 24)
        var byteRate = 48_000
        var dataStart = 44
        var i = 12
        while (i + 8 <= b.size) {
            val id = String(b, i, 4, Charsets.US_ASCII)
            val size = le32(i + 4)
            if (id == "fmt " && i + 20 <= b.size) byteRate = le32(i + 16)
            if (id == "data") {
                dataStart = i + 8
                break
            }
            if (size < 0) break
            i += 8 + size + (size and 1)
        }
        if (byteRate <= 0) byteRate = 48_000
        return max(0, b.size - dataStart).toDouble() / byteRate
    }

    /** Zeichen-Zeitstempel (ElevenLabs) → Wörter mit Start/Ende in Sekunden. */
    private fun wordsFromAlignment(al: JSONObject?): List<Word> {
        val out = mutableListOf<Word>()
        if (al == null) return out
        val chars = al.optJSONArray("characters") ?: return out
        val starts = al.optJSONArray("character_start_times_seconds") ?: return out
        val ends = al.optJSONArray("character_end_times_seconds") ?: return out
        val sb = StringBuilder()
        var ws = 0.0
        var we = 0.0
        for (i in 0 until chars.length()) {
            val ch = chars.optString(i)
            if (ch.isBlank()) {
                if (sb.isNotEmpty()) {
                    out.add(Word(sb.toString(), ws, we))
                    sb.setLength(0)
                }
                continue
            }
            if (sb.isEmpty()) ws = starts.optDouble(i, we)
            sb.append(ch)
            we = ends.optDouble(i, ws)
        }
        if (sb.isNotEmpty()) out.add(Word(sb.toString(), ws, we))
        return out
    }

    /** Szenengrenzen aus den Wortzeiten: Szene i beginnt beim ersten Wort ihres Sprechtexts. */
    fun sceneSpans(narrations: List<String>, words: List<Word>, totalS: Double): List<Span> {
        val counts = narrations.map { n -> n.trim().split(Regex("\\s+")).count { it.isNotEmpty() } }
        val sum = max(1, counts.sum())
        val scale = words.size.toDouble() / sum
        val starts = mutableListOf<Double>()
        var acc = 0
        for (i in counts.indices) {
            starts.add(
                when {
                    i == 0 -> 0.0
                    words.isNotEmpty() -> words[min(words.size - 1, (acc * scale).roundToInt())].start
                    else -> acc.toDouble() / sum * totalS
                },
            )
            acc += counts[i]
        }
        val s = starts.toMutableList()
        val e2 = MutableList(s.size) { i -> if (i + 1 < s.size) s[i + 1] else totalS }
        // Mindestlänge 1,5 s je Szene
        for (i in s.indices) {
            if (e2[i] - s[i] < 1.5 && i + 1 < s.size) {
                e2[i] = s[i] + 1.5
                s[i + 1] = e2[i]
            }
        }
        if (e2.isNotEmpty()) e2[e2.size - 1] = max(totalS, s.last() + 1.5)
        return s.indices.map { Span(s[it], e2[it]) }
    }
}
