package de.achmo.kiautopilot

import org.json.JSONArray
import org.json.JSONObject
import java.net.URL
import java.util.Locale
import java.util.concurrent.Callable
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import kotlin.math.max
import kotlin.math.roundToInt

/** Trend-Radar: was wird gerade viel gesehen und diskutiert? YouTube, Hacker News, Reddit, Claude-Websuche. */
class Trends(private val e: Engine) {
    class Result(val signals: List<JSONObject>, val sources: JSONObject, val errors: List<String>)

    companion object {
        val AI_RE = Regex(
            "\\b(ai|a\\.i\\.|llms?|gpt[-\\d.o]*|chatgpt|openai|anthropic|claude|gemini|deepmind|llama|mistral|copilot|agents?|agentic|neural|machine learning|robots?|robotics|humanoid|nvidia|sora|veo|midjourney|deepseek|grok|xai|transformer|diffusion|chatbot|superintelligence|agi)\\b",
            RegexOption.IGNORE_CASE,
        )
        val LABELS = mapOf("youtube" to "YouTube", "hn" to "Hacker News", "reddit" to "Reddit", "web" to "Websuche")
    }

    private fun nfmt(n: Long): String = when {
        n >= 1_000_000 -> String.format(Locale.GERMAN, "%.1f Mio.", n / 1e6).replace(",0 ", " ")
        n >= 1000 -> "${n / 1000} Tsd."
        else -> n.toString()
    }

    private fun getJson(url: String): JSONObject {
        val r = Http.request("GET", url, mapOf("Accept" to "application/json"))
        val host = URL(url).host
        val j = try {
            JSONObject(r.text)
        } catch (ex: Exception) {
            throw UserError("$host: keine gültige Antwort (${r.code})")
        }
        if (!r.ok) {
            val err = j.optJSONObject("error")?.s("message")?.ifEmpty { null } ?: r.code.toString()
            throw UserError("$host: $err")
        }
        return j
    }

    fun collect(): Result {
        val t = e.cfg("trends")
        val now = System.currentTimeMillis()
        val keywords = t.s("keywords").split(",").map { it.trim() }.filter { it.isNotEmpty() }
        val ytKey = t.s("youtubeKey")
        val tasks = linkedMapOf<String, Callable<List<JSONObject>?>>(
            "youtube" to Callable { if (ytKey.isEmpty()) null else youtube(ytKey, keywords, now) },
            "hn" to Callable { if (t.optBoolean("hn", true)) hackerNews(now) else null },
            "reddit" to Callable { if (t.optBoolean("reddit", true)) reddit(t.s("subreddits"), now) else null },
            "web" to Callable { if (t.optBoolean("webSearch", true) && e.claude.ready) webScan(now) else null },
        )
        val futures = tasks.mapValues { Engine.io.submit(it.value) }
        val sources = JSONObject()
        val errors = mutableListOf<String>()
        val items = mutableListOf<JSONObject>()
        for ((name, f) in futures) {
            try {
                val r = f.get(4, TimeUnit.MINUTES)
                if (r == null) {
                    sources.put(name, JSONObject().put("count", 0).put("skipped", true))
                } else {
                    items.addAll(r)
                    sources.put(name, JSONObject().put("count", r.size))
                }
            } catch (ex: Exception) {
                val cause = (ex as? ExecutionException)?.cause ?: ex
                val msg = friendly(cause)
                sources.put(name, JSONObject().put("count", 0).put("error", msg))
                errors.add((LABELS[name] ?: name) + ": " + msg)
            }
        }
        return Result(score(items), sources, errors)
    }

    private fun youtube(key: String, keywords: List<String>, now: Long): List<JSONObject> {
        val after = Time.iso(now - 7 * 86_400_000L)
        val ids = LinkedHashSet<String>()
        for (q in keywords.take(6)) {
            val j = getJson(
                "https://www.googleapis.com/youtube/v3/search?" + Http.query(
                    mapOf(
                        "part" to "snippet", "type" to "video", "order" to "viewCount", "publishedAfter" to after,
                        "q" to q, "maxResults" to "12", "relevanceLanguage" to "en", "key" to key,
                    ),
                ),
            )
            j.optJSONArray("items")?.objects()?.forEach {
                val id = it.optJSONObject("id")?.s("videoId") ?: ""
                if (id.isNotEmpty()) ids.add(id)
            }
        }
        val out = mutableListOf<JSONObject>()
        for (chunk in ids.toList().chunked(50)) {
            val j = getJson(
                "https://www.googleapis.com/youtube/v3/videos?" +
                    Http.query(mapOf("part" to "snippet,statistics", "id" to chunk.joinToString(","), "key" to key)),
            )
            for (v in j.optJSONArray("items")?.objects() ?: emptyList()) {
                val sn = v.optJSONObject("snippet") ?: continue
                val views = v.optJSONObject("statistics")?.s("viewCount")?.toLongOrNull() ?: 0L
                val ageH = max(1.0, (now - Time.parse(sn.s("publishedAt"))) / 3_600_000.0)
                val days = max(1, (ageH / 24).roundToInt())
                out.add(
                    JSONObject().put("source", "youtube").put("title", sn.s("title"))
                        .put("url", "https://www.youtube.com/watch?v=" + v.s("id")).put("metric", views)
                        .put("label", "${nfmt(views)} Aufrufe in $days Tagen").put("velocity", views / ageH),
                )
            }
        }
        return out
    }

    private fun hackerNews(now: Long): List<JSONObject> {
        val ts = (now - 48 * 3_600_000L) / 1000
        val j = getJson("https://hn.algolia.com/api/v1/search?tags=story&numericFilters=created_at_i%3E$ts%2Cpoints%3E40&hitsPerPage=100")
        return (j.optJSONArray("hits")?.objects() ?: emptyList())
            .filter { it.s("title").isNotEmpty() && AI_RE.containsMatchIn(it.s("title")) }
            .map { h ->
                val points = h.optLong("points")
                val ageH = max(1.0, (now / 1000.0 - h.optLong("created_at_i")) / 3600.0)
                JSONObject().put("source", "hn").put("title", h.s("title"))
                    .put("url", h.s("url").ifEmpty { "https://news.ycombinator.com/item?id=" + h.s("objectID") })
                    .put("metric", points).put("label", "$points Punkte, ${h.optInt("num_comments")} Kommentare")
                    .put("velocity", points / ageH)
            }
    }

    private fun reddit(subs: String, now: Long): List<JSONObject> {
        val j = getJson("https://www.reddit.com/r/" + subs.replace(" ", "") + "/top.json?t=day&limit=60")
        return (j.optJSONObject("data")?.optJSONArray("children")?.objects() ?: emptyList())
            .mapNotNull { it.optJSONObject("data") }
            .filter { it.optLong("score") > 150 && !it.optBoolean("stickied") && !it.optBoolean("over_18") }
            .map { d ->
                val score = d.optLong("score")
                val ageH = max(1.0, (now / 1000.0 - d.optDouble("created_utc", now / 1000.0)) / 3600.0)
                JSONObject().put("source", "reddit").put("title", d.s("title"))
                    .put("url", "https://www.reddit.com" + d.s("permalink")).put("metric", score)
                    .put("label", "${nfmt(score)} Upvotes in r/${d.s("subreddit")}").put("velocity", score / ageH)
            }
    }

    private fun webScan(now: Long): List<JSONObject> {
        val date = Time.iso(now).take(10)
        val r = e.claude.research(
            null,
            "Today is $date. Use web search to find the 10 most talked-about AI and tech stories, launches or viral AI tools of the last 48 hours that regular people care about. " +
                "Return ONLY a JSON array, no prose: [{\"title\":\"...\",\"summary\":\"one sentence\",\"url\":\"source url\",\"buzz\":\"why people talk about it, with a number if possible\"}]",
            maxTokens = 2500, maxUses = 5,
        )
        val arr = extractArray(r.text) ?: return emptyList()
        return arr.objects().filter { it.s("title").isNotEmpty() }.take(12).mapIndexed { i, x ->
            val url = x.s("url").ifEmpty { r.sources.optJSONObject(i)?.s("url") ?: "" }
            val label = x.s("buzz").ifEmpty { x.s("summary").ifEmpty { "in den News" } }
            JSONObject().put("source", "web").put("title", x.s("title")).put("url", url).put("label", label).put("summary", x.s("summary"))
        }
    }

    private fun extractArray(text: String): JSONArray? {
        val a = text.indexOf('[')
        val b = text.lastIndexOf(']')
        if (a < 0 || b <= a) return null
        return try {
            JSONArray(text.substring(a, b + 1))
        } catch (ex: Exception) {
            null
        }
    }

    /** Innerhalb jeder Quelle nach Tempo ranken und auf 0–100 abbilden, damit Quellen vergleichbar werden. */
    private fun score(items: List<JSONObject>): List<JSONObject> {
        for ((_, list) in items.groupBy { it.s("source") }) {
            val ranked = list.filter { it.has("velocity") }.sortedByDescending { it.optDouble("velocity") }
            ranked.forEachIndexed { i, x -> x.put("heat", (100 - (i.toDouble() / max(1, ranked.size)) * 70).roundToInt()) }
            list.filter { !it.has("velocity") }.forEachIndexed { i, x -> x.put("heat", max(40, 80 - i * 4)) }
        }
        val seen = HashSet<String>()
        return items
            .filter { seen.add(it.s("title").lowercase().replace(Regex("[^a-z0-9]+"), " ").trim().take(60)) }
            .sortedByDescending { it.optInt("heat") }
    }
}
