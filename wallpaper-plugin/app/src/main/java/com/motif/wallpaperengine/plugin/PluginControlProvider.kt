package com.motif.wallpaperengine.plugin

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.database.Cursor
import android.net.Uri
import android.os.Binder
import android.os.Bundle
import android.os.Process
import android.os.UserManager
import java.security.MessageDigest

/**
 * WP-02 control-plane Provider on process `:we_runtime`.
 *
 * Only [call] is supported. All other ContentProvider CRUD/file APIs fail-closed.
 * Does not copy files, start activities, or start services on the Binder stack.
 */
class PluginControlProvider : ContentProvider() {

    @Volatile
    internal var repository: PluginOperationRepository = PluginOperationRepository()

    @Volatile
    internal var callerPolicyOverride: CallerPolicy? = null

    @Volatile
    internal var userUnlockedOverride: Boolean? = null

    override fun onCreate(): Boolean {
        repository = PluginOperationRepository()
        return true
    }

    override fun call(method: String, arg: String?, extras: Bundle?): Bundle {
        val ctx = context
            ?: return errorBundle(PluginContract.CODE_INTERNAL_ERROR, "NO_CONTEXT")

        // Defensive unlock check (directBootAware=false).
        if (!isUserUnlocked(ctx)) {
            return errorBundle(PluginContract.CODE_USER_LOCKED, "USER_LOCKED")
        }

        val policy = callerPolicyOverride ?: buildDefaultCallerPolicy(ctx)
        val decision = policy.evaluate(Binder.getCallingUid())
        if (!decision.allowed) {
            return errorBundle(PluginContract.CODE_CALLER_REJECTED, decision.reason)
        }

        val request = extras ?: Bundle()
        // Ensure Bundle is unparceled before reading.
        request.size()

        val validation = PluginContract.validate(method, request)
        if (!validation.ok) {
            return errorBundle(validation.code, validation.message ?: "BAD_REQUEST")
        }

        val result = dispatch(method, ctx, request)
        echoCallId(request, result)
        return result
    }

    private fun dispatch(method: String, ctx: Context, request: Bundle): Bundle {
        return when (method) {
            PluginContract.METHOD_PING -> handlePing(ctx)
            PluginContract.METHOD_STATUS -> handleStatus(request)
            PluginContract.METHOD_RENEW_ACTION -> handleRenew(ctx, request)
            PluginContract.METHOD_DIAGNOSTICS -> handleDiagnostics()
            PluginContract.METHOD_IMPORT_MPKG,
            PluginContract.METHOD_OPEN_LIBRARY,
            PluginContract.METHOD_APPLY_CURRENT,
            PluginContract.METHOD_NEXT,
            PluginContract.METHOD_PREVIOUS,
            PluginContract.METHOD_STOP,
            -> handleAcceptedMutation(ctx, method, request)
            else -> errorBundle(PluginContract.CODE_BAD_REQUEST, "UNKNOWN_METHOD")
        }
    }

    private fun handlePing(ctx: Context): Bundle {
        val versionName = try {
            ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName ?: "0"
        } catch (_: Exception) {
            "0"
        }
        return okBundle().apply {
            putInt(PluginContract.KEY_PROTOCOL_VERSION, PluginContract.PROTOCOL_VERSION)
            putString("versionName", versionName)
            putInt(PluginContract.KEY_RUNTIME_PID, Process.myPid())
            // Capabilities mirror frozen protocol method set (no hand-maintained list).
            putStringArray("capabilities", PluginContract.METHODS.toTypedArray())
        }
    }

    private fun handleStatus(request: Bundle): Bundle {
        val operationId = request.getString(PluginContract.KEY_OPERATION_ID)
        if (operationId.isNullOrBlank()) {
            return idleStatusBundle(operationId = null, actionEpoch = null)
        }
        val record = repository.status(operationId)
            ?: return idleStatusBundle(operationId = operationId, actionEpoch = 0L)

        // status never increments epoch and never mints PendingIntent
        return okBundle().apply {
            putInt(PluginContract.KEY_PROTOCOL_VERSION, PluginContract.PROTOCOL_VERSION)
            putString(PluginContract.KEY_OPERATION_ID, record.operationId)
            putString(PluginContract.KEY_OPERATION_STATE, record.operationState)
            putString(PluginContract.KEY_BINDING_STATE, record.bindingState)
            putLong(PluginContract.KEY_ACTION_EPOCH, record.actionEpoch)
            record.actionKind?.let { putString(PluginContract.KEY_USER_ACTION_KIND, it) }
            record.actionExpiresAtMs?.let {
                putLong(PluginContract.KEY_USER_ACTION_EXPIRES_AT, it)
            }
            record.lastError?.let { putString(PluginContract.KEY_LAST_ERROR, it) }
        }
    }

    private fun handleRenew(ctx: Context, request: Bundle): Bundle {
        val operationId = request.getString(PluginContract.KEY_OPERATION_ID).orEmpty()
        val epoch = request.getLong(PluginContract.KEY_ACTION_EPOCH)
        val kind = request.getString(PluginContract.KEY_USER_ACTION_KIND)
        val result = repository.renewAction(operationId, epoch, kind)
        val out = resultBundle(result.code, result.message).apply {
            putString(PluginContract.KEY_OPERATION_ID, operationId)
        }
        if (result.newEpoch != null) {
            out.putLong(PluginContract.KEY_ACTION_EPOCH, result.newEpoch)
            // Attach one-shot PendingIntent only on successful renew.
            if (result.code == PluginContract.CODE_OK) {
                attachUserAction(
                    out,
                    ctx,
                    operationId,
                    result.newEpoch,
                    result.actionKind ?: "GENERIC",
                )
            }
        }
        return out
    }

    private fun handleAcceptedMutation(
        ctx: Context,
        method: String,
        request: Bundle,
    ): Bundle {
        val operationId = request.getString(PluginContract.KEY_OPERATION_ID).orEmpty()
        val needsUserAction = method in USER_ACTION_METHODS
        val actionKind = methodToActionKind(method)
        val record = repository.acceptOperation(
            operationId = operationId,
            method = method,
            operationState = if (needsUserAction) "ACTION_PENDING" else "STAGED",
            sourceUri = request.getString(PluginContract.KEY_SOURCE_URI),
            displayName = request.getString(PluginContract.KEY_DISPLAY_NAME),
            actionKind = if (needsUserAction) actionKind else null,
        )
        val out = Bundle().apply {
            putString(PluginContract.KEY_OPERATION_ID, record.operationId)
            putString(PluginContract.KEY_OPERATION_STATE, record.operationState)
            putLong(PluginContract.KEY_ACTION_EPOCH, record.actionEpoch)
        }
        if (needsUserAction) {
            attachUserAction(out, ctx, record.operationId, record.actionEpoch, actionKind)
            record.actionExpiresAtMs?.let {
                out.putLong(PluginContract.KEY_USER_ACTION_EXPIRES_AT, it)
            }
        } else {
            out.putInt(PluginContract.KEY_CODE, PluginContract.CODE_ACCEPTED)
        }
        return out
    }

    private fun handleDiagnostics(): Bundle {
        return okBundle().apply {
            putInt(PluginContract.KEY_RUNTIME_PID, Process.myPid())
            putInt("ledgerSize", repository.ledgerSnapshot().size)
        }
    }

    /** Shared PendingIntent + USER_ACTION_REQUIRED wiring for renew / mutations. */
    private fun attachUserAction(
        out: Bundle,
        ctx: Context,
        operationId: String,
        actionEpoch: Long,
        actionKind: String,
    ) {
        val pi = PluginOperationRepository.buildActionPendingIntent(
            ctx,
            operationId,
            actionEpoch,
            actionKind,
        )
        out.putParcelable(PluginContract.KEY_USER_ACTION, pi)
        out.putString(PluginContract.KEY_USER_ACTION_KIND, actionKind)
        out.putInt(PluginContract.KEY_CODE, PluginContract.CODE_USER_ACTION_REQUIRED)
    }

    private fun idleStatusBundle(operationId: String?, actionEpoch: Long?): Bundle {
        return okBundle().apply {
            putInt(PluginContract.KEY_PROTOCOL_VERSION, PluginContract.PROTOCOL_VERSION)
            putString(PluginContract.KEY_OPERATION_STATE, "IDLE")
            putString(PluginContract.KEY_BINDING_STATE, "UNKNOWN")
            if (operationId != null) {
                putString(PluginContract.KEY_OPERATION_ID, operationId)
            }
            if (actionEpoch != null) {
                putLong(PluginContract.KEY_ACTION_EPOCH, actionEpoch)
            }
        }
    }

    private fun isUserUnlocked(ctx: Context): Boolean {
        userUnlockedOverride?.let { return it }
        val um = ctx.getSystemService(UserManager::class.java) ?: return true
        return um.isUserUnlocked
    }

    private fun buildDefaultCallerPolicy(ctx: Context): CallerPolicy {
        val certProp = readBuildConfigString("MINERADIO_CALLER_CERT_SHA256")
        val debug = readBuildConfigBoolean("DEBUG", default = true)
        val certs = CallerPolicy.normalizeCertSet(
            listOf(certProp).filter { it.isNotBlank() },
        )
        return CallerPolicy(
            allowedCertSha256 = certs.ifEmpty {
                // Unit/debug fallback: empty set rejects non-shell unless tests inject policy.
                emptySet()
            },
            isDebugBuild = debug,
            allowShellInDebug = debug,
            packageIdentitiesForUid = { uid -> resolvePackageIdentities(ctx, uid) },
        )
    }

    private fun readBuildConfigString(field: String): String {
        return try {
            val buildConfigClass = Class.forName("com.motif.wallpaperengine.BuildConfig")
            (buildConfigClass.getField(field).get(null) as? String).orEmpty()
        } catch (_: Exception) {
            ""
        }
    }

    private fun readBuildConfigBoolean(field: String, default: Boolean): Boolean {
        return try {
            val buildConfigClass = Class.forName("com.motif.wallpaperengine.BuildConfig")
            buildConfigClass.getField(field).getBoolean(null)
        } catch (_: Exception) {
            default
        }
    }

    private fun resolvePackageIdentities(
        ctx: Context,
        uid: Int,
    ): List<CallerPolicy.PackageIdentity> {
        val pm = ctx.packageManager
        val packages = pm.getPackagesForUid(uid) ?: return emptyList()
        return packages.mapNotNull { pkg ->
            try {
                @Suppress("DEPRECATION")
                val info = pm.getPackageInfo(pkg, PackageManager.GET_SIGNATURES)
                @Suppress("DEPRECATION")
                val sig = info.signatures?.firstOrNull()?.toByteArray() ?: return@mapNotNull null
                val digest = MessageDigest.getInstance("SHA-256").digest(sig)
                val hex = digest.joinToString("") { b -> "%02x".format(b) }
                CallerPolicy.PackageIdentity(pkg, hex)
            } catch (_: Exception) {
                null
            }
        }
    }

    private fun okBundle(): Bundle =
        Bundle().apply { putInt(PluginContract.KEY_CODE, PluginContract.CODE_OK) }

    private fun resultBundle(code: Int, message: String?): Bundle =
        Bundle().apply {
            putInt(PluginContract.KEY_CODE, code)
            if (!message.isNullOrBlank()) {
                putString(PluginContract.KEY_MESSAGE, message)
            }
        }

    private fun errorBundle(code: Int, message: String?): Bundle = resultBundle(code, message)

    private fun echoCallId(request: Bundle, result: Bundle) {
        val callId = request.getString(PluginContract.KEY_CALL_ID)
        if (!callId.isNullOrBlank() && !result.containsKey(PluginContract.KEY_CALL_ID)) {
            result.putString(PluginContract.KEY_CALL_ID, callId)
        }
    }

    // --- Fail-closed non-call surface ---------------------------------------

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor? = null

    override fun getType(uri: Uri): String? = null

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0

    override fun update(
        uri: Uri,
        values: ContentValues?,
        selection: String?,
        selectionArgs: Array<out String>?,
    ): Int = 0

    override fun bulkInsert(uri: Uri, values: Array<out ContentValues>): Int = 0

    override fun openFile(uri: Uri, mode: String): Nothing {
        throw UnsupportedOperationException("openFile fail-closed")
    }

    companion object {
        private val USER_ACTION_METHODS = setOf(
            PluginContract.METHOD_IMPORT_MPKG,
            PluginContract.METHOD_OPEN_LIBRARY,
            PluginContract.METHOD_APPLY_CURRENT,
        )

        fun methodToActionKind(method: String): String = when (method) {
            PluginContract.METHOD_IMPORT_MPKG -> "IMPORT"
            PluginContract.METHOD_OPEN_LIBRARY -> "OPEN_LIBRARY"
            PluginContract.METHOD_APPLY_CURRENT -> "APPLY"
            else -> "GENERIC"
        }
    }
}
