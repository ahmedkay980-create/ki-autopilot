package de.achmo.kiautopilot

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import org.json.JSONObject

/** Benachrichtigungen: Fortschritt, „Video fertig – OK?“, Ergebnisse. */
object Notify {
    const val CH_WORK = "work"
    const val CH_READY = "ready"
    const val ID_WORK = 1

    fun channels(ctx: Context) {
        if (Build.VERSION.SDK_INT >= 26) {
            val nm = ctx.getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(NotificationChannel(CH_WORK, "Arbeit im Hintergrund", NotificationManager.IMPORTANCE_LOW))
            val ready = NotificationChannel(CH_READY, "Fertige Videos und Ergebnisse", NotificationManager.IMPORTANCE_HIGH)
            ready.description = "Meldet, wenn ein Video fertig ist und auf dein OK wartet."
            nm.createNotificationChannel(ready)
        }
    }

    private fun openApp(ctx: Context): PendingIntent = PendingIntent.getActivity(
        ctx, 0,
        Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    fun work(ctx: Context, text: String): Notification =
        NotificationCompat.Builder(ctx, CH_WORK)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("KI-Autopilot arbeitet")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openApp(ctx))
            .build()

    private fun post(ctx: Context, id: Int, n: Notification) {
        try {
            ctx.getSystemService(NotificationManager::class.java).notify(id, n)
        } catch (e: SecurityException) {
            // Benachrichtigungen nicht erlaubt
        }
    }

    fun update(ctx: Context, id: Int, n: Notification) = post(ctx, id, n)

    fun cancel(ctx: Context, id: Int) {
        try {
            ctx.getSystemService(NotificationManager::class.java).cancel(id)
        } catch (e: Exception) {
            // egal
        }
    }

    fun simple(ctx: Context, id: Int, title: String, text: String) {
        val n = NotificationCompat.Builder(ctx, CH_READY)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setAutoCancel(true)
            .setContentIntent(openApp(ctx))
            .build()
        post(ctx, id, n)
    }

    /** „Video fertig“ mit Knopf „OK – hochladen“, der direkt im Hintergrund postet. */
    fun ready(ctx: Context, v: JSONObject, canPost: Boolean) {
        val id = v.s("id")
        val b = NotificationCompat.Builder(ctx, CH_READY)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("Video fertig: " + v.s("title"))
            .setContentText(if (canPost) "Ansehen oder direkt OK tippen – dann geht es auf alle Plattformen." else "Ansehen in der App. Verbinde Plattformen unter Mehr, dann reicht ein OK.")
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(openApp(ctx))
        if (canPost) {
            val pi = if (Build.VERSION.SDK_INT >= 26) {
                PendingIntent.getForegroundService(
                    ctx, id.hashCode(), PipelineService.intent(ctx, Engine.ACT_PUBLISH, id),
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                )
            } else {
                PendingIntent.getService(
                    ctx, id.hashCode(), PipelineService.intent(ctx, Engine.ACT_PUBLISH, id),
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                )
            }
            b.addAction(R.drawable.ic_stat, "OK – überall hochladen", pi)
        }
        post(ctx, id.hashCode(), b.build())
    }
}
