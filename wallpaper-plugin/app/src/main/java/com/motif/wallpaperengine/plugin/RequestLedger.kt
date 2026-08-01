package com.motif.wallpaperengine.plugin

import java.util.LinkedHashMap
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * WP-02 bounded in-process request ledger for operation records.
 *
 * Terminal operations are capped at [MAX_TERMINAL_OPERATIONS] (oldest first).
 * Active / pending operations are never evicted by the terminal bound.
 * Full multi-process durability is owned by [PluginOperationRepository].
 */
class RequestLedger(
    private val maxTerminalOperations: Int = MAX_TERMINAL_OPERATIONS,
) {
    data class OperationRecord(
        val operationId: String,
        val method: String,
        var operationState: String = "IDLE",
        var bindingState: String = "UNKNOWN",
        var actionEpoch: Long = 0L,
        var actionKind: String? = null,
        var actionExpiresAtMs: Long? = null,
        var sourceUri: String? = null,
        var displayName: String? = null,
        var lastError: String? = null,
        var terminal: Boolean = false,
        var renewResultEpoch: Long? = null,
        var renewResultKind: String? = null,
        var leaseOwnerNonce: String? = null,
        var leaseBootId: String? = null,
        var leaseUntilElapsedMs: Long? = null,
        var actionConsumed: Boolean = false,
    )

    private val lock = ReentrantLock()
    private val byId = LinkedHashMap<String, OperationRecord>()

    fun get(operationId: String): OperationRecord? = lock.withLock {
        byId[operationId]?.copy()
    }

    fun upsert(record: OperationRecord): OperationRecord = lock.withLock {
        val stored = record.copy()
        byId[record.operationId] = stored
        evictTerminalIfNeeded()
        stored.copy()
    }

    fun putIfAbsent(record: OperationRecord): OperationRecord = lock.withLock {
        val existing = byId[record.operationId]
        if (existing != null) {
            return@withLock existing.copy()
        }
        val stored = record.copy()
        byId[record.operationId] = stored
        evictTerminalIfNeeded()
        stored.copy()
    }

    fun update(operationId: String, mutator: (OperationRecord) -> Unit): OperationRecord? =
        lock.withLock {
            val current = byId[operationId] ?: return@withLock null
            mutator(current)
            evictTerminalIfNeeded()
            current.copy()
        }

    fun snapshot(): List<OperationRecord> = lock.withLock {
        byId.values.map { it.copy() }
    }

    fun size(): Int = lock.withLock { byId.size }

    fun terminalCount(): Int = lock.withLock {
        byId.values.count { it.terminal }
    }

    private fun evictTerminalIfNeeded() {
        var terminal = byId.entries.filter { it.value.terminal }
        while (terminal.size > maxTerminalOperations) {
            val oldest = terminal.first()
            byId.remove(oldest.key)
            terminal = byId.entries.filter { it.value.terminal }
        }
    }

    companion object {
        const val MAX_TERMINAL_OPERATIONS = 100
    }
}
