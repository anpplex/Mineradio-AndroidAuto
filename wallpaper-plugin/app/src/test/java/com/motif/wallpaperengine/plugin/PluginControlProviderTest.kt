package com.motif.wallpaperengine.plugin

import android.os.Bundle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * WP-02 PluginControlProvider — ping/status/renew, fail-closed non-call APIs,
 * protocol validation, unknown method, caller rejection.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [31])
class PluginControlProviderTest {

    private lateinit var provider: PluginControlProvider
    private val goodCert = "c".repeat(64)

    @Before
    fun setUp() {
        provider = Robolectric.buildContentProvider(PluginControlProvider::class.java)
            .create()
            .get()
        provider.userUnlockedOverride = true
        provider.callerPolicyOverride = CallerPolicy(
            allowedCertSha256 = CallerPolicy.normalizeCertSet(listOf(goodCert)),
            isDebugBuild = true,
            allowShellInDebug = true,
            packageIdentitiesForUid = {
                listOf(CallerPolicy.PackageIdentity("com.mineradio.app", goodCert))
            },
        )
        provider.repository = PluginOperationRepository()
    }

    private fun baseExtras(
        methodNeedsOp: Boolean = false,
        operationId: String = "op-1",
    ): Bundle {
        return Bundle().apply {
            putInt(PluginContract.KEY_PROTOCOL_VERSION, PluginContract.PROTOCOL_VERSION)
            putString(PluginContract.KEY_CALL_ID, "call-1")
            if (methodNeedsOp) {
                putString(PluginContract.KEY_OPERATION_ID, operationId)
            }
        }
    }

    @Test
    fun ping_returnsOkProtocolPidAndCapabilities() {
        val result = provider.call(PluginContract.METHOD_PING, null, baseExtras())
        assertNotNull(result)
        assertEquals(PluginContract.CODE_OK, result!!.getInt(PluginContract.KEY_CODE))
        assertEquals(
            PluginContract.PROTOCOL_VERSION,
            result.getInt(PluginContract.KEY_PROTOCOL_VERSION),
        )
        // Robolectric may report pid 0; production uses Process.myPid().
        assertTrue(result.containsKey(PluginContract.KEY_RUNTIME_PID))
        assertTrue(result.getInt(PluginContract.KEY_RUNTIME_PID) >= 0)
        val caps = result.getStringArray("capabilities")
        assertNotNull(caps)
        assertTrue(caps!!.isNotEmpty())
        assertEquals("call-1", result.getString(PluginContract.KEY_CALL_ID))
    }

    @Test
    fun unknownMethod_returnsBadRequest() {
        val extras = baseExtras()
        val result = provider.call("not_a_method", null, extras)
        assertEquals(PluginContract.CODE_BAD_REQUEST, result!!.getInt(PluginContract.KEY_CODE))
    }

    @Test
    fun missingProtocolVersion_returnsProtocolMismatch() {
        val extras = Bundle().apply {
            putString(PluginContract.KEY_CALL_ID, "c")
        }
        val result = provider.call(PluginContract.METHOD_PING, null, extras)
        assertEquals(
            PluginContract.CODE_PROTOCOL_MISMATCH,
            result!!.getInt(PluginContract.KEY_CODE),
        )
    }

    @Test
    fun missingCallId_returnsBadRequest() {
        val extras = Bundle().apply {
            putInt(PluginContract.KEY_PROTOCOL_VERSION, 1)
        }
        val result = provider.call(PluginContract.METHOD_PING, null, extras)
        assertEquals(PluginContract.CODE_BAD_REQUEST, result!!.getInt(PluginContract.KEY_CODE))
    }

    @Test
    fun importMpkg_missingRequiredFields_failClosed() {
        val extras = baseExtras(methodNeedsOp = true)
        // missing sourceUri/displayName/bytes/sha256
        val result = provider.call(PluginContract.METHOD_IMPORT_MPKG, null, extras)
        assertEquals(PluginContract.CODE_BAD_REQUEST, result!!.getInt(PluginContract.KEY_CODE))
    }

    @Test
    fun importMpkg_accepted_returnsUserActionRequiredWithoutIncrementOnStatus() {
        val extras = baseExtras(methodNeedsOp = true, operationId = "op-import").apply {
            putString(PluginContract.KEY_SOURCE_URI, "content://src/1")
            putString(PluginContract.KEY_DISPLAY_NAME, "pack.mpkg")
            putLong(PluginContract.KEY_BYTES, 12L)
            putString(PluginContract.KEY_SHA256, "d".repeat(64))
        }
        val accepted = provider.call(PluginContract.METHOD_IMPORT_MPKG, null, extras)
        assertEquals(
            PluginContract.CODE_USER_ACTION_REQUIRED,
            accepted!!.getInt(PluginContract.KEY_CODE),
        )
        assertNotNull(accepted.getParcelable(PluginContract.KEY_USER_ACTION))
        val epoch = accepted.getLong(PluginContract.KEY_ACTION_EPOCH)

        val statusExtras = baseExtras(methodNeedsOp = true, operationId = "op-import")
        val status1 = provider.call(PluginContract.METHOD_STATUS, null, statusExtras)
        val status2 = provider.call(PluginContract.METHOD_STATUS, null, statusExtras)
        assertEquals(epoch, status1!!.getLong(PluginContract.KEY_ACTION_EPOCH))
        assertEquals(epoch, status2!!.getLong(PluginContract.KEY_ACTION_EPOCH))
        assertNull(status1.getParcelable(PluginContract.KEY_USER_ACTION))
    }

    @Test
    fun importMpkg_duplicateOperationId_isIdempotent() {
        val extras = baseExtras(methodNeedsOp = true, operationId = "op-dup").apply {
            putString(PluginContract.KEY_SOURCE_URI, "content://src/1")
            putString(PluginContract.KEY_DISPLAY_NAME, "pack.mpkg")
            putLong(PluginContract.KEY_BYTES, 12L)
            putString(PluginContract.KEY_SHA256, "d".repeat(64))
        }
        val a = provider.call(PluginContract.METHOD_IMPORT_MPKG, null, extras)
        val b = provider.call(PluginContract.METHOD_IMPORT_MPKG, null, extras)
        assertEquals(
            a!!.getLong(PluginContract.KEY_ACTION_EPOCH),
            b!!.getLong(PluginContract.KEY_ACTION_EPOCH),
        )
    }

    @Test
    fun renewAction_casAndExpired() {
        val create = baseExtras(methodNeedsOp = true, operationId = "op-renew").apply {
            putString(PluginContract.KEY_SOURCE_URI, "content://src/1")
            putString(PluginContract.KEY_DISPLAY_NAME, "pack.mpkg")
            putLong(PluginContract.KEY_BYTES, 12L)
            putString(PluginContract.KEY_SHA256, "d".repeat(64))
        }
        provider.call(PluginContract.METHOD_IMPORT_MPKG, null, create)
        val renewExtras = baseExtras(methodNeedsOp = true, operationId = "op-renew").apply {
            putLong(PluginContract.KEY_ACTION_EPOCH, 1L)
            putString(PluginContract.KEY_USER_ACTION_KIND, "IMPORT")
        }
        val renewed = provider.call(PluginContract.METHOD_RENEW_ACTION, null, renewExtras)
        assertTrue(
            renewed!!.getInt(PluginContract.KEY_CODE) == PluginContract.CODE_USER_ACTION_REQUIRED ||
                renewed.getInt(PluginContract.KEY_CODE) == PluginContract.CODE_OK,
        )
        assertEquals(2L, renewed.getLong(PluginContract.KEY_ACTION_EPOCH))

        val stale = baseExtras(methodNeedsOp = true, operationId = "op-renew").apply {
            putLong(PluginContract.KEY_ACTION_EPOCH, 0L)
        }
        val expired = provider.call(PluginContract.METHOD_RENEW_ACTION, null, stale)
        assertEquals(
            PluginContract.CODE_ACTION_TOKEN_EXPIRED,
            expired!!.getInt(PluginContract.KEY_CODE),
        )
    }

    @Test
    fun callerRejected_whenPolicyDenies() {
        provider.callerPolicyOverride = CallerPolicy(
            allowedCertSha256 = CallerPolicy.normalizeCertSet(listOf(goodCert)),
            packageIdentitiesForUid = {
                listOf(CallerPolicy.PackageIdentity("com.evil.app", goodCert))
            },
        )
        val result = provider.call(PluginContract.METHOD_PING, null, baseExtras())
        assertEquals(PluginContract.CODE_CALLER_REJECTED, result!!.getInt(PluginContract.KEY_CODE))
    }

    @Test
    fun userLocked_returnsCode46() {
        provider.userUnlockedOverride = false
        val result = provider.call(PluginContract.METHOD_PING, null, baseExtras())
        assertEquals(PluginContract.CODE_USER_LOCKED, result!!.getInt(PluginContract.KEY_CODE))
    }

    @Test
    fun nonCallApis_failClosed() {
        val uri = android.net.Uri.parse("content://com.motif.wallpaperengine.control/x")
        assertNull(provider.query(uri, null, null, null, null))
        assertNull(provider.getType(uri))
        assertNull(provider.insert(uri, null))
        assertEquals(0, provider.delete(uri, null, null))
        assertEquals(0, provider.update(uri, null, null, null))
        assertEquals(0, provider.bulkInsert(uri, emptyArray()))
        try {
            provider.openFile(uri, "r")
            assertFalse("openFile must throw", true)
        } catch (ex: UnsupportedOperationException) {
            assertTrue(ex.message!!.contains("fail-closed"))
        }
    }
}
