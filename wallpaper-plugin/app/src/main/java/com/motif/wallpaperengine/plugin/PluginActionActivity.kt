package com.motif.wallpaperengine.plugin

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.UserManager

/**
 * WP-02/WP-03 user-action Activity (default plugin process, not `:we_runtime`).
 *
 * Claims launch lease, starts runtime FGS for staging, then — only while RESUMED —
 * may launch official BrowseActivity for a staged engineUri. Background must not
 * start the official Activity (fail-closed).
 *
 * REFACTOR-03: no public API change; RESUMED-only launch gate preserved.
 */
class PluginActionActivity : Activity() {

    @Volatile
    var repositoryOverride: PluginOperationRepository? = null

    @Volatile
    var engineAdapterOverride: EngineAdapter? = null

    @Volatile
    private var resumed: Boolean = false

    private val mainHandler = Handler(Looper.getMainLooper())
    private var pollAttempts = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (!isUserUnlocked()) {
            finish()
            return
        }

        val identity = readOperationIdentity(intent, savedInstanceState)
        if (identity == null) {
            finish()
            return
        }

        val repo = repositoryOverride ?: PluginOperationRepository()
        val claim = repo.claimLaunch(
            operationId = identity.operationId,
            actionEpoch = identity.actionEpoch,
            ownerNonce = "activity-${System.identityHashCode(this)}",
        )
        if (!claim.granted) {
            finish()
            return
        }

        startForegroundService(
            Intent(this, PluginRuntimeService::class.java).apply {
                putExtra(PluginContract.KEY_OPERATION_ID, identity.operationId)
                putExtra(PluginContract.KEY_ACTION_EPOCH, identity.actionEpoch)
            },
        )

        // Poll briefly for STAGED; launch only while RESUMED.
        pollAttempts = 0
        scheduleStagePoll(identity.operationId)
    }

    override fun onResume() {
        super.onResume()
        resumed = true
    }

    override fun onPause() {
        resumed = false
        super.onPause()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        writeOperationIdentity(outState, intent)
    }

    private fun scheduleStagePoll(operationId: String) {
        mainHandler.postDelayed({
            if (isFinishing) return@postDelayed
            val repo = repositoryOverride ?: return@postDelayed finish()
            val record = repo.getOperation(operationId)
            if (record == null) {
                finish()
                return@postDelayed
            }
            if (record.operationState == "FAILED" || record.terminal) {
                finish()
                return@postDelayed
            }
            if (record.operationState == "STAGED" && !record.engineUri.isNullOrBlank()) {
                if (resumed) {
                    tryLaunchEngine(repo, operationId, record.engineUri!!)
                }
                // If not resumed: keep STAGED; Mineradio renews action later.
                finish()
                return@postDelayed
            }
            pollAttempts += 1
            if (pollAttempts >= MAX_POLL_ATTEMPTS) {
                // Leave STAGED/IMPORTING for later renew; do not fake PREVIEW_READY.
                finish()
                return@postDelayed
            }
            scheduleStagePoll(operationId)
        }, POLL_INTERVAL_MS)
    }

    private fun tryLaunchEngine(
        repo: PluginOperationRepository,
        operationId: String,
        engineUriStr: String,
    ) {
        if (!resumed) return
        val adapter = engineAdapterOverride ?: EngineAdapter()
        val uri = Uri.parse(engineUriStr)
        val resolved = adapter.resolveLaunch(this, uri)
        if (!resolved.ok || resolved.plan == null) {
            // Keep STAGED for explicit retry — never PREVIEW_READY.
            return
        }
        try {
            adapter.grantEngineRead(this, uri)
            startActivity(resolved.plan.intent)
            repo.markEngineLaunched(operationId)
            repo.markActionConsumed(operationId)
        } catch (_: Exception) {
            // fail-closed: leave STAGED
        }
    }

    private fun isUserUnlocked(): Boolean {
        val um = getSystemService(UserManager::class.java) ?: return true
        return um.isUserUnlocked
    }

    private data class OperationIdentity(
        val operationId: String,
        val actionEpoch: Long,
    )

    private fun readOperationIdentity(
        intent: Intent?,
        savedInstanceState: Bundle?,
    ): OperationIdentity? {
        val operationId = intent?.getStringExtra(PluginContract.KEY_OPERATION_ID)
            ?: savedInstanceState?.getString(PluginContract.KEY_OPERATION_ID)
        val actionEpoch = when {
            intent?.hasExtra(PluginContract.KEY_ACTION_EPOCH) == true ->
                intent.getLongExtra(PluginContract.KEY_ACTION_EPOCH, -1L)
            savedInstanceState?.containsKey(PluginContract.KEY_ACTION_EPOCH) == true ->
                savedInstanceState.getLong(PluginContract.KEY_ACTION_EPOCH, -1L)
            else -> -1L
        }
        if (operationId.isNullOrBlank() || actionEpoch < 0) return null
        return OperationIdentity(operationId, actionEpoch)
    }

    private fun writeOperationIdentity(outState: Bundle, intent: Intent?) {
        intent?.getStringExtra(PluginContract.KEY_OPERATION_ID)?.let {
            outState.putString(PluginContract.KEY_OPERATION_ID, it)
        }
        if (intent?.hasExtra(PluginContract.KEY_ACTION_EPOCH) == true) {
            outState.putLong(
                PluginContract.KEY_ACTION_EPOCH,
                intent.getLongExtra(PluginContract.KEY_ACTION_EPOCH, -1L),
            )
        }
    }

    companion object {
        private const val POLL_INTERVAL_MS = 50L
        private const val MAX_POLL_ATTEMPTS = 40
    }
}
