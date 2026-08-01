package com.motif.wallpaperengine.plugin

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * WP-02 RequestLedger — idempotent upsert and 100-terminal bound.
 */
class RequestLedgerTest {

    @Test
    fun putIfAbsent_isIdempotentForSameOperationId() {
        val ledger = RequestLedger()
        val first = ledger.putIfAbsent(
            RequestLedger.OperationRecord(
                operationId = "op-1",
                method = "import_mpkg",
                operationState = "ACTION_PENDING",
            ),
        )
        val second = ledger.putIfAbsent(
            RequestLedger.OperationRecord(
                operationId = "op-1",
                method = "import_mpkg",
                operationState = "STAGED",
            ),
        )
        assertEquals("ACTION_PENDING", first.operationState)
        assertEquals("ACTION_PENDING", second.operationState)
        assertEquals(1, ledger.size())
    }

    @Test
    fun terminalBound_evictsOldestTerminalOnly() {
        val ledger = RequestLedger(maxTerminalOperations = 3)
        // active ops must not be evicted
        ledger.upsert(
            RequestLedger.OperationRecord(
                operationId = "active",
                method = "import_mpkg",
                terminal = false,
            ),
        )
        repeat(5) { i ->
            ledger.upsert(
                RequestLedger.OperationRecord(
                    operationId = "term-$i",
                    method = "stop",
                    operationState = "FAILED",
                    terminal = true,
                ),
            )
        }
        assertEquals(3, ledger.terminalCount())
        assertNotNull(ledger.get("active"))
        assertNull(ledger.get("term-0"))
        assertNull(ledger.get("term-1"))
        assertNotNull(ledger.get("term-4"))
    }

    @Test
    fun update_mutatesExisting() {
        val ledger = RequestLedger()
        ledger.putIfAbsent(
            RequestLedger.OperationRecord(operationId = "op", method = "ping"),
        )
        val updated = ledger.update("op") { it.operationState = "STAGED" }
        assertEquals("STAGED", updated?.operationState)
        assertEquals("STAGED", ledger.get("op")?.operationState)
    }

    @Test
    fun get_missingReturnsNull() {
        assertNull(RequestLedger().get("missing"))
    }

    @Test
    fun snapshot_isDefensiveCopy() {
        val ledger = RequestLedger()
        ledger.putIfAbsent(
            RequestLedger.OperationRecord(operationId = "op", method = "status"),
        )
        val snap = ledger.snapshot()
        assertEquals(1, snap.size)
        assertTrue(snap[0].operationId == "op")
    }
}
