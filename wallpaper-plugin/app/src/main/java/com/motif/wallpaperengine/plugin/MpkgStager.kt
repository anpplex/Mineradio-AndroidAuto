package com.motif.wallpaperengine.plugin

import java.io.File
import java.io.InputStream
import java.security.MessageDigest
import java.util.UUID

/**
 * WP-03 `.mpkg` stager: copy source stream into `files/plugin_stage/` via `.part`
 * then atomic rename. Marks copy complete for sourceConsumed handoff.
 *
 * Spec: DEVELOPMENT Task 3 — ContentResolver stream → .part → verify → rename.
 * Provider/Activity must not perform this copy on the main/Binder thread.
 *
 * REFACTOR-03: extract fail-closed helpers; sourceConsumed remains true only after
 * successful verify + commit. Protected / in-flight / current entries are never
 * overwritten.
 */
class MpkgStager(
    private val stageRoot: File,
    private val policy: StagingPolicy = StagingPolicy(),
    private val clockMs: () -> Long = { System.currentTimeMillis() },
    private val idFactory: () -> String = { UUID.randomUUID().toString() },
) {

    data class StagedMpkg(
        val entryId: String,
        val absolutePath: String,
        val displayName: String,
        val bytes: Long,
        val sha256: String,
        val relativePath: String,
    )

    data class StageResult(
        val ok: Boolean,
        val code: Int,
        val message: String,
        val staged: StagedMpkg? = null,
        val sourceConsumed: Boolean = false,
        val evictedIds: List<String> = emptyList(),
    )

    fun ensureStageRoot(): File {
        if (!stageRoot.exists()) {
            stageRoot.mkdirs()
        }
        return stageRoot
    }

    /**
     * Delete orphan `.part` files older than [StagingPolicy.PART_TTL_MS].
     */
    fun cleanupOrphanParts(nowMs: Long = clockMs()): Int {
        ensureStageRoot()
        var removed = 0
        stageRoot.listFiles()?.forEach { f ->
            if (f.isFile && f.name.endsWith(PART_SUFFIX)) {
                val age = nowMs - f.lastModified()
                if (age > StagingPolicy.PART_TTL_MS) {
                    if (f.delete()) removed += 1
                }
            }
        }
        return removed
    }

    fun listEntries(): List<StagingPolicy.StageEntry> {
        ensureStageRoot()
        return stageRoot.listFiles()
            ?.filter { it.isFile && it.name.endsWith(StagingPolicy.MPKG_SUFFIX) }
            ?.map {
                StagingPolicy.StageEntry(
                    id = it.name,
                    bytes = it.length(),
                    inFlight = false,
                    current = false,
                    lastAccessMs = it.lastModified(),
                )
            }
            .orEmpty()
    }

    /**
     * Stage [input] under [stageRoot] after policy validation and quota admit.
     * [protectedIds] / [inFlightIds] / [currentIds] are never evicted or overwritten.
     *
     * [sourceConsumed] is true only on full success (copy + bytes + SHA-256 + commit).
     */
    fun stage(
        input: InputStream,
        displayName: String?,
        expectedBytes: Long,
        expectedSha256: String?,
        protectedIds: Set<String> = emptySet(),
        inFlightIds: Set<String> = emptySet(),
        currentIds: Set<String> = emptySet(),
    ): StageResult {
        val meta = policy.validateMetadata(displayName, expectedBytes, expectedSha256)
        if (!meta.ok) {
            return fail(meta.code, meta.message)
        }
        val name = meta.sanitizedName!!
        val digestExpected = policy.normalizeSha256(expectedSha256)!!

        ensureStageRoot()
        cleanupOrphanParts()

        val protected = protectedIds + inFlightIds + currentIds
        val existing = listEntries().map { e ->
            e.copy(
                inFlight = e.id in inFlightIds || e.id in protectedIds,
                current = e.id in currentIds,
            )
        }
        val admit = policy.admit(existing, expectedBytes, clockMs())
        if (!admit.ok) {
            return fail(admit.code, admit.message, evictedIds = admit.evictIds)
        }
        applySafeEvictions(admit.evictIds, protected)

        val entryId = allocateEntryId(name)
        val finalFile = File(stageRoot, entryId)
        val partFile = File(stageRoot, "$entryId$PART_SUFFIX")
        if (partFile.exists()) partFile.delete()

        val copy = copyStreamToPart(input, partFile)
        if (!copy.ok) {
            partFile.delete()
            return fail(copy.code, copy.message)
        }

        if (copy.written != expectedBytes) {
            partFile.delete()
            return fail(PluginContract.CODE_PACKAGE_INVALID, "BYTES_MISMATCH")
        }
        if (copy.sha256 != digestExpected) {
            partFile.delete()
            return fail(PluginContract.CODE_PACKAGE_INVALID, "SHA256_MISMATCH")
        }

        if (finalFile.exists()) {
            if (entryId in protected) {
                partFile.delete()
                return fail(PluginContract.CODE_BUSY, "PROTECTED_ENTRY")
            }
            finalFile.delete()
        }

        if (!commitPartAtomically(partFile, finalFile)) {
            return fail(PluginContract.CODE_INTERNAL_ERROR, "ATOMIC_RENAME_FAILED")
        }

        val staged = StagedMpkg(
            entryId = entryId,
            absolutePath = finalFile.absolutePath,
            displayName = name,
            bytes = copy.written,
            sha256 = copy.sha256,
            relativePath = "${StagingPolicy.STAGE_DIR_NAME}/$entryId",
        )
        // sourceConsumed only after successful verify + commit.
        return StageResult(
            ok = true,
            code = PluginContract.CODE_OK,
            message = "STAGED",
            staged = staged,
            sourceConsumed = true,
            evictedIds = admit.evictIds,
        )
    }

    private fun applySafeEvictions(evictIds: List<String>, protected: Set<String>) {
        for (id in evictIds) {
            if (id in protected) continue
            File(stageRoot, id).takeIf { it.exists() }?.delete()
        }
    }

    private fun allocateEntryId(sanitizedName: String): String {
        val preferred = File(stageRoot, sanitizedName)
        return if (!preferred.exists()) sanitizedName else "${idFactory()}-$sanitizedName"
    }

    private data class CopyOutcome(
        val ok: Boolean,
        val written: Long = 0L,
        val sha256: String = "",
        val code: Int = PluginContract.CODE_OK,
        val message: String = "OK",
    )

    private fun copyStreamToPart(input: InputStream, partFile: File): CopyOutcome {
        val digest = MessageDigest.getInstance("SHA-256")
        var written = 0L
        return try {
            input.use { src ->
                partFile.outputStream().use { out ->
                    val buf = ByteArray(DEFAULT_BUFFER)
                    while (true) {
                        val n = src.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        digest.update(buf, 0, n)
                        written += n
                    }
                    out.flush()
                }
            }
            CopyOutcome(ok = true, written = written, sha256 = toHex(digest.digest()))
        } catch (_: Exception) {
            CopyOutcome(
                ok = false,
                code = PluginContract.CODE_SOURCE_UNREADABLE,
                message = "COPY_FAILED",
            )
        }
    }

    /**
     * Atomic rename preferred; copy+delete fallback when rename is not atomic
     * across volumes. On any failure both part and final are cleaned.
     */
    private fun commitPartAtomically(partFile: File, finalFile: File): Boolean {
        if (partFile.renameTo(finalFile)) {
            return true
        }
        return try {
            partFile.copyTo(finalFile, overwrite = true)
            partFile.delete()
            true
        } catch (_: Exception) {
            partFile.delete()
            finalFile.delete()
            false
        }
    }

    private fun fail(
        code: Int,
        message: String,
        evictedIds: List<String> = emptyList(),
    ): StageResult = StageResult(
        ok = false,
        code = code,
        message = message,
        staged = null,
        sourceConsumed = false,
        evictedIds = evictedIds,
    )

    companion object {
        private const val DEFAULT_BUFFER = 64 * 1024
        private const val PART_SUFFIX = ".part"

        fun toHex(bytes: ByteArray): String =
            bytes.joinToString("") { b -> "%02x".format(b) }
    }
}
