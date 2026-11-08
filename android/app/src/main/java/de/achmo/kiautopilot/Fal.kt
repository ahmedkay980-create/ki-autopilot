package de.achmo.kiautopilot

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** fal.ai: Warteschlange (KI-Szenen, Schnitt, Untertitel) und Dateispeicher (öffentliche Links). */
class Fal(private val e: Engine) {
    private fun key(): String =
        e.cfg("video").s("falKey").ifEmpty { throw UserError("Kein fal.ai-Schlüssel hinterlegt (Mehr → Schlüssel).") }

    private fun headers() = mapOf("Authorization" to "Key " + key(), "Content-Type" to "application/json")

    fun call(method: String, url: String, body: JSONObject? = null): JSONObject {
        val r = Http.request(method, url, headers(), body?.toString()?.toByteArray(), retries = if (method == "GET") 3 else 1)
        val j = r.json()
        if (!r.ok) throw UserError("fal.ai: " + detail(j, r.code))
        return j
    }

    private fun detail(j: JSONObject, code: Int): String {
        val d = j.opt("detail")
        val text = when (d) {
            is JSONArray -> d.objects().joinToString("; ") { it.s("msg", it.toString()) }.ifEmpty { d.toString() }
            is JSONObject -> d.s("message", d.toString())
            is String -> d
            else -> j.s("error", j.s("_raw", "Fehler $code"))
        }
        val full = if (code == 401 || code == 403) "Schlüssel abgelehnt oder kein Guthaben ($text)" else text
        return full.take(300)
    }

    fun submit(model: String, input: JSONObject): JSONObject {
        val j = call("POST", "https://queue.fal.run/$model", input)
        if (j.s("status_url").isEmpty() || j.s("response_url").isEmpty()) throw UserError("fal.ai: keine Auftragsnummer erhalten.")
        return j
    }

    fun status(statusUrl: String): JSONObject = call("GET", statusUrl)

    /** Auftrag stellen und auf das Ergebnis warten. */
    fun run(model: String, input: JSONObject, timeoutMs: Long = 15 * 60_000L): JSONObject {
        val h = submit(model, input)
        val start = System.currentTimeMillis()
        var i = 0
        while (true) {
            val st = status(h.s("status_url"))
            if (st.s("status") == "COMPLETED") break
            if (System.currentTimeMillis() - start > timeoutMs) throw UserError("fal.ai: Zeitüberschreitung bei $model")
            e.nap(if (i++ < 5) 3000L else 6000L)
        }
        return call("GET", h.s("response_url"))
    }

    /** Datei in den fal-Speicher legen. Liefert eine öffentliche Adresse. */
    fun upload(bytes: ByteArray?, file: File?, contentType: String, fileName: String): String {
        val init = JSONObject().put("content_type", contentType).put("file_name", fileName).toString().toByteArray()
        var r = Http.request("POST", "https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3", headers(), init)
        if (!r.ok && r.code != 401 && r.code != 403) {
            r = Http.request("POST", "https://rest.alpha.fal.ai/storage/upload/initiate", headers(), init)
        }
        val j = r.json()
        if (!r.ok) throw UserError("fal.ai-Speicher: " + detail(j, r.code))
        val up = j.s("upload_url")
        val fileUrl = j.s("file_url")
        if (up.isEmpty() || fileUrl.isEmpty()) throw UserError("fal.ai-Speicher: keine Upload-Adresse erhalten.")
        val put = Http.request("PUT", up, mapOf("Content-Type" to contentType), body = bytes, file = file, timeoutMs = 300_000, retries = 1)
        if (!put.ok) throw UserError("fal.ai-Speicher: Upload abgelehnt (${put.code}).")
        return fileUrl
    }
}
