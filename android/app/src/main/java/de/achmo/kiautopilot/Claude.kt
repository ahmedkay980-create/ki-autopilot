package de.achmo.kiautopilot

import org.json.JSONArray
import org.json.JSONObject

/** Claude Messages API: strukturierte Antworten über ein erzwungenes Werkzeug, Websuche mit Quellen, Kostenzählung. */
class Claude(private val e: Engine) {
    companion object {
        // US-$ pro 1 Mio. Token (Eingabe, Ausgabe)
        val PRICES = mapOf(
            "claude-haiku-5-5" to doubleArrayOf(0.10, 0.50),
            "claude-sonnet-5-5" to doubleArrayOf(2.0, 10.0),
            "claude-opus-5-5" to doubleArrayOf(4.0, 20.0),
            "claude-fable-5-1" to doubleArrayOf(10.0, 50.0),
        )
        const val SEARCH_USD = 0.01
        private val RETRY = setOf(429, 500, 502, 503, 529)
    }

    class Research(val text: String, val sources: JSONArray) {
        fun toJson(): JSONObject = JSONObject().put("text", text).put("sources", sources)
    }

    val ready: Boolean get() = e.cfg("anthropic").s("apiKey").isNotEmpty()

    private fun defaultModel(): String = e.cfg("anthropic").s("model", "claude-sonnet-5-5")

    fun messages(body: JSONObject): JSONObject {
        val key = e.cfg("anthropic").s("apiKey")
        if (key.isEmpty()) throw UserError("Kein Claude-API-Schlüssel hinterlegt (Mehr → Schlüssel).")
        var lastErr: UserError? = null
        for (attempt in 0 until 4) {
            e.checkStop()
            val r = Http.request(
                "POST", "https://api.anthropic.com/v1/messages",
                mapOf("Content-Type" to "application/json", "x-api-key" to key, "anthropic-version" to "2023-06-01"),
                body.toString().toByteArray(), timeoutMs = 300_000, retries = 1,
            )
            val j = r.json()
            if (r.ok) {
                track(body.s("model"), j.optJSONObject("usage"))
                return j
            }
            val raw = j.optJSONObject("error")?.s("message")?.ifEmpty { null } ?: r.code.toString()
            val msg = when {
                r.code == 401 -> "Claude lehnt den API-Schlüssel ab. Bitte unter Mehr → Schlüssel prüfen."
                r.code == 400 && Regex("credit|billing", RegexOption.IGNORE_CASE).containsMatchIn(raw) ->
                    "Claude: Guthaben aufgebraucht (Claude Console → Billing)."
                else -> "Claude: $raw"
            }
            lastErr = UserError(msg)
            if (r.code !in RETRY) throw lastErr
            e.nap(2000L * (attempt + 1) * (attempt + 1))
        }
        throw lastErr ?: UserError("Claude antwortet nicht.")
    }

    private fun track(model: String, usage: JSONObject?) {
        if (usage == null) return
        val p = PRICES[model] ?: PRICES.getValue("claude-sonnet-5-5")
        val inTok = usage.optLong("input_tokens") + usage.optLong("cache_creation_input_tokens") + usage.optLong("cache_read_input_tokens")
        val outTok = usage.optLong("output_tokens")
        val searches = usage.optJSONObject("server_tool_use")?.optLong("web_search_requests") ?: 0L
        e.addCost("claude", inTok / 1e6 * p[0] + outTok / 1e6 * p[1])
        if (searches > 0) e.addCost("search", searches * SEARCH_USD)
    }

    /** Claude muss das Werkzeug [name] mit JSON nach [schema] aufrufen. */
    fun structured(
        system: String,
        prompt: String,
        name: String,
        description: String,
        schema: JSONObject,
        model: String? = null,
        maxTokens: Int = 4000,
    ): JSONObject {
        val body = JSONObject()
            .put("model", model ?: defaultModel())
            .put("max_tokens", maxTokens)
            .put("system", system)
            .put("messages", JSONArray().put(JSONObject().put("role", "user").put("content", prompt)))
            .put("tools", JSONArray().put(JSONObject().put("name", name).put("description", description).put("input_schema", schema)))
            .put("tool_choice", JSONObject().put("type", "tool").put("name", name))
        val j = messages(body)
        for (b in (j.optJSONArray("content") ?: JSONArray()).objects()) {
            if (b.s("type") == "tool_use" && b.s("name") == name) return b.getJSONObject("input")
        }
        throw UserError("Claude hat keine strukturierte Antwort geliefert.")
    }

    /** Freitext, optional mit Websuche. Liefert Text und alle gefundenen Quellen. */
    fun research(
        system: String?,
        prompt: String,
        model: String? = null,
        maxTokens: Int = 3000,
        webSearch: Boolean = true,
        maxUses: Int = 5,
    ): Research {
        val messages = JSONArray().put(JSONObject().put("role", "user").put("content", prompt))
        val body = JSONObject().put("model", model ?: defaultModel()).put("max_tokens", maxTokens).put("messages", messages)
        if (system != null) body.put("system", system)
        if (webSearch) {
            body.put("tools", JSONArray().put(JSONObject().put("type", "web_search_20250305").put("name", "web_search").put("max_uses", maxUses)))
        }
        val all = mutableListOf<JSONObject>()
        for (turn in 0 until 4) {
            val j = messages(body)
            val content = j.optJSONArray("content") ?: JSONArray()
            all.addAll(content.objects())
            if (j.s("stop_reason") != "pause_turn") break
            messages.put(JSONObject().put("role", "assistant").put("content", content))
        }
        val text = all.filter { it.s("type") == "text" }.joinToString("") { it.s("text") }.trim()
        val sources = LinkedHashMap<String, String>()
        for (b in all) {
            if (b.s("type") == "web_search_tool_result") {
                b.optJSONArray("content")?.objects()?.forEach { r ->
                    val u = r.s("url")
                    if (u.isNotEmpty()) sources[u] = r.s("title").ifEmpty { u }
                }
            }
            b.optJSONArray("citations")?.objects()?.forEach { c ->
                val u = c.s("url")
                if (u.isNotEmpty()) sources[u] = c.s("title").ifEmpty { u }
            }
        }
        val arr = JSONArray()
        sources.forEach { (u, t) -> arr.put(JSONObject().put("url", u).put("title", t)) }
        return Research(text, arr)
    }

    fun test(): String = research(null, "Reply with exactly: ready", maxTokens = 10, webSearch = false).text
}
