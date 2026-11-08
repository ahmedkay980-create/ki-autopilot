package de.achmo.kiautopilot

import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

class HttpResponse(val code: Int, val bytes: ByteArray, private val headers: Map<String, List<String>>) {
    val ok: Boolean get() = code in 200..299
    val text: String by lazy { String(bytes, Charsets.UTF_8) }

    fun header(name: String): String? =
        headers.entries.firstOrNull { it.key.equals(name, ignoreCase = true) }?.value?.firstOrNull()

    fun json(): JSONObject = try {
        JSONObject(text)
    } catch (e: Exception) {
        JSONObject().put("_raw", text.take(300))
    }
}

/** Schlanker HTTP-Client ohne Fremdbibliotheken. Wiederholt bei Netzwerkfehlern. */
object Http {
    private const val UA = "android:de.achmo.kiautopilot:1.0"

    fun enc(s: String): String = URLEncoder.encode(s, "UTF-8")

    fun query(params: Map<String, String>): String =
        params.entries.joinToString("&") { enc(it.key) + "=" + enc(it.value) }

    fun request(
        method: String,
        url: String,
        headers: Map<String, String> = emptyMap(),
        body: ByteArray? = null,
        file: File? = null,
        offset: Long = 0,
        length: Long = -1,
        timeoutMs: Int = 120_000,
        retries: Int = 2,
    ): HttpResponse {
        var last: IOException? = null
        for (attempt in 0..retries) {
            try {
                return once(method, url, headers, body, file, offset, length, timeoutMs)
            } catch (e: IOException) {
                last = e
                if (attempt < retries) Thread.sleep(2000L * (attempt + 1))
            }
        }
        throw last ?: IOException("Netzwerkfehler")
    }

    private fun once(
        method: String,
        url: String,
        headers: Map<String, String>,
        body: ByteArray?,
        file: File?,
        offset: Long,
        length: Long,
        timeoutMs: Int,
    ): HttpResponse {
        val c = URL(url).openConnection() as HttpURLConnection
        try {
            c.requestMethod = method
            c.connectTimeout = 30_000
            c.readTimeout = timeoutMs
            c.setRequestProperty("User-Agent", UA)
            for ((k, v) in headers) c.setRequestProperty(k, v)
            if (body != null) {
                c.doOutput = true
                c.setFixedLengthStreamingMode(body.size)
                c.outputStream.use { it.write(body) }
            } else if (file != null) {
                val len = if (length >= 0) length else file.length() - offset
                c.doOutput = true
                c.setFixedLengthStreamingMode(len)
                RandomAccessFile(file, "r").use { raf ->
                    raf.seek(offset)
                    c.outputStream.use { out ->
                        val buf = ByteArray(256 * 1024)
                        var left = len
                        while (left > 0) {
                            val n = raf.read(buf, 0, minOf(buf.size.toLong(), left).toInt())
                            if (n < 0) break
                            out.write(buf, 0, n)
                            left -= n
                        }
                    }
                }
            } else if (method == "POST" || method == "PUT") {
                c.doOutput = true
                c.setFixedLengthStreamingMode(0)
                c.outputStream.close()
            }
            val code = c.responseCode
            val stream: InputStream? = if (code >= 400) c.errorStream else c.inputStream
            val bytes = stream?.use { it.readBytes() } ?: ByteArray(0)
            val h = HashMap<String, List<String>>()
            c.headerFields?.forEach { (k, v) -> if (k != null && v != null) h[k] = v }
            return HttpResponse(code, bytes, h)
        } finally {
            c.disconnect()
        }
    }

    /** Datei herunterladen (in Stücken, ohne alles in den Speicher zu laden). */
    fun download(url: String, target: File) {
        target.parentFile?.mkdirs()
        val tmp = File(target.path + ".part")
        var last: IOException? = null
        for (attempt in 0..2) {
            try {
                val c = URL(url).openConnection() as HttpURLConnection
                c.connectTimeout = 30_000
                c.readTimeout = 120_000
                c.setRequestProperty("User-Agent", UA)
                try {
                    val code = c.responseCode
                    if (code !in 200..299) throw UserError("Download fehlgeschlagen ($code).")
                    c.inputStream.use { inp -> tmp.outputStream().use { out -> inp.copyTo(out, 256 * 1024) } }
                } finally {
                    c.disconnect()
                }
                if (target.exists()) target.delete()
                if (!tmp.renameTo(target)) throw IOException("Datei konnte nicht gespeichert werden.")
                return
            } catch (e: IOException) {
                last = e
                Thread.sleep(2000L * (attempt + 1))
            }
        }
        throw last ?: IOException("Download fehlgeschlagen")
    }
}
