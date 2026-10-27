package nl.flits.app

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

@SuppressLint("MissingPermission")
object Notifier {
    const val CH_SERVICE = "service"
    const val CH_OFFER = "offers"
    const val CH_DONE = "done"
    const val ACTION_ACCEPT = "nl.flits.app.ACCEPT"
    const val ACTION_DECLINE = "nl.flits.app.DECLINE"
    const val EXTRA_ID = "id"
    const val SERVICE_ID = 1

    private lateinit var ctx: Context

    fun init(c: Context) {
        ctx = c.applicationContext
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(NotificationChannel(CH_SERVICE, "Flits actief", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Laat zien dat Flits klaarstaat om bestanden te ontvangen"
            setShowBadge(false)
        })
        nm.createNotificationChannel(NotificationChannel(CH_OFFER, "Verzoeken", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Iemand wil je iets sturen"
        })
        nm.createNotificationChannel(NotificationChannel(CH_DONE, "Ontvangen", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "Klaar met ontvangen of versturen"
        })
    }

    private fun openApp(): PendingIntent = PendingIntent.getActivity(
        ctx, 0, Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    fun serviceNotification(text: String): Notification =
        NotificationCompat.Builder(ctx, CH_SERVICE)
            .setSmallIcon(R.drawable.ic_stat_bolt)
            .setContentTitle("Flits")
            .setContentText(text)
            .setContentIntent(openApp())
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()

    private fun nid(id: String) = id.hashCode()

    private fun actionIntent(action: String, id: String): PendingIntent = PendingIntent.getBroadcast(
        ctx, nid(id) + action.hashCode(), Intent(ctx, OfferReceiver::class.java).setAction(action).putExtra(EXTRA_ID, id),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun count(n: Int) = if (n == 1) "1 bestand" else "$n bestanden"

    fun offer(t: Transfer, appVisible: Boolean) {
        if (appVisible) return
        val what = if (t.files.isEmpty()) "een tekst" else count(t.files.size)
        val n = NotificationCompat.Builder(ctx, CH_OFFER)
            .setSmallIcon(R.drawable.ic_stat_bolt)
            .setContentTitle("${t.peerName} wil iets sturen")
            .setContentText(what)
            .setContentIntent(openApp())
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setTimeoutAfter(60_000)
            .addAction(0, "Accepteren", actionIntent(ACTION_ACCEPT, t.id))
            .addAction(0, "Weigeren", actionIntent(ACTION_DECLINE, t.id))
            .build()
        NotificationManagerCompat.from(ctx).notify(nid(t.id), n)
    }

    fun cancelOffer(id: String) = NotificationManagerCompat.from(ctx).cancel(nid(id))

    private fun simple(id: String, title: String, text: String) {
        val n = NotificationCompat.Builder(ctx, CH_DONE)
            .setSmallIcon(R.drawable.ic_stat_bolt)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(openApp())
            .setAutoCancel(true)
            .build()
        NotificationManagerCompat.from(ctx).notify(nid(id) + 1, n)
    }

    fun received(t: Transfer) { if (!Engine.appVisible) simple(t.id, "Ontvangen van ${t.peerName}", count(t.files.size) + " opgeslagen in Downloads/Flits") }
    fun text(t: Transfer) { if (!Engine.appVisible) simple(t.id, "Tekst van ${t.peerName}", (t.text ?: "").take(120)) }
    fun sent(t: Transfer) { if (!Engine.appVisible) simple(t.id, "Verstuurd", count(t.files.size) + " naar ${t.peerName}") }
}

class OfferReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getStringExtra(Notifier.EXTRA_ID) ?: return
        Engine.init(context)
        Engine.respondOffer(id, intent.action == Notifier.ACTION_ACCEPT, false)
        Notifier.cancelOffer(id)
    }
}
