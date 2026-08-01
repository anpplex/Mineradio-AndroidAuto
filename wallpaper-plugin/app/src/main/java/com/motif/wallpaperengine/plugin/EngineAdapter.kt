package com.motif.wallpaperengine.plugin

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri

/**
 * WP-03 official Wallpaper Engine adapter.
 *
 * Builds explicit BrowseActivity VIEW intent for a staged engineUri.
 * Does not fabricate PREVIEW_READY; launch success is ENGINE_LAUNCHED only.
 *
 * REFACTOR-03: shared component builder + fail-closed resolve helpers.
 * Public intent shape and resolve error codes unchanged.
 */
class EngineAdapter(
    private val enginePackage: String = DEFAULT_ENGINE_PACKAGE,
    private val browseActivity: String = DEFAULT_BROWSE_ACTIVITY,
) {

    data class LaunchPlan(
        val intent: Intent,
        val component: ComponentName,
        val engineUri: Uri,
    )

    data class ResolveResult(
        val ok: Boolean,
        val code: Int,
        val message: String,
        val plan: LaunchPlan? = null,
    )

    fun officialComponent(): ComponentName = ComponentName(enginePackage, browseActivity)

    /**
     * Create the fixed official VIEW intent (Task 3).
     * Caller must still [resolveLaunch] before startActivity.
     * Spec forbids CLEAR_TASK on official engine launch.
     */
    fun createLaunchIntent(engineUri: Uri): Intent {
        return Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(engineUri, MIME_OCTET_STREAM)
            component = officialComponent()
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
    }

    fun createLaunchPlan(engineUri: Uri): LaunchPlan {
        return LaunchPlan(
            intent = createLaunchIntent(engineUri),
            component = officialComponent(),
            engineUri = engineUri,
        )
    }

    /**
     * Resolve against package manager; fail closed when component missing/unexported drift.
     */
    fun resolveLaunch(context: Context, engineUri: Uri): ResolveResult {
        val plan = createLaunchPlan(engineUri)
        val resolved = try {
            context.packageManager.resolveActivity(plan.intent, PackageManager.MATCH_DEFAULT_ONLY)
        } catch (_: Exception) {
            null
        }
        if (resolved == null) {
            return resolveFail("ENGINE_ACTIVITY_UNRESOLVED")
        }
        val resolvedPkg = resolved.activityInfo?.packageName
        if (resolvedPkg != enginePackage) {
            return resolveFail("ENGINE_PACKAGE_DRIFT")
        }
        // Package match is authoritative for GREEN; activity class alias drift is
        // BLOCKED_APK at later evidence levels — do not invent PREVIEW_READY here.
        return ResolveResult(
            ok = true,
            code = PluginContract.CODE_OK,
            message = "RESOLVED",
            plan = plan,
        )
    }

    /**
     * Grant read URI permission only to official WE package.
     */
    fun grantEngineRead(context: Context, engineUri: Uri) {
        context.grantUriPermission(
            enginePackage,
            engineUri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION,
        )
    }

    fun revokeEngineRead(context: Context, engineUri: Uri) {
        try {
            context.revokeUriPermission(engineUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } catch (_: Exception) {
            // fail-closed soft: TTL cleanup will re-attempt
        }
    }

    private fun resolveFail(message: String): ResolveResult =
        ResolveResult(
            ok = false,
            code = PluginContract.CODE_ENGINE_NOT_INSTALLED,
            message = message,
            plan = null,
        )

    companion object {
        const val MIME_OCTET_STREAM = "application/octet-stream"
        /** Must match [PluginContract.ENGINE_PACKAGE] (Task 3 frozen). */
        const val DEFAULT_ENGINE_PACKAGE = "io.wallpaperengine.weclient"
        /** Must match [PluginContract.ENGINE_BROWSE_ACTIVITY] (Task 3 frozen). */
        const val DEFAULT_BROWSE_ACTIVITY = "io.wallpaperengine.weclient.BrowseActivity"
    }
}
