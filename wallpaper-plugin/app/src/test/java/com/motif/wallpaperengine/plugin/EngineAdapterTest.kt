package com.motif.wallpaperengine.plugin

import android.content.Intent
import android.net.Uri
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * WP-03 EngineAdapter unit tests — official BrowseActivity intent contract.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [31])
class EngineAdapterTest {

    private val adapter = EngineAdapter()

    @Test
    fun createLaunchIntent_usesOfficialComponentAndGrantFlag() {
        val uri = Uri.parse("content://com.motif.wallpaperengine.files/plugin_stage/a.mpkg")
        val intent = adapter.createLaunchIntent(uri)
        assertEquals(Intent.ACTION_VIEW, intent.action)
        assertEquals(uri, intent.data)
        assertEquals(EngineAdapter.MIME_OCTET_STREAM, intent.type)
        assertEquals(PluginContract.ENGINE_PACKAGE, intent.component?.packageName)
        assertEquals(PluginContract.ENGINE_BROWSE_ACTIVITY, intent.component?.className)
        assertTrue(
            intent.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0,
        )
        assertEquals(0, intent.flags and Intent.FLAG_ACTIVITY_CLEAR_TASK)
    }

    @Test
    fun createLaunchPlan_matchesContractConstants() {
        val uri = Uri.parse("content://com.motif.wallpaperengine.files/plugin_stage/b.mpkg")
        val plan = adapter.createLaunchPlan(uri)
        assertEquals(PluginContract.ENGINE_PACKAGE, plan.component.packageName)
        assertEquals(PluginContract.ENGINE_BROWSE_ACTIVITY, plan.component.className)
        assertEquals(uri, plan.engineUri)
    }

    @Test
    fun resolveLaunch_failsClosedWhenEngineMissing() {
        val ctx = RuntimeEnvironment.getApplication()
        val uri = Uri.parse("content://com.motif.wallpaperengine.files/plugin_stage/c.mpkg")
        val result = adapter.resolveLaunch(ctx, uri)
        // Official WE is not installed in unit environment.
        assertFalse(result.ok)
        assertEquals(PluginContract.CODE_ENGINE_NOT_INSTALLED, result.code)
        assertEquals("ENGINE_ACTIVITY_UNRESOLVED", result.message)
    }

    @Test
    fun constants_matchPluginContract() {
        assertEquals(PluginContract.ENGINE_PACKAGE, EngineAdapter.DEFAULT_ENGINE_PACKAGE)
        assertEquals(
            PluginContract.ENGINE_BROWSE_ACTIVITY,
            EngineAdapter.DEFAULT_BROWSE_ACTIVITY,
        )
        assertEquals(
            "com.motif.wallpaperengine.files",
            StagingPolicy.FILE_PROVIDER_AUTHORITY,
        )
    }
}
