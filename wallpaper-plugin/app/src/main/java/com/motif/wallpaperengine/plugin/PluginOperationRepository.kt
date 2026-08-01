package com.motif.wallpaperengine.plugin

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import kotlin.math.absoluteValue

/**
 * WP-02 operation repository: idempotent operations, renew CAS, claimLaunch lease,
 * and one-shot PendingIntent identity helpers.
 *
 * GREEN-02: process-local durable map with MultiProcessDataStore-compatible API
 * surface. Cross-process file-backed DataStore can wrap the same ledger later;
 * unit tests inject [RequestLedger] directly.
 */
class PluginOperationRepository(
    private val ledger: RequestLedger = RequestLedger(),
    private val clockMs: () -> Long = { System.currentTimeMillis() },
    private val bootIdProvider: () -> String = { "boot-default" },
) {
    data class ClaimResult(
        val granted: Boolean,
        val reason: String,
        val ownerNonce: String? = null,
    )

    data class RenewResult(
        val code: Int,
        val message: String,
        val newEpoch: Long? = null,
        val actionKind: String? = null,
    )

    data class PendingIntentIdentity(
        val requestCode: Int,
        val action: String,
        val data: Uri,
        val flags: Int,
    )

    private val lock = ReentrantLock()

    fun ledgerSnapshot(): List<RequestLedger.OperationRecord> = ledger.snapshot()

    fun getOperation(operationId: String): RequestLedger.OperationRecord? =
        ledger.get(operationId)

    /**
     * Idempotent accept: first call creates the operation; repeats return stored state.
     */
    fun acceptOperation(
        operationId: String,
        method: String,
        operationState: String = "ACTION_PENDING",
        sourceUri: String? = null,
        displayName: String? = null,
        actionKind: String? = null,
        actionTtlMs: Long = DEFAULT_ACTION_TTL_MS,
        sourceBytes: Long? = null,
        sourceSha256: String? = null,
    ): RequestLedger.OperationRecord {
        val existing = ledger.get(operationId)
        if (existing != null) {
            return existing
        }
        val now = clockMs()
        val record = RequestLedger.OperationRecord(
            operationId = operationId,
            method = method,
            operationState = operationState,
            bindingState = "UNKNOWN",
            actionEpoch = 1L,
            actionKind = actionKind,
            actionExpiresAtMs = if (actionKind != null) now + actionTtlMs else null,
            sourceUri = sourceUri,
            displayName = displayName,
            sourceBytes = sourceBytes,
            sourceSha256 = sourceSha256,
            sourceOperationId = operationId,
            terminal = false,
        )
        return ledger.putIfAbsent(record)
    }

    /**
     * WP-03: mark copy complete (sourceConsumed) and staged engine path/URI.
     * Does not elevate EffectiveDone / progress — ledger only.
     */
    fun markStaged(
        operationId: String,
        stagedPath: String,
        engineUri: String,
        stagedEntryId: String,
        sourceConsumed: Boolean = true,
    ): RequestLedger.OperationRecord? {
        return ledger.update(operationId) { rec ->
            rec.operationState = "STAGED"
            rec.stagedPath = stagedPath
            rec.engineUri = engineUri
            rec.stagedEntryId = stagedEntryId
            rec.sourceConsumed = sourceConsumed
            rec.sourceOperationId = operationId
            rec.lastError = null
        }
    }

    fun markImporting(operationId: String): RequestLedger.OperationRecord? {
        return ledger.update(operationId) { rec ->
            if (!rec.terminal) {
                rec.operationState = "IMPORTING"
            }
        }
    }

    fun markEngineLaunched(operationId: String): RequestLedger.OperationRecord? {
        return ledger.update(operationId) { rec ->
            if (rec.operationState == "STAGED" || rec.operationState == "ENGINE_LAUNCHED") {
                rec.operationState = "ENGINE_LAUNCHED"
            }
        }
    }

    fun markFailed(operationId: String, lastError: String): RequestLedger.OperationRecord? {
        return markTerminal(operationId, "FAILED", lastError)
    }

    /**
     * renew_action CAS on operationId + requested actionEpoch.
     * First success advances epoch; same old epoch retries return the already-generated result.
     */
    fun renewAction(
        operationId: String,
        requestedEpoch: Long,
        actionKind: String? = null,
        actionTtlMs: Long = DEFAULT_ACTION_TTL_MS,
    ): RenewResult = lock.withLock {
        val current = ledger.get(operationId)
            ?: return tokenExpired("UNKNOWN_OPERATION")

        // Preserve message priority: terminal states before consumed.
        if (isTerminalState(current)) {
            return tokenExpired("TERMINAL")
        }
        if (current.actionConsumed) {
            return tokenExpired("CONSUMED")
        }

        // Already renewed this epoch → return same generated result (no re-increment).
        if (current.renewResultEpoch != null &&
            current.actionEpoch == current.renewResultEpoch &&
            requestedEpoch == current.actionEpoch - 1
        ) {
            return RenewResult(
                code = PluginContract.CODE_OK,
                message = "RENEW_REPLAY",
                newEpoch = current.actionEpoch,
                actionKind = current.actionKind,
            )
        }

        // Exact match on current epoch: first CAS win.
        if (requestedEpoch == current.actionEpoch) {
            val kind = actionKind ?: current.actionKind ?: "GENERIC"
            val nextEpoch = current.actionEpoch + 1L
            val now = clockMs()
            ledger.update(operationId) { rec ->
                rec.actionEpoch = nextEpoch
                rec.actionKind = kind
                rec.actionExpiresAtMs = now + actionTtlMs
                rec.renewResultEpoch = nextEpoch
                rec.renewResultKind = kind
                rec.operationState = "ACTION_PENDING"
            }
            return RenewResult(
                code = PluginContract.CODE_OK,
                message = "RENEWED",
                newEpoch = nextEpoch,
                actionKind = kind,
            )
        }

        // Older / drifted epoch
        return tokenExpired("EPOCH_MISMATCH")
    }

    /**
     * Atomic claimLaunch: only one ownerNonce wins for operationId+actionEpoch+boot.
     */
    fun claimLaunch(
        operationId: String,
        actionEpoch: Long,
        ownerNonce: String,
        leaseBootId: String = bootIdProvider(),
        leaseUntilElapsedMs: Long = clockMs() + DEFAULT_LEASE_TTL_MS,
    ): ClaimResult = lock.withLock {
        val current = ledger.get(operationId)
            ?: return ClaimResult(granted = false, reason = "UNKNOWN_OPERATION")

        if (current.actionEpoch != actionEpoch) {
            return ClaimResult(granted = false, reason = "EPOCH_MISMATCH")
        }
        if (isTerminalState(current) || current.actionConsumed) {
            return ClaimResult(granted = false, reason = "NOT_CLAIMABLE")
        }

        val now = clockMs()
        val existingOwner = current.leaseOwnerNonce
        val existingBoot = current.leaseBootId
        val existingUntil = current.leaseUntilElapsedMs

        // Boot identity change invalidates prior lease.
        if (existingOwner != null && existingBoot != null && existingBoot != leaseBootId) {
            writeLease(operationId, ownerNonce, leaseBootId, leaseUntilElapsedMs)
            return ClaimResult(granted = true, reason = "BOOT_RECLAIM", ownerNonce = ownerNonce)
        }

        if (existingOwner != null &&
            existingUntil != null &&
            existingUntil > now &&
            existingOwner != ownerNonce
        ) {
            return ClaimResult(granted = false, reason = "LEASE_HELD", ownerNonce = existingOwner)
        }

        // Same owner retry or free lease
        writeLease(operationId, ownerNonce, leaseBootId, leaseUntilElapsedMs)
        return ClaimResult(granted = true, reason = "GRANTED", ownerNonce = ownerNonce)
    }

    fun markTerminal(
        operationId: String,
        state: String,
        lastError: String? = null,
    ): RequestLedger.OperationRecord? {
        return ledger.update(operationId) { rec ->
            rec.operationState = state
            rec.terminal = true
            rec.lastError = lastError
            rec.leaseOwnerNonce = null
            rec.leaseUntilElapsedMs = null
        }
    }

    fun markActionConsumed(operationId: String): RequestLedger.OperationRecord? {
        return ledger.update(operationId) { rec ->
            rec.actionConsumed = true
        }
    }

    fun status(operationId: String): RequestLedger.OperationRecord? {
        // status never increments epoch or creates PendingIntent
        return ledger.get(operationId)
    }

    private fun writeLease(
        operationId: String,
        ownerNonce: String,
        leaseBootId: String,
        leaseUntilElapsedMs: Long,
    ) {
        ledger.update(operationId) { rec ->
            rec.leaseOwnerNonce = ownerNonce
            rec.leaseBootId = leaseBootId
            rec.leaseUntilElapsedMs = leaseUntilElapsedMs
        }
    }

    private fun isTerminalState(record: RequestLedger.OperationRecord): Boolean {
        return record.terminal ||
            record.operationState == "FAILED" ||
            record.operationState == "CANCELLED"
    }

    private fun tokenExpired(message: String): RenewResult =
        RenewResult(code = PluginContract.CODE_ACTION_TOKEN_EXPIRED, message = message)

    companion object {
        const val DEFAULT_ACTION_TTL_MS = 10L * 60L * 1000L
        const val DEFAULT_LEASE_TTL_MS = 30L * 1000L
        const val ACTION_URI_SCHEME = "motif-we-action"
        const val ACTION_PREFIX = "com.motif.wallpaperengine.action."

        /**
         * PendingIntent identity: FLAG_ONE_SHOT | FLAG_UPDATE_CURRENT | FLAG_IMMUTABLE
         * unique requestCode / action / data for operationId+actionEpoch.
         */
        fun pendingIntentIdentity(
            operationId: String,
            actionEpoch: Long,
            actionKind: String,
        ): PendingIntentIdentity {
            val action = ACTION_PREFIX + actionKind.uppercase()
            val data = Uri.parse(
                "$ACTION_URI_SCHEME://operation/$operationId/$actionEpoch",
            )
            val requestCode = stableRequestCode(operationId, actionEpoch)
            val flags =
                PendingIntent.FLAG_ONE_SHOT or
                    PendingIntent.FLAG_UPDATE_CURRENT or
                    PendingIntent.FLAG_IMMUTABLE
            return PendingIntentIdentity(
                requestCode = requestCode,
                action = action,
                data = data,
                flags = flags,
            )
        }

        fun stableRequestCode(operationId: String, actionEpoch: Long): Int {
            val material = "$operationId#$actionEpoch"
            // 31-bit positive hash (PendingIntent requestCode is int).
            return (material.hashCode().absoluteValue and 0x7fffffff)
        }

        fun buildActionPendingIntent(
            context: Context,
            operationId: String,
            actionEpoch: Long,
            actionKind: String,
        ): PendingIntent {
            val identity = pendingIntentIdentity(operationId, actionEpoch, actionKind)
            val intent = Intent(context, PluginActionActivity::class.java).apply {
                this.action = identity.action
                this.data = identity.data
                putExtra(PluginContract.KEY_OPERATION_ID, operationId)
                putExtra(PluginContract.KEY_ACTION_EPOCH, actionEpoch)
                putExtra(PluginContract.KEY_USER_ACTION_KIND, actionKind)
            }
            return PendingIntent.getActivity(
                context,
                identity.requestCode,
                intent,
                identity.flags,
            )
        }
    }
}
