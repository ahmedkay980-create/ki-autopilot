package de.achmo.kiautopilot

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

/** Fehler mit verständlicher Meldung für die App. */
class UserError(message: String) : Exception(message)

/** Vom Nutzer gestoppt. */
class StoppedError : Exception("Gestoppt")

/** Zeitlimit im Hintergrund erreicht – die Arbeit geht im nächsten Durchlauf weiter. */
class PauseError : Exception("Pausiert")

fun JSONObject.obj(key: String): JSONObject {
    val o = optJSONObject(key)
    if (o != null) return o
    val n = JSONObject()
    put(key, n)
    return n
}

fun JSONObject.arr(key: String): JSONArray {
    val a = optJSONArray(key)
    if (a != null) return a
    val n = JSONArray()
    put(key, n)
    return n
}

/** Text lesen, ohne dass "null" herauskommt. */
fun JSONObject.s(key: String, def: String = ""): String = if (isNull(key)) def else optString(key, def)

fun JSONArray.objects(): List<JSONObject> = (0 until length()).mapNotNull { optJSONObject(it) }

fun JSONArray.strings(): List<String> = (0 until length()).map { optString(it) }

fun jsonArrayOf(items: Collection<Any>): JSONArray {
    val a = JSONArray()
    items.forEach { a.put(it) }
    return a
}

fun newId(): String = UUID.randomUUID().toString().replace("-", "").take(12)

object Time {
    private fun utc(pattern: String): SimpleDateFormat {
        val f = SimpleDateFormat(pattern, Locale.US)
        f.timeZone = TimeZone.getTimeZone("UTC")
        return f
    }

    fun iso(ms: Long = System.currentTimeMillis()): String = utc("yyyy-MM-dd'T'HH:mm:ss'Z'").format(Date(ms))

    fun parse(s: String?): Long {
        if (s.isNullOrEmpty()) return 0L
        val clean = s.replace(Regex("\\.\\d+"), "").replace("+00:00", "Z")
        return try {
            utc("yyyy-MM-dd'T'HH:mm:ss'Z'").parse(clean)?.time ?: 0L
        } catch (e: Exception) {
            0L
        }
    }

    fun month(): String = iso().substring(0, 7)

    fun localDay(ms: Long): String = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date(ms))

    fun ageMs(isoText: String?): Long {
        val t = parse(isoText)
        return if (t == 0L) Long.MAX_VALUE else System.currentTimeMillis() - t
    }

    /** true, wenn die lokale Uhrzeit "HH:mm" schon erreicht ist. */
    fun reached(hhmm: String): Boolean {
        val p = hhmm.split(":")
        val target = (p.getOrNull(0)?.toIntOrNull() ?: 17) * 60 + (p.getOrNull(1)?.toIntOrNull() ?: 0)
        val c = Calendar.getInstance()
        return c.get(Calendar.HOUR_OF_DAY) * 60 + c.get(Calendar.MINUTE) >= target
    }
}

fun friendly(e: Throwable): String = when (e) {
    is UserError -> e.message ?: "Fehler"
    is StoppedError -> "Gestoppt"
    is PauseError -> "Pausiert"
    is UnknownHostException -> "Keine Internetverbindung (Server nicht gefunden)."
    is SocketTimeoutException -> "Zeitüberschreitung – der Dienst hat zu lange nicht geantwortet."
    is IOException -> "Netzwerkfehler: " + (e.message ?: "unbekannt")
    is JSONException -> "Unerwartete Antwort eines Dienstes (" + (e.message ?: "").take(120) + ")."
    else -> e.message ?: e.javaClass.simpleName
}
