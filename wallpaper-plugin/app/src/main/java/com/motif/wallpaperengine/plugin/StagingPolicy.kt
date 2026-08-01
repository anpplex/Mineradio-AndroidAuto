package com.motif.wallpaperengine.plugin

/**
 * WP-03 staging quota and metadata policy (Task 3 fixed rules).
 *
 * Pure logic — no Android Context / filesystem I/O.
 * Spec: DEVELOPMENT Task 3 — basename, bytes bounds, SHA-256, 8 entries / 4 GiB,
 * never evict in-flight or current entries.
 *
 * REFACTOR-03: centralized fail-closed metadata / quota helpers; public constants
 * and admit semantics unchanged.
 */
class StagingPolicy {

    data class MetadataValidation(
        val ok: Boolean,
        val code: Int = PluginContract.CODE_OK,
        val message: String = "OK",
        val sanitizedName: String? = null,
    )

    data class StageEntry(
        val id: String,
        val bytes: Long,
        val inFlight: Boolean = false,
        val current: Boolean = false,
        val lastAccessMs: Long = 0L,
    )

    data class QuotaDecision(
        val ok: Boolean,
        val code: Int = PluginContract.CODE_OK,
        val message: String = "OK",
        val evictIds: List<String> = emptyList(),
    )

    /**
     * Sanitize displayName to a safe .mpkg basename (no path traversal).
     */
    fun sanitizeDisplayName(displayName: String?): String? {
        if (displayName.isNullOrBlank()) return null
        val base = displayName
            .replace('\\', '/')
            .substringAfterLast('/')
            .trim()
        if (base.isEmpty() || base == "." || base == "..") return null
        if (base.contains("..")) return null
        // Reject absolute or residual separators after basename take.
        if (base.contains('/') || base.contains('\\')) return null
        val cleaned = base.filter { ch -> isSafeBasenameChar(ch) }
        if (cleaned.isEmpty()) return null
        return cleaned
    }

    fun validateMetadata(
        displayName: String?,
        bytes: Long,
        sha256: String?,
    ): MetadataValidation {
        val name = sanitizeDisplayName(displayName)
            ?: return metadataFail(
                code = PluginContract.CODE_BAD_REQUEST,
                message = "INVALID_DISPLAY_NAME",
            )
        if (!name.lowercase().endsWith(MPKG_SUFFIX)) {
            return metadataFail(
                code = PluginContract.CODE_PACKAGE_INVALID,
                message = "EXTENSION_NOT_MPKG",
            )
        }
        if (!isBytesInRange(bytes)) {
            return metadataFail(
                code = PluginContract.CODE_PACKAGE_INVALID,
                message = "BYTES_OUT_OF_RANGE",
            )
        }
        val digest = normalizeSha256(sha256)
        if (digest == null) {
            return metadataFail(
                code = PluginContract.CODE_BAD_REQUEST,
                message = "SHA256_INVALID",
            )
        }
        return MetadataValidation(ok = true, sanitizedName = name)
    }

    /**
     * Decide whether [newBytes] can be admitted. May propose LRU eviction of
     * non-protected entries. Never lists in-flight or current entries for eviction.
     *
     * [nowMs] is retained for callers/clock injection; eviction uses [StageEntry.lastAccessMs].
     */
    @Suppress("UNUSED_PARAMETER")
    fun admit(
        existing: List<StageEntry>,
        newBytes: Long,
        nowMs: Long = System.currentTimeMillis(),
    ): QuotaDecision {
        if (!isBytesInRange(newBytes)) {
            return quotaFail(
                code = PluginContract.CODE_PACKAGE_INVALID,
                message = "BYTES_OUT_OF_RANGE",
            )
        }
        val live = existing.toMutableList()
        var total = live.sumOf { it.bytes }
        val evict = mutableListOf<String>()

        // Evict LRU unprotected until capacity allows, or fail closed.
        while (live.size >= MAX_ENTRIES || total + newBytes > TOTAL_QUOTA_BYTES) {
            val candidate = live
                .filter { !isProtected(it) }
                .minByOrNull { it.lastAccessMs }
            if (candidate == null) {
                return quotaFail(
                    code = PluginContract.CODE_STAGING_QUOTA_EXCEEDED,
                    message = "STAGING_QUOTA_EXCEEDED",
                    evictIds = evict.toList(),
                )
            }
            live.removeAll { it.id == candidate.id }
            total -= candidate.bytes
            evict += candidate.id
        }

        return QuotaDecision(ok = true, evictIds = evict.toList())
    }

    fun isProtected(entry: StageEntry): Boolean = entry.inFlight || entry.current

    fun isBytesInRange(bytes: Long): Boolean = bytes in MIN_BYTES..MAX_BYTES

    fun normalizeSha256(sha256: String?): String? {
        val digest = sha256?.trim()?.lowercase().orEmpty()
        return if (SHA256_HEX.matches(digest)) digest else null
    }

    private fun metadataFail(code: Int, message: String): MetadataValidation =
        MetadataValidation(ok = false, code = code, message = message)

    private fun quotaFail(
        code: Int,
        message: String,
        evictIds: List<String> = emptyList(),
    ): QuotaDecision = QuotaDecision(ok = false, code = code, message = message, evictIds = evictIds)

    companion object {
        const val STAGE_DIR_NAME = "plugin_stage"
        const val MPKG_SUFFIX = ".mpkg"
        const val MAX_ENTRIES = 8
        const val TOTAL_QUOTA_BYTES: Long = 4L * 1024L * 1024L * 1024L // 4 GiB
        const val MIN_BYTES: Long = 1024L // 1 KiB
        const val MAX_BYTES: Long = 2L * 1024L * 1024L * 1024L // 2 GiB
        const val PART_TTL_MS: Long = 30L * 60L * 1000L // 30 minutes
        const val ENGINE_GRANT_TTL_MS: Long = 24L * 60L * 60L * 1000L // 24h
        const val FILE_PROVIDER_AUTHORITY = "com.motif.wallpaperengine.files"
        val SHA256_HEX = Regex("^[0-9a-f]{64}$")

        fun isSafeBasenameChar(ch: Char): Boolean =
            ch.isLetterOrDigit() || ch == '.' || ch == '_' || ch == '-'
    }
}
