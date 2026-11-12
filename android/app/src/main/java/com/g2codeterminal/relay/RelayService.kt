package com.g2codeterminal.relay

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * Keeps the relay alive while the activity is not visible: runs the broker,
 * holds the browser session open, and keeps the CPU and Wi-Fi awake with the
 * screen off. Started by MainActivity, stopped by its 退出 button.
 */
class RelayService : Service() {
    private lateinit var broker: Broker
    private var wake: PowerManager.WakeLock? = null
    private var wifi: WifiManager.WifiLock? = null
    private val onStatus: () -> Unit = { refresh() }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        getSystemService(NotificationManager::class.java)
            .createNotificationChannel(NotificationChannel(CHANNEL, "Relay", NotificationManager.IMPORTANCE_LOW))
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIFICATION_ID, notification())
        }
        wake = getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "G2Relay:relay")
            .apply {
                setReferenceCounted(false)
                acquire()
            }
        @Suppress("DEPRECATION")
        val wifiMode = if (Build.VERSION.SDK_INT >= 29) WifiManager.WIFI_MODE_FULL_LOW_LATENCY else WifiManager.WIFI_MODE_FULL_HIGH_PERF
        wifi = applicationContext.getSystemService(WifiManager::class.java)
            .createWifiLock(wifiMode, "G2Relay:relay")
            .apply {
                setReferenceCounted(false)
                acquire()
            }
        broker = Broker(BROKER_PORT).also { it.start() }
        Relay.session(this)
        Relay.listeners += onStatus
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int) = START_STICKY

    override fun onDestroy() {
        Relay.listeners -= onStatus
        broker.stop(500)
        wake?.release()
        wifi?.release()
        super.onDestroy()
    }

    private fun notification(): Notification {
        val s = Relay.status
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle("G2 Relay")
            .setContentText(statusLine(s))
            .setContentIntent(open)
            .setOngoing(true)
            .build()
    }

    private fun refresh() = getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification())

    companion object {
        private const val CHANNEL = "relay"
        private const val NOTIFICATION_ID = 1
    }
}

fun statusLine(s: Relay.Status) = "眼镜 ${if (s.glasses) "✓" else "✗"}  页面 ${if (s.page) "✓" else "✗"}  ${s.phase}"
