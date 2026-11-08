package de.achmo.kiautopilot

import org.json.JSONArray
import org.json.JSONObject

/** Die Redaktion: Themen aus Signalen, Recherche, Skript, Faktencheck. Schemas kommen aus assets/agents.json. */
class Agents(private val e: Engine) {
    private val defs: JSONObject by lazy {
        JSONObject(e.ctx.assets.open("agents.json").bufferedReader().use { it.readText() })
    }

    private val formats: JSONObject get() = defs.getJSONObject("formats")

    private fun schema(name: String): JSONObject = JSONObject(defs.getJSONObject(name).toString())

    fun system(): String {
        val c = e.cfg("channel")
        return "You are the head writer of \"${c.s("name")}\", a faceless short-video channel: ${c.s("niche")}.\n" +
            "All spoken and on-screen content is in ${c.s("language", "English")}.\n" +
            "Audience: curious non-experts aged 18–40 who want to understand what is happening in AI and tech and how it affects them.\n" +
            "Voice: confident, clear, a little witty. Never hype, never clickbait you cannot back up. Short sentences. Concrete numbers. Explain jargon in five words.\n" +
            "Every video: a hook in the first two seconds (surprising fact, bold but true claim, or sharp question), exactly one idea, a payoff, and a last line that invites a comment.\n" +
            "\n" +
            "Honesty rules – non-negotiable:\n" +
            "- State only facts from the provided fact sheet. Never invent numbers, quotes, dates, benchmarks or product features.\n" +
            "- Company claims are attributed (\"OpenAI says …\"). Rumors are called rumors.\n" +
            "- No financial, medical or legal advice.\n" +
            "- Visual prompts go to an AI video generator: symbolic, cinematic scenes. Never real identifiable people, real company logos, real product interfaces, screenshots or readable text. No violence, no sexual content.\n"
    }

    /** Signale → Themenvorschläge. Ohne Claude: die stärksten Signale direkt. */
    fun topicsFromSignals(signals: List<JSONObject>, recent: List<String>): List<JSONObject> {
        val list = signals.take(60)
        if (!e.claude.ready) {
            return list.take(8).map { s ->
                JSONObject().put("title", s.s("title").take(90)).put("hook", "")
                    .put("angle", "Automatisch aus dem stärksten Signal übernommen (ohne Claude).")
                    .put("whyNow", s.s("label")).put("format", "news60").put("demand", s.optInt("heat"))
                    .put("competition", "mittel").put("evergreen", false).put("evidence", JSONArray().put(s))
            }
        }
        val lines = list.mapIndexed { i, s -> "[$i] (${s.s("source")}, Hitze ${s.optInt("heat")}, ${s.s("label")}) ${s.s("title")}" }
            .joinToString("\n")
        val fm = formats
        val formatList = fm.keys().asSequence().joinToString("; ") { k -> k + " = " + fm.s(k) }
        val covered = if (recent.isNotEmpty()) "Already covered recently – do not repeat:\n- " + recent.joinToString("\n- ") + "\n\n" else ""
        val prompt = "Signals from the last days (heat 0–100 = how fast it is growing within its source):\n$lines\n\n" +
            covered +
            "Formats: $formatList.\n\n" +
            "Pick 8 video topics with the highest potential for this channel. Merge signals about the same story. " +
            "Prefer stories regular people care about over niche developer news. Mix formats. At least one evergreen topic. Rank by demand."
        val out = e.claude.structured(system(), prompt, "propose_topics", "Ranked video topics", schema("topicsSchema"), maxTokens = 3500)
        return (out.optJSONArray("topics")?.objects() ?: emptyList()).map { t ->
            val ev = JSONArray()
            val idx = t.optJSONArray("signals")
            if (idx != null) {
                for (k in 0 until idx.length()) {
                    val i = idx.optInt(k, -1)
                    if (i in list.indices && ev.length() < 4) ev.put(JSONObject(list[i].toString()))
                }
            }
            t.put("evidence", ev)
        }
    }

    fun research(topic: JSONObject): Claude.Research {
        val date = Time.iso().take(10)
        val ev = topic.optJSONArray("evidence")?.objects()?.joinToString("\n") { "- " + it.s("title") + " (" + it.s("url") + ")" } ?: ""
        val prompt = "Today is $date. Topic: ${topic.s("title")}\nAngle: ${topic.s("angle")}\n" +
            (if (ev.isNotEmpty()) "Signals:\n$ev\n" else "") + "\n" +
            "Research this topic with web search. Write a compact fact sheet in English: 8–15 bullet points. " +
            "Each bullet is one concrete fact (numbers, dates, product and company names) followed by its source URL in parentheses. " +
            "Mark anything unconfirmed as (claim) or (rumor). End with one line starting with \"Best angle:\"."
        return e.claude.research(
            "You are a meticulous tech research assistant. You verify facts with primary sources when possible.",
            prompt, maxTokens = 3000, webSearch = e.cfg("trends").optBoolean("webSearch", true), maxUses = 6,
        )
    }

    fun writeScript(topic: JSONObject, factSheet: String, maxScenes: Int): JSONObject {
        val sch = schema("scriptSchema")
        sch.getJSONObject("properties").getJSONObject("scenes").put("maxItems", maxScenes)
        val fmt = topic.s("format", "news60")
        val prompt = "Topic: ${topic.s("title")}\nPlanned hook: ${topic.s("hook")}\nFormat: $fmt = ${formats.s(fmt)}\n" +
            "Angle (German note from the producer): ${topic.s("angle")}\n\n" +
            "FACT SHEET (the only allowed source of facts):\n$factSheet\n\n" +
            "Write the video script. 4–$maxScenes scenes, 110–150 spoken words in total (about 45–55 seconds). Scene 1 is the hook. " +
            "Each visual prompt describes one continuous 6–8 second cinematic shot that symbolizes the narration. " +
            "List every factual claim in \"claims\" and the URLs you relied on in \"sources\" (only URLs from the fact sheet)."
        val out = e.claude.structured(system(), prompt, "write_script", "Short-form video script", sch, maxTokens = 4000)
        val tags = JSONArray()
        (out.optJSONArray("hashtags")?.strings() ?: emptyList())
            .map { it.replace(Regex("^#+"), "").replace(Regex("\\s+"), "") }
            .filter { it.isNotEmpty() }
            .forEach { tags.put(it) }
        out.put("hashtags", tags)
        if ((out.optJSONArray("scenes")?.length() ?: 0) == 0) throw UserError("Claude hat ein leeres Skript geliefert.")
        return out
    }

    fun factCheck(script: JSONObject, factSheet: String): JSONObject {
        val scenes = script.getJSONArray("scenes").objects().mapIndexed { i, s -> "[$i] " + s.s("narration") }.joinToString("\n")
        val prompt = "FACT SHEET:\n$factSheet\n\nSCRIPT SCENES:\n$scenes\n\nCAPTION:\n${script.s("caption")}\n\n" +
            "Check every factual statement. A statement fails if it is not supported by the fact sheet, overstates it, presents a claim or rumor as fact, or has a wrong number or date. " +
            "For each problem give a corrected narration for that scene that stays supported (keep length and tone). " +
            "severity hoch = factually wrong or invented, mittel = overstated, niedrig = style. " +
            "pass is true when no hoch problem would remain after applying your fixes."
        return e.claude.structured(
            "You are a strict fact checker for a tech news channel. You compare a script against its fact sheet. You are not creative; you are precise.",
            prompt, "fact_check", "Fact check result", schema("factcheckSchema"),
            model = e.cfg("anthropic").s("reviewModel", "claude-opus-5-5"), maxTokens = 3000,
        )
    }
}
