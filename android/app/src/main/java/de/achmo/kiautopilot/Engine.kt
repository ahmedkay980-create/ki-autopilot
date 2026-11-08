package de.achmo.kiautopilot

import android.content.Context
import android.net.Uri
import android.os.Build
import androidx.core.content.ContextCompat
import androidx.core.content.pm.PackageInfoCompat
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Callable
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.roundToLong

/**
 * Der Autopilot. Ein Knopf → Markt analysieren → Thema → Recherche → Skript → Faktencheck → Stimme
 * → KI-Szenen → Schnitt → Untertitel → fertiges Video. OK → parallel auf Instagram, TikTok, YouTube.
 * Jeder Schritt wird gespeichert; nach einer Unterbrechung geht es dort weiter, wo es aufgehört hat.
 */
class Engine private constructor(val ctx: Context) {
    companion object {
        const val ACT_PRODUCE = "produce"
        const val ACT_PUBLISH = "publish"
        const val ACT_RADAR = "radar"
        const val ACT_TICK = "tick"
        val STEPS = listOf("Markt", "Recherche", "Skript", "Faktencheck", "Stimme", "KI-Szenen", "Schnitt", "Untertitel")
        val PLATFORMS = listOf("instagram", "tiktok", "youtube")
        val LABEL = mapOf("instagram" to "Instagram", "tiktok" to "TikTok", "youtube" to "YouTube")

        val io: ExecutorService = Executors.newCachedThreadPool()

        @Volatile private var instance: Engine? = null

        fun get(c: Context): Engine = instance ?: synchronized(this) {
            instance ?: Engine(c.applicationContext).also { instance = it }
        }

        private fun net() = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

        /** Hintergrundarbeit über WorkManager (läuft auch, wenn die App zu ist). */
        fun schedule(c: Context, action: String, arg: String?) {
            val req = OneTimeWorkRequestBuilder<JobWorker>()
                .setInputData(workDataOf("action" to action, "arg" to arg))
                .setConstraints(net())
                .build()
            WorkManager.getInstance(c).enqueueUniqueWork("$action-$arg", ExistingWorkPolicy.APPEND_OR_REPLACE, req)
        }

        fun schedulePeriodic(c: Context) {
            val req = PeriodicWorkRequestBuilder<JobWorker>(1, TimeUnit.HOURS)
                .setInputData(workDataOf("action" to ACT_TICK))
                .setConstraints(net())
                .build()
            WorkManager.getInstance(c).enqueueUniquePeriodicWork("tick", ExistingPeriodicWorkPolicy.KEEP, req)
        }
    }

    private class JobCtx(val videoId: String, val deadline: Long)

    val store = Store(File(ctx.filesDir, "db.json"))
    val claude = Claude(this)
    val agents = Agents(this)
    val voice = Voice(this)
    val fal = Fal(this)
    val instagram = Instagram(this)
    val youtube = YouTube(this)
    val tiktok = TikTok(this)

    private val producing = AtomicReference<String?>(null)
    private val radarRunning = AtomicBoolean(false)
    private val publishing: MutableSet<String> = ConcurrentHashMap.newKeySet()
    private val jobCtx = ThreadLocal<JobCtx?>()

    @Volatile private var stopRequested = false

    /** Live-Text für die Benachrichtigung des Vordergrunddienstes. */
    @Volatile var onProgress: ((String) -> Unit)? = null

    init {
        // Neuer Prozess: nichts läuft. Hängengebliebene Zustände aufräumen.
        store.edit {
            for (v in videos().objects()) {
                when (v.s("status")) {
                    "läuft" -> v.put("status", "fehler").put("error", "Unterbrochen – Android hat die App beendet. Tippe auf „Weiter“, es geht dort weiter, wo es aufgehört hat.")
                    "posten" -> v.put("status", "fertig")
                }
                val p = v.optJSONObject("platforms") ?: continue
                for (k in PLATFORMS) {
                    val o = p.optJSONObject(k) ?: continue
                    if (o.s("status") == "läuft") o.put("status", "fehler").put("error", "Unterbrochen – bitte erneut hochladen.")
                }
            }
        }
    }

    // ---------------------------------------------------------------- Helfer

    fun cfg(section: String): JSONObject = store.read { store.db.obj("config").obj(section) }

    private fun videos(): JSONArray = store.db.arr("videos")

    fun video(id: String): JSONObject? = store.read { videos().objects().firstOrNull { it.s("id") == id } }

    private fun topic(id: String): JSONObject? = store.read { store.db.arr("topics").objects().firstOrNull { it.s("id") == id } }

    private fun activeVideo(): JSONObject? = store.read { videos().objects().firstOrNull { it.s("status") == "läuft" || it.s("status") == "pausiert" } }

    fun log(level: String, text: String) {
        store.edit {
            val a = store.db.arr("log")
            a.put(JSONObject().put("at", Time.iso()).put("level", level).put("text", text))
            while (a.length() > 200) a.remove(0)
        }
    }

    private fun hist(v: JSONObject, text: String) {
        store.edit {
            val h = v.arr("history")
            h.put(JSONObject().put("at", Time.iso()).put("text", text))
            while (h.length() > 60) h.remove(0)
        }
    }

    private fun progress(text: String) {
        try {
            onProgress?.invoke(text)
        } catch (ex: Exception) {
            // Benachrichtigung ist nur Beiwerk
        }
    }

    private fun step(v: JSONObject, i: Int, text: String) {
        checkStop()
        store.edit { v.put("step", i).put("stepText", text).put("status", "läuft").remove("error") }
        hist(v, text)
        progress(text)
    }

    fun addCost(kind: String, usd: Double) {
        if (usd <= 0 || usd.isNaN()) return
        val vid = jobCtx.get()?.videoId
        store.edit {
            val m = store.db.obj("costs").obj(Time.month())
            m.put(kind, m.optDouble(kind, 0.0) + usd)
            m.put("total", m.optDouble("total", 0.0) + usd)
            if (vid != null) {
                val v = videos().objects().firstOrNull { it.s("id") == vid }
                if (v != null) v.put("costUsd", v.optDouble("costUsd", 0.0) + usd)
            }
        }
    }

    /** Wird in Schleifen aufgerufen: Stopp durch den Nutzer oder Zeitlimit im Hintergrund. */
    fun checkStop() {
        val c = jobCtx.get() ?: return
        if (stopRequested && producing.get() == c.videoId) throw StoppedError()
        if (System.currentTimeMillis() > c.deadline) throw PauseError()
    }

    /** Schlafen, aber auf Stopp reagieren. */
    fun nap(ms: Long) {
        var left = ms
        while (left > 0) {
            checkStop()
            val n = minOf(left, 1000L)
            Thread.sleep(n)
            left -= n
        }
    }

    private fun inBackground(): Boolean = (jobCtx.get()?.deadline ?: Long.MAX_VALUE) != Long.MAX_VALUE

    fun missingKeys(): List<String> {
        val m = mutableListOf<String>()
        if (!claude.ready) m.add("Claude")
        if (cfg("video").s("falKey").isEmpty()) m.add("fal.ai")
        val v = cfg("voice")
        val voiceMissing = if (v.s("provider") == "openai") v.s("openaiKey").isEmpty() else v.s("elevenKey").isEmpty()
        if (voiceMissing) m.add("Stimme")
        return m
    }

    fun targets(): List<String> = PLATFORMS.filter {
        when (it) {
            "instagram" -> instagram.ready
            "tiktok" -> tiktok.ready
            else -> youtube.ready
        }
    }

    private fun monthSpent(): Double = store.read { store.db.obj("costs").optJSONObject(Time.month())?.optDouble("total", 0.0) ?: 0.0 }

    /** Grobe Kosten pro Video: ~55 s KI-Video plus Claude. */
    fun estimate(): Double = 55 * cfg("video").optDouble("pricePerSecond", 0.10) * 1.15 + 0.5

    private fun checkBudget() {
        val budget = cfg("budget").optDouble("monthlyUsd", 60.0)
        val spent = monthSpent()
        if (budget > 0 && spent + estimate() > budget) {
            throw UserError(String.format(java.util.Locale.GERMAN, "Monatsbudget erreicht: %.2f $ von %.0f $ verbraucht. Unter Mehr → Autopilot erhöhen.", spent, budget))
        }
    }

    fun versionCode(): Long = try {
        PackageInfoCompat.getLongVersionCode(ctx.packageManager.getPackageInfo(ctx.packageName, 0))
    } catch (ex: Exception) {
        0L
    }

    fun versionName(): String = try {
        ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName ?: ""
    } catch (ex: Exception) {
        ""
    }

    fun batteryOk(): Boolean = try {
        (ctx.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager).isIgnoringBatteryOptimizations(ctx.packageName)
    } catch (ex: Exception) {
        true
    }

    private fun enqueue(action: String, arg: String?) {
        ContextCompat.startForegroundService(ctx, PipelineService.intent(ctx, action, arg))
    }

    // ---------------------------------------------------------------- Video starten

    fun startVideo(topicId: String?): JSONObject {
        val miss = missingKeys()
        if (miss.isNotEmpty()) throw UserError("Es fehlen noch Schlüssel: " + miss.joinToString(", ") + " (Mehr → Schlüssel).")
        if (producing.get() != null || activeVideo() != null) throw UserError("Es entsteht gerade schon ein Video. Warte kurz, bis es fertig ist.")
        checkBudget()
        val v = JSONObject().put("id", newId()).put("createdAt", Time.iso()).put("status", "läuft")
            .put("step", 0).put("stepText", "Startet …").put("title", "Neues Video")
        store.edit {
            if (topicId != null) {
                val t = store.db.arr("topics").objects().firstOrNull { it.s("id") == topicId } ?: throw UserError("Thema nicht gefunden.")
                t.put("status", "verwendet")
                v.put("topic", JSONObject(t.toString())).put("title", t.s("title"))
            }
            videos().put(v)
            trimVideos()
        }
        return v
    }

    private fun trimVideos() {
        val a = videos()
        while (a.length() > 40) {
            val old = a.optJSONObject(0)
            old?.s("localFile")?.let { if (it.isNotEmpty()) File(it).delete() }
            a.remove(0)
        }
    }

    // ---------------------------------------------------------------- Produktion

    /** true = abgeschlossen (fertig, Prüfung nötig oder Fehler), false = pausiert (Zeitlimit im Hintergrund). */
    fun produceJob(id: String, deadline: Long = Long.MAX_VALUE): Boolean {
        val v = video(id) ?: return true
        if (!producing.compareAndSet(null, id)) return true
        stopRequested = false
        jobCtx.set(JobCtx(id, deadline))
        try {
            pipeline(v)
            return true
        } catch (p: PauseError) {
            store.edit { v.put("status", "pausiert").put("stepText", "Kurze Pause – geht gleich automatisch weiter …") }
            return false
        } catch (s: StoppedError) {
            store.edit { v.put("status", "gestoppt").put("stepText", "Von dir gestoppt") }
            hist(v, "Von dir gestoppt")
            return true
        } catch (ex: Throwable) {
            fail(v, ex)
            return true
        } finally {
            jobCtx.remove()
            producing.compareAndSet(id, null)
        }
    }

    private fun fail(v: JSONObject, ex: Throwable) {
        val msg = friendly(ex)
        store.edit { v.put("status", "fehler").put("error", msg).put("stepText", "Fehler: $msg") }
        hist(v, "Fehler: $msg")
        log("error", v.s("title") + ": " + msg)
        Notify.simple(ctx, v.s("id").hashCode(), "Video angehalten", msg)
        report("Produktion (Schritt " + STEPS.getOrElse(v.optInt("step")) { "?" } + ")", ex)
    }

    private fun pipeline(v: JSONObject) {
        val id = v.s("id")
        store.edit { v.put("status", "läuft").remove("error") }

        // 0 Markt analysieren und Thema wählen
        if (!v.has("topic")) {
            step(v, 0, "Analysiere den Markt: YouTube, Hacker News, Reddit, News …")
            val t = pickTopic()
            store.edit { v.put("topic", JSONObject(t.toString())).put("title", t.s("title")) }
            hist(v, "Thema gewählt: " + t.s("title") + " (Nachfrage " + t.optInt("demand") + "/100)")
        }
        val topic = v.getJSONObject("topic")

        // 1 Recherche
        if (!v.has("research")) {
            step(v, 1, "Recherchiere Fakten mit Websuche …")
            val r = agents.research(topic)
            if (r.text.length < 200) throw UserError("Die Recherche hat zu wenig Fakten gefunden. Bitte ein anderes Thema wählen.")
            store.edit { v.put("research", r.toJson()) }
            hist(v, "Faktenblatt mit " + r.sources.length() + " Quellen erstellt")
        }
        val factSheet = v.getJSONObject("research").s("text")

        // 2 Skript
        if (!v.has("script")) {
            step(v, 2, "Schreibe das Skript …")
            val maxScenes = cfg("video").optInt("maxScenes", 7).coerceIn(4, 8)
            val s = agents.writeScript(topic, factSheet, maxScenes)
            store.edit { v.put("script", s).put("title", s.s("title", v.s("title"))) }
            hist(v, "Skript fertig: " + s.getJSONArray("scenes").length() + " Szenen")
        }
        val script = v.getJSONObject("script")

        // 3 Faktencheck
        val q = cfg("quality")
        if (q.optBoolean("factCheck", true) && !v.has("factCheck")) {
            step(v, 3, "Prüfe jede Aussage gegen die Quellen …")
            val fc = agents.factCheck(script, factSheet)
            var fixes = 0
            store.edit {
                val scenes = script.getJSONArray("scenes")
                for (iss in fc.optJSONArray("issues")?.objects() ?: emptyList()) {
                    val i = iss.optInt("scene", -2)
                    val fix = iss.s("fixedNarration").trim()
                    if (fix.isNotEmpty() && i >= 0 && i < scenes.length() && iss.s("severity") != "niedrig") {
                        scenes.getJSONObject(i).put("narration", fix)
                        fixes++
                    }
                }
                v.put("factCheck", fc.put("fixes", fixes))
            }
            hist(v, if (fc.optBoolean("pass", true)) "Faktencheck bestanden ($fixes Korrekturen)" else "Faktencheck hat Bedenken")
        }
        val fc = v.optJSONObject("factCheck")
        if (fc != null && !fc.optBoolean("pass", true) && q.optBoolean("blockOnFail", true) && !v.optBoolean("approved")) {
            store.edit { v.put("status", "pruefen").put("stepText", "Faktencheck hat Bedenken – bitte kurz ansehen") }
            Notify.simple(ctx, id.hashCode(), "Bitte kurz prüfen", "Der Faktencheck hat Bedenken bei „" + v.s("title") + "“. Es wurde noch kein Geld für Video ausgegeben.")
            return
        }

        // ab hier kostet es Geld
        if (!v.has("voice")) checkBudget()

        // 4 Stimme
        if (!v.has("voice")) {
            step(v, 4, "Spreche den Text ein …")
            val scenes = script.getJSONArray("scenes").objects()
            val narr = scenes.map { it.s("narration").trim() }
            val vr = voice.synthesize(narr.joinToString(" "))
            addCost("voice", vr.costUsd)
            val url = fal.upload(vr.audio, null, vr.mime, "voice-$id.${vr.ext}")
            val spans = voice.sceneSpans(narr, vr.words, vr.durationS)
            val shots = planShots(scenes, spans)
            store.edit {
                v.put("voice", JSONObject().put("url", url).put("durationS", vr.durationS))
                v.put("shots", shots)
            }
            hist(v, String.format(java.util.Locale.GERMAN, "Stimme fertig: %.1f Sekunden, %d KI-Szenen geplant", vr.durationS, shots.length()))
        }

        // 5 KI-Szenen
        makeShots(v)

        // 6 Schnitt
        if (!v.has("composeUrl")) {
            step(v, 6, "Schneide Szenen und Stimme zusammen …")
            val shots = v.getJSONArray("shots").objects()
            val vk = JSONArray()
            var t = 0L
            for (sh in shots) {
                val d = (sh.optDouble("durationS") * 1000).roundToLong()
                vk.put(JSONObject().put("url", sh.s("url")).put("timestamp", t).put("duration", d))
                t += d
            }
            val voiceUrl = v.getJSONObject("voice").s("url")
            val ak = JSONArray().put(JSONObject().put("url", voiceUrl).put("timestamp", 0).put("duration", t))
            val tracks = JSONArray()
                .put(JSONObject().put("id", "video").put("type", "video").put("keyframes", vk))
                .put(JSONObject().put("id", "voice").put("type", "audio").put("keyframes", ak))
            val out = fal.run("fal-ai/ffmpeg-api/compose", JSONObject().put("tracks", tracks))
            val url = out.s("video_url")
            if (url.isEmpty()) throw UserError("Schnitt: fal.ai hat kein Video geliefert.")
            store.edit { v.put("composeUrl", url).put("thumbUrl", out.s("thumbnail_url")) }
            hist(v, "Schnitt fertig")
        }

        // 7 Untertitel
        if (!v.has("finalUrl")) {
            val cap = cfg("captions")
            if (cap.optBoolean("enabled", true)) {
                step(v, 7, "Füge Untertitel hinzu …")
                try {
                    val input = JSONObject().put("video_url", v.s("composeUrl")).put("language", "en")
                        .put("font_name", cap.s("font", "Montserrat")).put("font_size", cap.optInt("fontSize", 80))
                        .put("font_weight", "black").put("font_color", cap.s("color", "white"))
                        .put("highlight_color", cap.s("highlight", "yellow")).put("stroke_width", 4).put("stroke_color", "black")
                        .put("background_color", "none").put("position", cap.s("position", "center"))
                        .put("y_offset", cap.optInt("yOffset", 220)).put("words_per_subtitle", cap.optInt("words", 2))
                        .put("enable_animation", true)
                    val out = fal.run("fal-ai/workflow-utilities/auto-subtitle", input)
                    val url = out.optJSONObject("video")?.s("url") ?: ""
                    if (url.isEmpty()) throw UserError("kein Video im Ergebnis")
                    store.edit { v.put("finalUrl", url) }
                    hist(v, "Untertitel fertig")
                } catch (ex: PauseError) {
                    throw ex
                } catch (ex: StoppedError) {
                    throw ex
                } catch (ex: Exception) {
                    store.edit { v.put("finalUrl", v.s("composeUrl")).put("warning", "Ohne Untertitel: " + friendly(ex)) }
                    hist(v, "Untertitel nicht möglich (" + friendly(ex) + ") – Video ohne Untertitel")
                }
            } else {
                store.edit { v.put("finalUrl", v.s("composeUrl")) }
            }
        }

        // Fertiges Video aufs Handy laden (für TikTok und YouTube)
        checkStop()
        val f = ensureLocal(v)
        store.edit {
            v.put("status", "fertig").put("step", STEPS.size).put("stepText", "Fertig – wartet auf dein OK").put("readyAt", Time.iso())
                .put("localFile", f.path)
        }
        hist(v, "Video fertig")
        val auto = cfg("autopilot").optBoolean("autoPost", false) && targets().isNotEmpty()
        if (auto) {
            hist(v, "Autopilot: lade automatisch hoch")
            if (inBackground()) schedule(ctx, ACT_PUBLISH, id) else publishJob(id)
        } else {
            Notify.ready(ctx, v, targets().isNotEmpty())
        }
    }

    private fun clipFor(d: Double): Int = when {
        d <= 4.0 -> 4
        d <= 6.0 -> 6
        else -> 8
    }

    /** Pro Szene ein KI-Clip (4, 6 oder 8 s). Längere Szenen werden auf mehrere Einstellungen verteilt. */
    private fun planShots(scenes: List<JSONObject>, spans: List<Voice.Span>): JSONArray {
        val out = JSONArray()
        scenes.forEachIndexed { i, sc ->
            val d = spans[i].durationS
            val n = max(1, ceil(d / 8.0).toInt())
            val part = d / n
            for (k in 0 until n) {
                val prompt = sc.s("visual") + if (k > 0) " Continue the same scene from a different camera angle." else ""
                out.put(
                    JSONObject().put("scene", i).put("prompt", prompt).put("durationS", part)
                        .put("clipS", clipFor(part)).put("status", "wartet"),
                )
            }
        }
        return out
    }

    private fun shotInput(sh: JSONObject, fallback: Boolean): JSONObject {
        val vc = cfg("video")
        val base = if (fallback) {
            "Abstract cinematic visualization of artificial intelligence: glowing particles and streams of light flowing through a dark futuristic space."
        } else {
            sh.s("prompt")
        }
        return JSONObject().put("prompt", (base + " " + vc.s("style")).trim()).put("aspect_ratio", "9:16")
            .put("duration", sh.optInt("clipS", 8).toString() + "s").put("resolution", vc.s("resolution", "720p"))
            .put("generate_audio", false).put("negative_prompt", vc.s("negative"))
    }

    private fun makeShots(v: JSONObject) {
        val shots = v.getJSONArray("shots").objects()
        if (shots.all { it.s("url").isNotEmpty() }) return
        step(v, 5, "Erzeuge ${shots.size} KI-Videoszenen …")
        val vc = cfg("video")
        val model = vc.s("model", "fal-ai/veo3.1/fast")
        val price = vc.optDouble("pricePerSecond", 0.10)
        for (sh in shots) {
            if (sh.s("url").isEmpty() && sh.s("statusUrl").isEmpty()) {
                checkStop()
                val h = fal.submit(model, shotInput(sh, false))
                store.edit { sh.put("statusUrl", h.s("status_url")).put("responseUrl", h.s("response_url")).put("status", "läuft") }
            }
        }
        val started = System.currentTimeMillis()
        var round = 0
        while (true) {
            val pending = shots.filter { it.s("url").isEmpty() }
            val done = shots.size - pending.size
            val text = "KI-Szenen: $done von ${shots.size} fertig"
            store.edit { v.put("stepText", text) }
            progress(text)
            if (pending.isEmpty()) break
            if (System.currentTimeMillis() - started > 30 * 60_000L) {
                throw UserError("fal.ai braucht ungewöhnlich lange für die Szenen. Tippe später auf „Weiter“ – fertige Szenen bleiben erhalten.")
            }
            for (sh in pending) {
                checkStop()
                val st = fal.status(sh.s("statusUrl"))
                if (st.s("status") != "COMPLETED") continue
                try {
                    val res = fal.call("GET", sh.s("responseUrl"))
                    val url = res.optJSONObject("video")?.s("url") ?: ""
                    if (url.isEmpty()) throw UserError("Ergebnis enthält kein Video.")
                    store.edit { sh.put("url", url).put("status", "fertig") }
                    addCost("video", sh.optInt("clipS", 8) * price)
                } catch (ex: UserError) {
                    val tries = sh.optInt("tries", 0)
                    if (tries >= 2) throw UserError("Szene " + (sh.optInt("scene") + 1) + ": " + ex.message)
                    val h = fal.submit(model, shotInput(sh, tries >= 1))
                    store.edit {
                        sh.put("tries", tries + 1).put("statusUrl", h.s("status_url")).put("responseUrl", h.s("response_url"))
                    }
                    hist(v, "Szene " + (sh.optInt("scene") + 1) + " wird neu erzeugt (" + ex.message + ")")
                }
            }
            nap(if (round++ < 3) 6000L else 10_000L)
        }
        hist(v, "Alle ${shots.size} KI-Szenen fertig")
    }

    private fun ensureLocal(v: JSONObject): File {
        val f = File(ctx.filesDir, "videos/" + v.s("id") + ".mp4")
        if (!f.exists() || f.length() < 10_000) {
            val url = v.s("finalUrl")
            if (url.isEmpty()) throw UserError("Das Video ist noch nicht fertig.")
            Http.download(url, f)
        }
        return f
    }

    // ---------------------------------------------------------------- Themen

    fun radarJob(): String {
        if (!radarRunning.compareAndSet(false, true)) {
            waitForRadar()
            return "Marktanalyse lief bereits"
        }
        try {
            progress("Analysiere den Markt …")
            val r = Trends(this).collect()
            if (r.signals.isEmpty()) {
                throw UserError("Keine Signale gefunden: " + r.errors.joinToString("; ").ifEmpty { "alle Quellen leer" })
            }
            val recent = store.read { videos().objects().takeLast(25).map { it.s("title") } }
            val topics = agents.topicsFromSignals(r.signals, recent)
            store.edit {
                val arr = JSONArray()
                store.db.arr("topics").objects().filter { it.s("status") == "verwendet" }.takeLast(30).forEach { arr.put(it) }
                topics.forEach { t -> arr.put(t.put("id", newId()).put("status", "neu").put("createdAt", Time.iso())) }
                store.db.put("topics", arr)
                store.db.put(
                    "radar",
                    JSONObject().put("at", Time.iso()).put("sources", r.sources).put("errors", jsonArrayOf(r.errors))
                        .put("signals", r.signals.size).put("topics", topics.size),
                )
            }
            val msg = "${topics.size} Themen aus ${r.signals.size} Signalen"
            log("info", "Marktanalyse: $msg")
            return msg
        } finally {
            radarRunning.set(false)
        }
    }

    private fun waitForRadar() {
        val until = System.currentTimeMillis() + 5 * 60_000L
        while (radarRunning.get() && System.currentTimeMillis() < until) nap(1500)
    }

    private fun pickTopic(): JSONObject {
        val maxAge = cfg("trends").optDouble("maxAgeHours", 3.0) * 3_600_000
        val radarAt = store.read { store.db.obj("radar").s("at") }
        fun fresh(): List<JSONObject> = store.read {
            store.db.arr("topics").objects().filter { it.s("status") == "neu" }.sortedByDescending { it.optInt("demand") }
        }
        if (radarRunning.get()) waitForRadar()
        else if (Time.ageMs(radarAt) > maxAge || fresh().isEmpty()) radarJob()
        val t = fresh().firstOrNull() ?: throw UserError("Die Marktanalyse hat keine Themen gefunden.")
        store.edit { t.put("status", "verwendet") }
        return t
    }

    // ---------------------------------------------------------------- Hochladen

    private fun caption(v: JSONObject): String {
        val s = v.optJSONObject("script") ?: JSONObject()
        val tags = (s.optJSONArray("hashtags")?.strings() ?: emptyList()).joinToString(" ") { "#$it" }
        return (s.s("caption") + "\n\nVisuals and voice are AI-generated.\n\n" + tags).trim()
    }

    private fun ytDescription(v: JSONObject): String {
        val s = v.optJSONObject("script") ?: JSONObject()
        val src = (s.optJSONArray("sources")?.objects() ?: emptyList()).take(5).joinToString("\n") { "• " + it.s("url") }
        return s.s("caption") + (if (src.isNotEmpty()) "\n\nSources:\n$src" else "") + "\n\nVisuals and voice are AI-generated.\n\n" +
            (s.optJSONArray("hashtags")?.strings() ?: emptyList()).joinToString(" ") { "#$it" }
    }

    private fun ytTitle(v: JSONObject): String {
        val t = v.s("title").take(90)
        return if (t.length <= 91) "$t #Shorts" else t
    }

    fun publishJob(id: String) {
        val v = video(id) ?: return
        if (!publishing.add(id)) return
        try {
            val ts = targets()
            if (ts.isEmpty()) throw UserError("Noch keine Plattform verbunden (Mehr → Plattformen).")
            val f = ensureLocal(v)
            // Instagram holt das Video per Link ab – alte Links vorsichtshalber erneuern
            if ("instagram" in ts && Time.ageMs(v.s("readyAt")) > 5 * 86_400_000L) {
                val fresh = fal.upload(null, f, "video/mp4", "video-$id.mp4")
                store.edit { v.put("finalUrl", fresh).put("readyAt", Time.iso()) }
            }
            val todo = store.read { ts.filter { v.optJSONObject("platforms")?.optJSONObject(it)?.s("status") != "ok" } }
            if (todo.isEmpty()) return
            store.edit {
                v.put("status", "posten").remove("error")
                todo.forEach { t -> v.obj("platforms").put(t, JSONObject().put("status", "läuft").put("at", Time.iso())) }
            }
            hist(v, "Lade hoch: " + todo.joinToString(", ") { LABEL[it] ?: it })
            progress("Lade hoch: " + todo.joinToString(", ") { LABEL[it] ?: it })
            val futures = todo.map { t -> io.submit(Callable { publishOne(t, v, f) }) }
            futures.forEach {
                try {
                    it.get()
                } catch (ex: Exception) {
                    // Fehler wurde bereits pro Plattform vermerkt
                }
            }
            val p = store.read { JSONObject(v.obj("platforms").toString()) }
            val ok = ts.filter { p.optJSONObject(it)?.s("status") == "ok" }
            val bad = ts.filter { it !in ok }
            store.edit {
                v.put("status", if (ok.isNotEmpty()) "online" else "fertig")
                if (ok.isNotEmpty() && !v.has("publishedAt")) v.put("publishedAt", Time.iso())
            }
            val okText = ok.joinToString(", ") { LABEL[it] ?: it }
            val text = if (bad.isEmpty()) "Online auf $okText 🎉"
            else (if (ok.isEmpty()) "Nicht hochgeladen" else "Online auf $okText") + " – Problem bei " + bad.joinToString(", ") { LABEL[it] ?: it } + ". In der App erneut versuchen."
            hist(v, text)
            Notify.simple(ctx, id.hashCode(), v.s("title"), text)
        } catch (ex: Throwable) {
            val m = friendly(ex)
            store.edit { v.put("status", "fertig").put("error", m) }
            hist(v, "Hochladen fehlgeschlagen: $m")
            Notify.simple(ctx, id.hashCode(), "Hochladen fehlgeschlagen", m)
        } finally {
            publishing.remove(id)
        }
    }

    private fun publishOne(t: String, v: JSONObject, f: File) {
        try {
            val res = when (t) {
                "instagram" -> instagram.publishReel(v.s("finalUrl"), caption(v).take(2200)) { s -> hist(v, "Instagram: $s") }
                "youtube" -> youtube.upload(
                    f, ytTitle(v), ytDescription(v),
                    v.optJSONObject("script")?.optJSONArray("hashtags")?.strings() ?: emptyList(),
                    cfg("youtube").s("privacy", "public"),
                )
                else -> tiktok.upload(f, caption(v), cfg("tiktok").s("mode", "entwurf"), cfg("tiktok").s("privacy", "PUBLIC_TO_EVERYONE"))
            }
            store.edit { v.obj("platforms").put(t, res.put("status", "ok").put("at", Time.iso())) }
            hist(v, (LABEL[t] ?: t) + ": hochgeladen" + (res.s("note").let { if (it.isNotEmpty()) " – $it" else "" }))
        } catch (ex: Throwable) {
            val m = friendly(ex)
            store.edit { v.obj("platforms").put(t, JSONObject().put("status", "fehler").put("error", m).put("at", Time.iso())) }
            hist(v, (LABEL[t] ?: t) + ": $m")
            log("error", (LABEL[t] ?: t) + ": $m")
            report("Hochladen " + (LABEL[t] ?: t), ex)
        }
    }

    // ---------------------------------------------------------------- Hintergrund

    fun runJob(action: String, arg: String?) {
        when (action) {
            ACT_PRODUCE -> if (arg != null) produceJob(arg)
            ACT_PUBLISH -> if (arg != null) publishJob(arg)
            ACT_RADAR -> try {
                radarJob()
            } catch (ex: Throwable) {
                val m = friendly(ex)
                log("error", "Marktanalyse: $m")
                store.edit { store.db.obj("radar").put("error", m).put("errorAt", Time.iso()) }
            }
        }
    }

    /** Stündlich: Token pflegen, Updates prüfen, Markt beobachten, ggf. tägliches Video. */
    fun autoTick() {
        val a = cfg("autopilot")
        try {
            val ig = cfg("instagram")
            if (instagram.ready && Time.ageMs(ig.s("tokenRefreshed")) > 20 * 86_400_000L) {
                val j = instagram.refresh()
                if (j.s("access_token").isNotEmpty()) {
                    store.edit { ig.put("token", j.s("access_token")).put("tokenRefreshed", Time.iso()) }
                    log("info", "Instagram-Zugang automatisch verlängert")
                }
            }
        } catch (ex: Exception) {
            log("warn", "Instagram-Zugang verlängern: " + friendly(ex))
        }
        try {
            val upd = store.read { store.db.optJSONObject("update") }
            if (Time.ageMs(upd?.s("checkedAt")) > 12 * 3_600_000L) {
                val u = checkUpdate()
                if (u.optBoolean("available") && u.s("latest") != upd?.s("notified")) {
                    store.edit { store.db.obj("update").put("notified", u.s("latest")) }
                    Notify.simple(ctx, 4711, "Update verfügbar", "Version " + u.s("latest") + " ist da – in der App unter Mehr installieren.")
                }
            }
        } catch (ex: Exception) {
            // kein Internet oder GitHub nicht erreichbar – nächstes Mal
        }
        val radarAt = store.read { store.db.obj("radar").s("at") }
        if (claude.ready && Time.ageMs(radarAt) > a.optDouble("radarHours", 6.0) * 3_600_000) {
            try {
                radarJob()
            } catch (ex: Exception) {
                log("warn", "Marktanalyse: " + friendly(ex))
            }
        }
        if (a.optBoolean("dailyVideo") && Time.reached(a.s("dailyTime", "17:00")) && !videoToday()) {
            try {
                val v = startVideo(null)
                hist(v, "Autopilot: tägliches Video gestartet")
                schedule(ctx, ACT_PRODUCE, v.s("id"))
            } catch (ex: Exception) {
                log("warn", "Autopilot: " + friendly(ex))
            }
        }
    }

    private fun videoToday(): Boolean {
        val today = Time.localDay(System.currentTimeMillis())
        return store.read { videos().objects().any { Time.localDay(Time.parse(it.s("createdAt"))) == today } }
    }

    // ---------------------------------------------------------------- Wartung

    fun checkUpdate(): JSONObject {
        val r = Http.request("GET", "https://api.github.com/repos/${Defaults.REPO}/releases/latest", mapOf("Accept" to "application/vnd.github+json"))
        if (!r.ok) throw UserError("GitHub antwortet nicht (${r.code}).")
        val j = r.json()
        val tag = j.s("tag_name")
        val num = Regex("(\\d+)$").find(tag)?.groupValues?.get(1)?.toLongOrNull() ?: 0L
        val apk = j.optJSONArray("assets")?.objects()?.firstOrNull { it.s("name").endsWith(".apk") }?.s("browser_download_url") ?: ""
        val old = store.read { store.db.optJSONObject("update") }
        val u = JSONObject().put("checkedAt", Time.iso()).put("latest", tag).put("available", num > versionCode() && apk.isNotEmpty())
            .put("url", apk).put("notes", j.s("body").take(800)).put("notified", old?.s("notified") ?: "")
        store.edit { store.db.put("update", u) }
        return u
    }

    private val reportedAt = ConcurrentHashMap<String, Long>()

    /** Technische Fehler automatisch als GitHub-Issue melden, damit sie nachts behoben werden. */
    fun report(where: String, ex: Throwable, manual: String? = null) {
        val g = cfg("github")
        val token = g.s("token")
        if (token.isEmpty() || (manual == null && !g.optBoolean("autoReport", true))) return
        val msg = ex.message ?: ex.javaClass.simpleName
        if (manual == null && Regex("Schlüssel|Monatsbudget|nicht verbunden|Guthaben|Keine Internetverbindung|Gestoppt|abgelaufen|Tageskontingent", RegexOption.IGNORE_CASE).containsMatchIn(msg)) return
        val sig = (where + ": " + msg).replace(Regex("[0-9a-f]{8,}|\\d+"), "#").take(140)
        val last = reportedAt[sig] ?: 0L
        if (manual == null && System.currentTimeMillis() - last < 3 * 86_400_000L) return
        reportedAt[sig] = System.currentTimeMillis()
        val trace = ex.stackTrace.take(25).joinToString("\n") { "    at $it" }
        var body = "**Automatische Meldung aus der App**\n\n" +
            "- Version: ${versionName()} (${versionCode()})\n- Android: ${Build.VERSION.RELEASE} (SDK ${Build.VERSION.SDK_INT}), ${Build.MANUFACTURER} ${Build.MODEL}\n" +
            "- Bereich: $where\n- Zeit: ${Time.iso()}\n\n" +
            (if (manual != null) "**Beschreibung:**\n$manual\n\n" else "") +
            "**Fehler:** ${friendly(ex)}\n\n```\n${ex.javaClass.name}: $msg\n$trace\n```\n"
        for (path in Defaults.SECRETS) {
            val (sec, key) = path.split(".")
            val value = cfg(sec).s(key)
            if (value.length >= 6) body = body.replace(value, "***")
        }
        val title = ("App: " + where + " – " + friendly(ex)).take(120)
        io.execute {
            try {
                val payload = JSONObject().put("title", title).put("body", body).put("labels", JSONArray().put("app-fehler"))
                Http.request(
                    "POST", "https://api.github.com/repos/${Defaults.REPO}/issues",
                    mapOf("Authorization" to "Bearer $token", "Accept" to "application/vnd.github+json", "Content-Type" to "application/json"),
                    payload.toString().toByteArray(), retries = 1,
                )
            } catch (e2: Exception) {
                // Meldung ist optional
            }
        }
    }

    // ---------------------------------------------------------------- Anmeldung (OAuth)

    fun authUrl(provider: String): String {
        val page = try {
            Http.request("GET", Defaults.REDIRECT, retries = 1).code
        } catch (ex: Exception) {
            0
        }
        if (page == 404) {
            throw UserError("Einmalig nötig: GitHub Pages einschalten – github.com/${Defaults.REPO}/settings/pages → Branch „main“, Ordner „/docs“ → Save. Nach 1–2 Minuten erneut auf „Verbinden“ tippen.")
        }
        val state = provider + "." + newId() + newId()
        val url = when (provider) {
            "youtube" -> {
                if (!youtube.configured) throw UserError("Erst Client-ID und Client-Geheimnis aus der Google Cloud eintragen und speichern.")
                youtube.authUrl(state)
            }
            "tiktok" -> {
                if (!tiktok.configured) throw UserError("Erst Client Key und Client Secret von TikTok eintragen und speichern.")
                tiktok.authUrl(state)
            }
            else -> throw UserError("Unbekannte Plattform.")
        }
        store.edit { store.db.put("oauthState", JSONObject().put("value", state).put("at", Time.iso())) }
        return url
    }

    fun oauthCallback(uri: Uri): String {
        val state = uri.getQueryParameter("state") ?: ""
        val code = uri.getQueryParameter("code") ?: ""
        val err = uri.getQueryParameter("error_description") ?: uri.getQueryParameter("error")
        val expected = store.read { store.db.optJSONObject("oauthState")?.s("value") ?: "" }
        val msg = try {
            if (state.isEmpty() || state != expected) throw UserError("Anmeldung abgelaufen – bitte erneut auf „Verbinden“ tippen.")
            if (!err.isNullOrEmpty()) throw UserError("Anmeldung abgebrochen: $err")
            if (code.isEmpty()) throw UserError("Keine Anmeldedaten erhalten.")
            store.edit { store.db.remove("oauthState") }
            if (state.startsWith("youtube.")) {
                val j = youtube.exchange(code)
                store.edit { cfg("youtube").put("refreshToken", j.s("refresh_token")) }
                val ch = try {
                    youtube.channel()
                } catch (ex: Exception) {
                    null
                }
                store.edit { cfg("youtube").put("channelTitle", ch?.s("title") ?: "") }
                "YouTube verbunden" + (if (ch != null) ": " + ch.s("title") else "")
            } else {
                val j = tiktok.exchange(code)
                store.edit { cfg("tiktok").put("refreshToken", j.s("refresh_token")).put("openId", j.s("open_id")) }
                val u = try {
                    tiktok.user()
                } catch (ex: Exception) {
                    null
                }
                store.edit { cfg("tiktok").put("username", u?.s("username") ?: "") }
                "TikTok verbunden" + (if (u != null) ": @" + u.s("username").ifEmpty { u.s("display_name") } else "")
            }
        } catch (ex: Exception) {
            notice(false, friendly(ex))
            throw ex
        }
        notice(true, msg)
        log("info", msg)
        return msg
    }

    private fun notice(ok: Boolean, text: String) {
        store.edit { store.db.put("notice", JSONObject().put("ok", ok).put("text", text).put("at", Time.iso())) }
    }

    private fun connectInstagram(token: String): String {
        val t = token.trim()
        if (t.length < 20) throw UserError("Das sieht nicht nach einem Instagram-Token aus.")
        val me = instagram.me(t)
        val uid = me.s("user_id").ifEmpty { me.s("id") }
        if (uid.isEmpty()) throw UserError("Instagram hat kein Konto zu diesem Token geliefert.")
        store.edit {
            cfg("instagram").put("token", t).put("userId", uid).put("username", me.s("username")).put("tokenRefreshed", Time.iso())
        }
        val type = me.s("account_type")
        return "Instagram verbunden: @" + me.s("username") + (if (type.isNotEmpty() && type != "BUSINESS" && type != "MEDIA_CREATOR") " (Achtung: Konto muss ein Profi-Konto sein)" else "")
    }

    private fun disconnect(p: String) {
        store.edit {
            when (p) {
                "instagram" -> cfg("instagram").put("token", "").put("userId", "").put("username", "")
                "youtube" -> cfg("youtube").put("refreshToken", "").put("channelTitle", "")
                "tiktok" -> cfg("tiktok").put("refreshToken", "").put("username", "").put("openId", "")
            }
        }
        youtube.forget()
        tiktok.forget()
    }

    private fun testService(name: String): String = when (name) {
        "claude" -> {
            claude.test()
            "Claude antwortet ✓"
        }
        "fal" -> {
            fal.upload("ok".toByteArray(), null, "text/plain", "test.txt")
            "fal.ai-Schlüssel funktioniert ✓"
        }
        "voice" -> {
            val v = cfg("voice")
            if (v.s("provider") == "openai") {
                val r = Http.request("GET", "https://api.openai.com/v1/models", mapOf("Authorization" to "Bearer " + v.s("openaiKey")))
                if (!r.ok) throw UserError("OpenAI lehnt den Schlüssel ab (${r.code}).")
                "OpenAI-Stimme bereit ✓"
            } else {
                val r = Http.request("GET", "https://api.elevenlabs.io/v1/voices/" + Http.enc(v.s("voiceId")), mapOf("xi-api-key" to v.s("elevenKey")))
                if (r.code == 401) throw UserError("ElevenLabs lehnt den Schlüssel ab.")
                if (!r.ok) throw UserError("ElevenLabs: Stimme nicht gefunden oder Schlüssel ohne Rechte (${r.code}).")
                "ElevenLabs bereit: Stimme „" + r.json().s("name") + "“ ✓"
            }
        }
        "instagram" -> "Instagram: @" + instagram.me().s("username") + " ✓"
        "youtube" -> "YouTube: " + youtube.channel().s("title") + " ✓"
        "tiktok" -> "TikTok: @" + tiktok.user().s("username") + " ✓"
        else -> throw UserError("Unbekannter Dienst.")
    }

    // ---------------------------------------------------------------- Oberfläche (Brücke)

    private fun saveConfig(b: JSONObject) {
        store.edit {
            val conf = store.db.obj("config")
            val sections = b.keys()
            while (sections.hasNext()) {
                val sec = sections.next()
                val src = b.optJSONObject(sec) ?: continue
                val dst = conf.optJSONObject(sec) ?: continue
                val keys = src.keys()
                while (keys.hasNext()) {
                    val k = keys.next()
                    val value = src.get(k)
                    if ("$sec.$k" in Defaults.SECRETS && value is String && value.isBlank()) continue
                    dst.put(k, if (value is String) value.trim() else value)
                }
            }
        }
        youtube.forget()
        tiktok.forget()
    }

    private fun maskedConfig(): JSONObject {
        val c = JSONObject(store.db.obj("config").toString())
        for (path in Defaults.SECRETS) {
            val (sec, key) = path.split(".")
            val o = c.optJSONObject(sec) ?: continue
            val v = o.s(key)
            o.put(key, "")
            o.put(key + "Set", if (v.isEmpty()) "" else "…" + v.takeLast(4))
        }
        return c
    }

    private fun state(): JSONObject = store.read {
        val db = store.db
        val o = JSONObject()
        o.put("config", maskedConfig())
        o.put("topics", JSONArray(db.arr("topics").objects().filter { it.s("status") == "neu" }.sortedByDescending { it.optInt("demand") }))
        val vids = videos().objects().sortedByDescending { it.s("createdAt") }.take(30).map { v ->
            val c = JSONObject(v.toString())
            c.optJSONObject("research")?.remove("text")
            c
        }
        o.put("videos", JSONArray(vids))
        o.put("radar", db.obj("radar"))
        o.put("log", JSONArray(db.arr("log").objects().takeLast(80).reversed()))
        o.put("costs", JSONObject().put("month", db.obj("costs").optJSONObject(Time.month()) ?: JSONObject()).put("budget", cfg("budget").optDouble("monthlyUsd", 60.0)))
        o.put("busy", JSONObject().put("producing", producing.get() ?: "").put("radar", radarRunning.get()).put("publishing", JSONArray(publishing.toList())))
        o.put("platforms", JSONObject().put("instagram", instagram.ready).put("tiktok", tiktok.ready).put("youtube", youtube.ready))
        o.put("missing", jsonArrayOf(missingKeys()))
        o.put("update", db.optJSONObject("update") ?: JSONObject())
        o.put("notice", db.optJSONObject("notice") ?: JSONObject())
        o.put("version", versionName())
        o.put("redirect", Defaults.REDIRECT)
        o.put("pages", Defaults.PAGES)
        o.put("estimate", estimate())
        o.put("batteryOk", batteryOk())
        o.put("steps", jsonArrayOf(STEPS))
        JSONObject(o.toString())
    }

    private fun videoAction(id: String, action: String): Any {
        val v = video(id) ?: throw UserError("Video nicht gefunden.")
        return when (action) {
            "publish" -> {
                if (v.s("finalUrl").isEmpty()) throw UserError("Das Video ist noch nicht fertig.")
                if (targets().isEmpty()) throw UserError("Noch keine Plattform verbunden (Mehr → Plattformen).")
                Notify.cancel(ctx, id.hashCode())
                enqueue(ACT_PUBLISH, id)
                true
            }
            "approve" -> {
                store.edit { v.put("approved", true) }
                resume(v)
            }
            "retry" -> resume(v)
            "discard" -> {
                store.edit {
                    val a = videos()
                    for (i in 0 until a.length()) {
                        if (a.optJSONObject(i)?.s("id") == id) {
                            a.remove(i)
                            break
                        }
                    }
                }
                File(ctx.filesDir, "videos/$id.mp4").delete()
                Notify.cancel(ctx, id.hashCode())
                true
            }
            else -> throw UserError("Unbekannte Aktion.")
        }
    }

    private fun resume(v: JSONObject): Boolean {
        val id = v.s("id")
        if (producing.get() != null && producing.get() != id) throw UserError("Es entsteht gerade ein anderes Video.")
        if (producing.get() == id) return true
        store.edit { v.put("status", "läuft").put("stepText", "Geht weiter …").remove("error") }
        enqueue(ACT_PRODUCE, id)
        return true
    }

    /** Einstieg für die Oberfläche (WebView-Brücke). */
    fun route(method: String, path: String, body: String): Any {
        val b = if (body.isBlank()) JSONObject() else JSONObject(body)
        val p = path.trim('/').split('/')
        return when {
            method == "GET" && path == "/state" -> state()
            method == "POST" && path == "/oneclick" -> {
                val v = startVideo(null)
                enqueue(ACT_PRODUCE, v.s("id"))
                v.s("id")
            }
            method == "POST" && path == "/radar" -> {
                if (!radarRunning.get()) enqueue(ACT_RADAR, null)
                true
            }
            method == "POST" && p.size == 3 && p[0] == "topics" && p[2] == "produce" -> {
                val v = startVideo(p[1])
                enqueue(ACT_PRODUCE, v.s("id"))
                v.s("id")
            }
            method == "POST" && p.size == 3 && p[0] == "videos" -> videoAction(p[1], p[2])
            method == "POST" && path == "/stop" -> {
                stopRequested = true
                true
            }
            method == "POST" && path == "/config" -> {
                saveConfig(b)
                true
            }
            method == "POST" && p.size == 2 && p[0] == "test" -> testService(p[1])
            method == "POST" && p.size == 2 && p[0] == "connect" -> authUrl(p[1])
            method == "POST" && p.size == 2 && p[0] == "disconnect" -> {
                disconnect(p[1])
                true
            }
            method == "POST" && path == "/instagram/token" -> connectInstagram(b.s("token"))
            method == "POST" && path == "/update" -> checkUpdate()
            method == "POST" && path == "/report" -> {
                val g = cfg("github")
                if (g.s("token").isEmpty()) throw UserError("Für Meldungen bitte unter Mehr → Wartung einen GitHub-Token eintragen.")
                report("Meldung aus der App", UserError(b.s("text").take(200).ifEmpty { "Problem gemeldet" }), b.s("text").ifEmpty { "(keine Beschreibung)" })
                "Danke – die Meldung ist auf GitHub angekommen und wird nachts bearbeitet."
            }
            method == "POST" && path == "/notice/seen" -> {
                store.edit { store.db.remove("notice") }
                true
            }
            else -> throw UserError("Unbekannte Aktion: $method $path")
        }
    }
}
