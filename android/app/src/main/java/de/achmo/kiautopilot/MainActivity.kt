package de.achmo.kiautopilot

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject

/** Die Oberfläche ist eine Web-Seite aus den App-Dateien; alle Arbeit passiert in Kotlin (Engine). */
class MainActivity : Activity() {
    private lateinit var web: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val root = FrameLayout(this)
        root.setBackgroundColor(Color.parseColor("#0B0D12"))
        web = WebView(this)
        web.setBackgroundColor(Color.parseColor("#0B0D12"))
        root.addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val b = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            v.setPadding(b.left, b.top, b.right, b.bottom)
            WindowInsetsCompat.CONSUMED
        }

        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
        }
        web.addJavascriptInterface(Bridge(), "Android")
        web.webChromeClient = WebChromeClient()
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                if (u.scheme == "file") return false
                openExternal(u.toString())
                return true
            }
        }
        web.loadUrl("file:///android_asset/www/index.html")

        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 7)
        }
        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        js("window.__resume && window.__resume()")
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        web.evaluateJavascript("(window.__back && window.__back()) ? 'yes' : 'no'") { r ->
            if (r?.contains("yes") != true) moveTaskToBack(true)
        }
    }

    /** Rückkehr aus der Anmeldung im Browser: kiautopilot://oauth?code=…&state=… */
    private fun handleIntent(i: Intent?) {
        if (i == null) return
        val data: Uri = i.data ?: return
        if (data.scheme == "kiautopilot" && data.host == "oauth") {
            i.data = null
            Engine.io.execute {
                try {
                    Engine.get(this).oauthCallback(data)
                } catch (e: Exception) {
                    // Meldung liegt als Hinweis im Zustand
                }
                js("window.__refresh && window.__refresh()")
            }
        }
    }

    private fun js(code: String) {
        runOnUiThread { if (::web.isInitialized) web.evaluateJavascript(code, null) }
    }

    private fun openExternal(url: String) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Exception) {
            js("window.__toast && window.__toast('Kein Browser gefunden')")
        }
    }

    inner class Bridge {
        @JavascriptInterface
        fun call(id: Int, method: String, path: String, body: String) {
            Engine.io.execute {
                val res = JSONObject()
                try {
                    res.put("ok", true).put("data", Engine.get(this@MainActivity).route(method, path, body))
                } catch (e: Throwable) {
                    res.put("ok", false).put("error", friendly(e))
                }
                js("window.__bridge($id, " + JSONObject.quote(res.toString()) + ")")
            }
        }

        @JavascriptInterface
        fun open(url: String) {
            runOnUiThread { openExternal(url) }
        }

        @SuppressLint("BatteryLife")
        @JavascriptInterface
        fun battery() {
            runOnUiThread {
                try {
                    startActivity(
                        Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")),
                    )
                } catch (e: Exception) {
                    try {
                        startActivity(Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
                    } catch (e2: Exception) {
                        js("window.__toast && window.__toast('Bitte in den Android-Einstellungen → Akku die App auf „Nicht einschränken“ stellen')")
                    }
                }
            }
        }

        @JavascriptInterface
        fun share(text: String) {
            runOnUiThread {
                try {
                    val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
                    startActivity(Intent.createChooser(send, "Teilen"))
                } catch (e: Exception) {
                    // egal
                }
            }
        }
    }
}
