package com.motif.wallpaperengine.plugin

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import java.util.concurrent.Executors

/**
 * WP-02 runtime FGS on process `:we_runtime`.
 *
 * GREEN-02: starts foreground within 5s of onStartCommand, then runs a bounded
 * executor task that only updates the operation ledger — no file copy / wallpaper
 * apply (WP-03+). Stops itself when idle.
 */
class PluginRuntimeService : Service() {

    private val executor = Executors.newSingleThreadExecutor()

    @Volatile
    var repository: PluginOperationRepository? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ensureForeground()
        val operationId = intent?.getStringExtra(PluginContract.KEY_OPERATION_ID)
        val epoch = intent?.getLongExtra(PluginContract.KEY_ACTION_EPOCH, -1L) ?: -1L
        if (operationId.isNullOrBlank() || epoch < 0) {
            stopForegroundAndSelf(startId)
            return START_NOT_STICKY
        }
        executor.execute {
            try {
                markStagedIfActive(operationId)
            } finally {
                stopForegroundAndSelf(startId)
            }
        }
        return START_NOT_STICKY
    }

    private fun markStagedIfActive(operationId: String) {
        val repo = repository ?: return
        val current = repo.getOperation(operationId) ?: return
        if (current.terminal) return
        // Staging placeholder — mark STAGED without file I/O.
        repo.acceptOperation(
            operationId = operationId,
            method = current.method,
            operationState = "STAGED",
        )
    }

    private fun stopForegroundAndSelf(startId: Int) {
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf(startId)
    }

    private fun ensureForeground() {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Wallpaper Engine Runtime",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Bounded wallpaper plugin runtime work"
                setShowBadge(false)
            }
            nm?.createNotificationChannel(channel)
        }
        startForeground(NOTIFICATION_ID, buildRuntimeNotification())
    }

    private fun buildRuntimeNotification(): Notification {
        val title = "Wallpaper Engine"
        val text = "Processing wallpaper operation"
        val icon = android.R.drawable.stat_sys_download
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
                .setContentTitle(title)
                .setContentText(text)
                .setSmallIcon(icon)
                .setOngoing(true)
                .build()
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
                .setContentTitle(title)
                .setContentText(text)
                .setSmallIcon(icon)
                .setOngoing(true)
                .build()
        }
    }

    override fun onDestroy() {
        executor.shutdownNow()
        super.onDestroy()
    }

    companion object {
        const val CHANNEL_ID = "we_runtime_low"
        const val NOTIFICATION_ID = 4202
    }
}
