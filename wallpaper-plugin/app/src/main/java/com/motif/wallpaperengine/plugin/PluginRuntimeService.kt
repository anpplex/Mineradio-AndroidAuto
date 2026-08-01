package com.motif.wallpaperengine.plugin

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.IBinder
import androidx.core.content.FileProvider
import java.io.File
import java.util.concurrent.Executors

/**
 * WP-02/WP-03 runtime FGS on process `:we_runtime`.
 *
 * Copies sourceUri → plugin_stage via [MpkgStager] on a background executor,
 * marks sourceConsumed + STAGED only after successful stage, builds engineUri
 * with FileProvider. Does not start official BrowseActivity (Activity RESUMED
 * gate owns that).
 *
 * REFACTOR-03: structured early-exit helpers; staging / sourceConsumed timing
 * unchanged.
 */
class PluginRuntimeService : Service() {

    private val executor = Executors.newSingleThreadExecutor()

    @Volatile
    var repository: PluginOperationRepository? = null

    @Volatile
    var stagerFactory: ((File) -> MpkgStager)? = null

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
                stageOperation(operationId)
            } finally {
                stopForegroundAndSelf(startId)
            }
        }
        return START_NOT_STICKY
    }

    private fun stageOperation(operationId: String) {
        val repo = repository ?: PluginOperationRepository().also { repository = it }
        val current = repo.getOperation(operationId) ?: return
        if (current.terminal) return
        if (isAlreadyStaged(current)) return

        repo.markImporting(operationId)

        val sourceUriStr = current.sourceUri
        if (sourceUriStr.isNullOrBlank()) {
            if (current.method == PluginContract.METHOD_IMPORT_MPKG) {
                repo.markFailed(operationId, "SOURCE_URI_MISSING")
            }
            // open_library / apply / next / previous: no .mpkg copy on this path.
            return
        }

        val bytes = current.sourceBytes
        val sha = current.sourceSha256
        val displayName = current.displayName
        if (bytes == null || sha.isNullOrBlank() || displayName.isNullOrBlank()) {
            repo.markFailed(operationId, "IMPORT_METADATA_MISSING")
            return
        }

        val stageRoot = File(filesDir, StagingPolicy.STAGE_DIR_NAME)
        val stager = stagerFactory?.invoke(stageRoot) ?: MpkgStager(stageRoot)

        val stream = openSourceStream(sourceUriStr)
        if (stream == null) {
            repo.markFailed(operationId, "SOURCE_UNREADABLE")
            return
        }

        val result = stream.use { input ->
            stager.stage(
                input = input,
                displayName = displayName,
                expectedBytes = bytes,
                expectedSha256 = sha,
            )
        }

        if (!result.ok || result.staged == null) {
            // Failures never write sourceConsumed (StageResult defaults false).
            repo.markFailed(operationId, result.message)
            return
        }

        val staged = result.staged
        // Only mark sourceConsumed from successful stage result.
        repo.markStaged(
            operationId = operationId,
            stagedPath = staged.absolutePath,
            engineUri = buildEngineUri(File(staged.absolutePath)),
            stagedEntryId = staged.entryId,
            sourceConsumed = result.sourceConsumed,
        )
    }

    private fun isAlreadyStaged(current: RequestLedger.OperationRecord): Boolean {
        return current.operationState == "STAGED" &&
            current.sourceConsumed &&
            !current.engineUri.isNullOrBlank()
    }

    private fun openSourceStream(sourceUriStr: String) = try {
        contentResolver.openInputStream(Uri.parse(sourceUriStr))
    } catch (_: Exception) {
        null
    }

    private fun buildEngineUri(file: File): String {
        return try {
            FileProvider.getUriForFile(
                this,
                StagingPolicy.FILE_PROVIDER_AUTHORITY,
                file,
            ).toString()
        } catch (_: Exception) {
            // Unit/test environments without registered provider: file URI marker
            // for path identity only; production Manifest registers FileProvider.
            @Suppress("DEPRECATION")
            Uri.fromFile(file).toString()
        }
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
        val text = "Staging wallpaper package"
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

    companion object {
        private const val CHANNEL_ID = "we_runtime_staging"
        private const val NOTIFICATION_ID = 20301
    }
}
