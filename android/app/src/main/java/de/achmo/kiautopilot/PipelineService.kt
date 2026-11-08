package de.achmo.kiautopilot

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.ServiceCompat
import java.util.concurrent.atomic.AtomicInteger

/**
 * Vordergrunddienst: hier entsteht das Video und hier wird hochgeladen – auch wenn die App geschlossen ist.
 * Android zeigt dabei eine dauerhafte Benachrichtigung mit dem aktuellen Schritt.
 */
class PipelineService : Service() {
    companion object {
        fun intent(ctx: Context, action: String, arg: String?): Intent =
            Intent(ctx, PipelineService::class.java).setAction(action).putExtra("arg", arg)
    }

    private val running = AtomicInteger(0)
    private var wake: PowerManager.WakeLock? = null
    private val main = Handler(Looper.getMainLooper())

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val type = if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0
        ServiceCompat.startForeground(this, Notify.ID_WORK, Notify.work(this, "Startet …"), type)
        val action = intent?.action
        val arg = intent?.getStringExtra("arg")
        if (action == null) {
            stopIfIdle()
            return START_NOT_STICKY
        }
        if (action == Engine.ACT_PUBLISH && arg != null) Notify.cancel(this, arg.hashCode())
        running.incrementAndGet()
        acquireWake()
        val engine = Engine.get(this)
        engine.onProgress = { text -> Notify.update(this, Notify.ID_WORK, Notify.work(this, text)) }
        Engine.io.execute {
            try {
                engine.runJob(action, arg)
            } catch (e: Throwable) {
                engine.log("error", friendly(e))
            } finally {
                if (running.decrementAndGet() == 0) main.post { stopIfIdle() }
            }
        }
        return START_NOT_STICKY
    }

    private fun acquireWake() {
        if (wake?.isHeld == true) return
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "kiautopilot:job").apply {
            setReferenceCounted(false)
            acquire(90 * 60 * 1000L)
        }
    }

    private fun stopIfIdle() {
        if (running.get() > 0) return
        try {
            wake?.let { if (it.isHeld) it.release() }
        } catch (e: Exception) {
            // egal
        }
        wake = null
        Engine.get(this).onProgress = null
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        try {
            wake?.let { if (it.isHeld) it.release() }
        } catch (e: Exception) {
            // egal
        }
        super.onDestroy()
    }
}
