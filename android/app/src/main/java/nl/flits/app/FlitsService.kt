package nl.flits.app

import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import androidx.core.app.ServiceCompat
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.combine

/** Houdt Flits op de achtergrond actief, zodat je ook ontvangt als de app dicht is. */
class FlitsService : Service() {
    private var watcher: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Engine.init(applicationContext)
        ServiceCompat.startForeground(
            this, Notifier.SERVICE_ID, Notifier.serviceNotification(text()),
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
        )
        Engine.start()
        if (watcher == null) {
            watcher = Engine.scope.launch {
                combine(Engine.transfers, Engine.settings) { t, s -> text(t.count { it.isLive }, s.deviceName) }.collect { msg ->
                    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                    nm.notify(Notifier.SERVICE_ID, Notifier.serviceNotification(msg))
                }
            }
        }
        return START_STICKY
    }

    private fun text(active: Int = 0, name: String = Engine.settings.value.deviceName) =
        if (active > 0) "Bezig met $active overdracht" + (if (active > 1) "en" else "") else "Klaar om te ontvangen als \"$name\""

    override fun onDestroy() {
        watcher?.cancel(); watcher = null
        super.onDestroy()
    }

    companion object {
        fun start(ctx: Context) {
            ctx.startForegroundService(Intent(ctx, FlitsService::class.java))
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, FlitsService::class.java))
            Engine.stop()
        }
    }
}
