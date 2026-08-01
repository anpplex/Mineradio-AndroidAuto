package com.motif.wallpaperengine.plugin

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.os.UserManager

/**
 * WP-02 user-action Activity (default plugin process, not `:we_runtime`).
 *
 * Validates operationId/actionEpoch, claims launch lease, then starts the
 * runtime FGS. Does not launch official BrowseActivity (WP-03+ / WP-08).
 * Not a car default launcher entry — no MAIN/LAUNCHER intent-filter.
 */
class PluginActionActivity : Activity() {

    @Volatile
    var repositoryOverride: PluginOperationRepository? = null

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
        // Visible progress is deferred to WP-03+ UI; finish after handoff.
        finish()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        writeOperationIdentity(outState, intent)
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
        if (operationId.isNullOrBlank() || actionEpoch < 0L) {
            return null
        }
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
}
