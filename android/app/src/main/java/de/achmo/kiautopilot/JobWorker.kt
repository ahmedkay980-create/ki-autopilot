package de.achmo.kiautopilot

import android.app.Application
import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters

/**
 * Hintergrundarbeit ohne offene App (WorkManager): stündlicher Rundgang und Fortsetzung langer Aufgaben.
 * Android erlaubt einem Worker etwa 10 Minuten – längere Produktionen pausieren und laufen im nächsten Worker weiter.
 */
class JobWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
    override fun doWork(): Result {
        val e = Engine.get(applicationContext)
        val action = inputData.getString("action") ?: return Result.success()
        val arg = inputData.getString("arg")
        try {
            when (action) {
                Engine.ACT_TICK -> e.autoTick()
                Engine.ACT_PRODUCE -> if (arg != null) {
                    val finished = e.produceJob(arg, System.currentTimeMillis() + 7 * 60_000L)
                    if (!finished) Engine.schedule(applicationContext, Engine.ACT_PRODUCE, arg)
                }
                Engine.ACT_PUBLISH -> if (arg != null) e.publishJob(arg)
                Engine.ACT_RADAR -> e.runJob(Engine.ACT_RADAR, null)
            }
        } catch (ex: Throwable) {
            e.log("warn", "Hintergrund: " + friendly(ex))
        }
        return Result.success()
    }
}

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Notify.channels(this)
        Engine.schedulePeriodic(this)
    }
}
