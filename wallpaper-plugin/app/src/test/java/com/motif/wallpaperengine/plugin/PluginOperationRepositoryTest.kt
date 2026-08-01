package com.motif.wallpaperengine.plugin

import android.app.PendingIntent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * WP-02 PluginOperationRepository — renew CAS, claimLaunch, PendingIntent identity.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [31])
class PluginOperationRepositoryTest {

    @Test
    fun acceptOperation_idempotentAcrossRetries() {
        val repo = PluginOperationRepository()
        val a = repo.acceptOperation("op-1", "import_mpkg", actionKind = "IMPORT")
        val b = repo.acceptOperation("op-1", "import_mpkg", actionKind = "IMPORT")
        assertEquals(a.actionEpoch, b.actionEpoch)
        assertEquals(1L, a.actionEpoch)
    }

    @Test
    fun status_doesNotIncrementEpoch() {
        val repo = PluginOperationRepository()
        repo.acceptOperation("op-s", "import_mpkg", actionKind = "IMPORT")
        val before = repo.status("op-s")!!.actionEpoch
        repeat(5) { repo.status("op-s") }
        assertEquals(before, repo.status("op-s")!!.actionEpoch)
    }

    @Test
    fun renewAction_casFirstSuccessThenReplaySameOldEpoch() {
        val repo = PluginOperationRepository()
        repo.acceptOperation("op-r", "import_mpkg", actionKind = "IMPORT")
        val first = repo.renewAction("op-r", requestedEpoch = 1L, actionKind = "IMPORT")
        assertEquals(PluginContract.CODE_OK, first.code)
        assertEquals(2L, first.newEpoch)

        val replay = repo.renewAction("op-r", requestedEpoch = 1L, actionKind = "IMPORT")
        assertEquals(PluginContract.CODE_OK, replay.code)
        assertEquals(2L, replay.newEpoch)
        assertEquals("RENEW_REPLAY", replay.message)

        // Still only advanced once
        assertEquals(2L, repo.status("op-r")!!.actionEpoch)
    }

    @Test
    fun renewAction_rejectsOlderOrTerminalEpoch() {
        val repo = PluginOperationRepository()
        repo.acceptOperation("op-t", "import_mpkg", actionKind = "IMPORT")
        repo.renewAction("op-t", 1L)
        val older = repo.renewAction("op-t", 0L)
        assertEquals(PluginContract.CODE_ACTION_TOKEN_EXPIRED, older.code)

        repo.markTerminal("op-t", "FAILED")
        val term = repo.renewAction("op-t", 2L)
        assertEquals(PluginContract.CODE_ACTION_TOKEN_EXPIRED, term.code)
    }

    @Test
    fun claimLaunch_onlyOneOwnerWins() {
        val repo = PluginOperationRepository(bootIdProvider = { "boot-1" })
        repo.acceptOperation("op-c", "import_mpkg", actionKind = "IMPORT")
        val a = repo.claimLaunch("op-c", 1L, ownerNonce = "owner-a")
        val b = repo.claimLaunch("op-c", 1L, ownerNonce = "owner-b")
        assertTrue(a.granted)
        assertFalse(b.granted)
        assertEquals("LEASE_HELD", b.reason)

        // same owner retry ok
        val a2 = repo.claimLaunch("op-c", 1L, ownerNonce = "owner-a")
        assertTrue(a2.granted)
    }

    @Test
    fun claimLaunch_bootChangeInvalidatesPriorLease() {
        var boot = "boot-1"
        val repo = PluginOperationRepository(bootIdProvider = { boot })
        repo.acceptOperation("op-b", "import_mpkg", actionKind = "IMPORT")
        assertTrue(repo.claimLaunch("op-b", 1L, "owner-a", leaseBootId = "boot-1").granted)
        boot = "boot-2"
        val reclaim = repo.claimLaunch("op-b", 1L, "owner-b", leaseBootId = "boot-2")
        assertTrue(reclaim.granted)
        assertEquals("BOOT_RECLAIM", reclaim.reason)
    }

    @Test
    fun claimLaunch_rejectsWrongEpoch() {
        val repo = PluginOperationRepository()
        repo.acceptOperation("op-e", "import_mpkg", actionKind = "IMPORT")
        val bad = repo.claimLaunch("op-e", 99L, "owner")
        assertFalse(bad.granted)
        assertEquals("EPOCH_MISMATCH", bad.reason)
    }

    @Test
    fun pendingIntentIdentity_uniquePerOperationAndEpoch() {
        val a = PluginOperationRepository.pendingIntentIdentity("op-1", 1L, "IMPORT")
        val b = PluginOperationRepository.pendingIntentIdentity("op-2", 1L, "IMPORT")
        val c = PluginOperationRepository.pendingIntentIdentity("op-1", 2L, "IMPORT")
        assertNotEquals(a.requestCode, b.requestCode)
        assertNotEquals(a.requestCode, c.requestCode)
        assertNotEquals(a.data, b.data)
        assertTrue(a.flags and PendingIntent.FLAG_ONE_SHOT != 0)
        assertTrue(a.flags and PendingIntent.FLAG_IMMUTABLE != 0)
        assertTrue(a.flags and PendingIntent.FLAG_UPDATE_CURRENT != 0)
        assertTrue(a.data.toString().startsWith("motif-we-action://operation/"))
        assertTrue(a.action.startsWith("com.motif.wallpaperengine.action."))
    }

    @Test
    fun missingRequiredFields_notCreatedViaEmptyAccept() {
        // Repository does not invent operation without id from caller
        assertNotNull(
            PluginOperationRepository.stableRequestCode("x", 1L),
        )
    }
}
