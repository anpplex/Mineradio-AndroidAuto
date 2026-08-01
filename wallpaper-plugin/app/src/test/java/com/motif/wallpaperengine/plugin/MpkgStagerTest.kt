package com.motif.wallpaperengine.plugin

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayInputStream
import java.security.MessageDigest

/**
 * WP-03 MpkgStager / StagingPolicy unit tests.
 */
class MpkgStagerTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private val policy = StagingPolicy()

    @Test
    fun validateMetadata_requiresMpkgSuffix() {
        val r = policy.validateMetadata("wall.png", 2048, "a".repeat(64))
        assertFalse(r.ok)
        assertEquals(PluginContract.CODE_PACKAGE_INVALID, r.code)
    }

    @Test
    fun validateMetadata_stripsDirectoryPrefixToBasename() {
        // Path prefixes are stripped; only basename is staged (fail-closed vs path traversal).
        val r = policy.validateMetadata("../escape.mpkg", 2048, "ab".repeat(32))
        assertTrue(r.ok)
        assertEquals("escape.mpkg", r.sanitizedName)
    }

    @Test
    fun validateMetadata_rejectsDotDotAndEmptyBasenames() {
        assertFalse(policy.validateMetadata("..", 2048, "ab".repeat(32)).ok)
        assertFalse(policy.validateMetadata(".", 2048, "ab".repeat(32)).ok)
        assertFalse(policy.validateMetadata("", 2048, "ab".repeat(32)).ok)
        assertFalse(policy.validateMetadata("   ", 2048, "ab".repeat(32)).ok)
    }

    @Test
    fun validateMetadata_rejectsShortBytes() {
        val r = policy.validateMetadata("a.mpkg", 100, "a".repeat(64))
        assertFalse(r.ok)
        assertEquals("BYTES_OUT_OF_RANGE", r.message)
    }

    @Test
    fun validateMetadata_rejectsBadSha() {
        val r = policy.validateMetadata("a.mpkg", 2048, "ZZ")
        assertFalse(r.ok)
        assertEquals("SHA256_INVALID", r.message)
    }

    @Test
    fun validateMetadata_acceptsLegalPackage() {
        val r = policy.validateMetadata("Scene_01.mpkg", 2048, "ab".repeat(32))
        assertTrue(r.ok)
        assertEquals("Scene_01.mpkg", r.sanitizedName)
    }

    @Test
    fun admit_neverEvictsInFlightOrCurrent() {
        val entries = listOf(
            StagingPolicy.StageEntry("a.mpkg", 1024, inFlight = true, lastAccessMs = 1),
            StagingPolicy.StageEntry("b.mpkg", 1024, current = true, lastAccessMs = 2),
        )
        // Force quota pressure with huge newBytes near 2GiB and filled protected set.
        // With only protected entries and MAX_ENTRIES=8, still room — fill to 8 protected.
        val full = (1..8).map {
            StagingPolicy.StageEntry(
                id = "p$it.mpkg",
                bytes = 1024L,
                inFlight = true,
                lastAccessMs = it.toLong(),
            )
        }
        val decision = policy.admit(full, newBytes = 2048)
        assertFalse(decision.ok)
        assertEquals(PluginContract.CODE_STAGING_QUOTA_EXCEEDED, decision.code)
        assertTrue(decision.evictIds.isEmpty())
    }

    @Test
    fun admit_evictsLruUnprotected() {
        val entries = (1..8).map {
            StagingPolicy.StageEntry(
                id = "e$it.mpkg",
                bytes = 1024L,
                inFlight = false,
                current = false,
                lastAccessMs = it.toLong(),
            )
        }
        val decision = policy.admit(entries, newBytes = 2048)
        assertTrue(decision.ok)
        assertEquals(listOf("e1.mpkg"), decision.evictIds)
    }

    @Test
    fun stage_happyPath_setsSourceConsumed() {
        val payload = ByteArray(2048) { 7 }
        val sha = sha256Hex(payload)
        val stager = MpkgStager(tmp.newFolder("plugin_stage"))
        val result = stager.stage(
            input = ByteArrayInputStream(payload),
            displayName = "demo.mpkg",
            expectedBytes = payload.size.toLong(),
            expectedSha256 = sha,
        )
        assertTrue(result.ok)
        assertTrue(result.sourceConsumed)
        assertEquals("STAGED", result.message)
        assertEquals(payload.size.toLong(), result.staged!!.bytes)
        assertEquals(sha, result.staged!!.sha256)
        assertTrue(java.io.File(result.staged!!.absolutePath).exists())
    }

    @Test
    fun stage_shaMismatch_deletesPart() {
        val payload = ByteArray(2048) { 1 }
        val stager = MpkgStager(tmp.newFolder("plugin_stage2"))
        val result = stager.stage(
            input = ByteArrayInputStream(payload),
            displayName = "bad.mpkg",
            expectedBytes = payload.size.toLong(),
            expectedSha256 = "0".repeat(64),
        )
        assertFalse(result.ok)
        assertEquals("SHA256_MISMATCH", result.message)
        assertEquals(0, stager.listEntries().size)
        val parts = stager.ensureStageRoot().listFiles()?.filter { it.name.endsWith(".part") }
        assertTrue(parts.isNullOrEmpty())
    }

    @Test
    fun stage_bytesMismatch_failClosed() {
        val payload = ByteArray(2048) { 2 }
        val sha = sha256Hex(payload)
        val stager = MpkgStager(tmp.newFolder("plugin_stage3"))
        val result = stager.stage(
            input = ByteArrayInputStream(payload),
            displayName = "size.mpkg",
            expectedBytes = 4096,
            expectedSha256 = sha,
        )
        assertFalse(result.ok)
        assertEquals("BYTES_MISMATCH", result.message)
    }

    @Test
    fun cleanupOrphanParts_removesOld() {
        val root = tmp.newFolder("plugin_stage4")
        val part = java.io.File(root, "orphan.mpkg.part")
        part.writeBytes(ByteArray(16))
        part.setLastModified(System.currentTimeMillis() - StagingPolicy.PART_TTL_MS - 1000)
        val stager = MpkgStager(root)
        val n = stager.cleanupOrphanParts()
        assertEquals(1, n)
        assertFalse(part.exists())
    }

    @Test
    fun stage_failureNeverSetsSourceConsumed() {
        val payload = ByteArray(2048) { 3 }
        val stager = MpkgStager(tmp.newFolder("plugin_stage5"))
        val result = stager.stage(
            input = ByteArrayInputStream(payload),
            displayName = "fail.mpkg",
            expectedBytes = payload.size.toLong(),
            expectedSha256 = "0".repeat(64),
        )
        assertFalse(result.ok)
        assertFalse(result.sourceConsumed)
        assertEquals(null, result.staged)
    }

    @Test
    fun stage_refusesOverwriteOfProtectedEntry() {
        val root = tmp.newFolder("plugin_stage6")
        val existing = java.io.File(root, "keep.mpkg")
        existing.writeBytes(ByteArray(2048) { 9 })
        val payload = ByteArray(2048) { 4 }
        val sha = sha256Hex(payload)
        // Force same entryId by using name that already exists + idFactory returning same base.
        // allocateEntryId will pick uuid-name when keep.mpkg exists — protect that uuid path
        // by pre-creating after first allocation is hard. Instead protect via inFlightIds on
        // a re-stage that would try to delete during final commit of an existing id:
        // Stage a new unique name while listing keep as protected for eviction safety.
        val stager = MpkgStager(root, idFactory = { "fixed" })
        // First stage creates fixed-keep.mpkg if keep.mpkg exists... keep.mpkg exists so
        // entryId becomes "fixed-keep.mpkg". Seed protected collision:
        val collision = java.io.File(root, "fixed-keep.mpkg")
        collision.writeBytes(ByteArray(2048) { 8 })
        val result = stager.stage(
            input = ByteArrayInputStream(payload),
            displayName = "keep.mpkg",
            expectedBytes = payload.size.toLong(),
            expectedSha256 = sha,
            protectedIds = setOf("fixed-keep.mpkg"),
            inFlightIds = setOf("fixed-keep.mpkg"),
        )
        assertFalse(result.ok)
        assertFalse(result.sourceConsumed)
        assertEquals("PROTECTED_ENTRY", result.message)
        // Original protected file bytes preserved.
        assertEquals(8.toByte(), collision.readBytes()[0])
    }

    private fun sha256Hex(bytes: ByteArray): String {
        val d = MessageDigest.getInstance("SHA-256").digest(bytes)
        return d.joinToString("") { "%02x".format(it) }
    }
}
