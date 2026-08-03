package com.mineradio.app.car;

import android.app.Activity;
import android.os.Bundle;
import android.util.Log;

/**
 * WP-10A native-bridge probe: runs as com.mineradio.app process and exercises
 * real Binder provider calls without WebView/JS. Results go to logcat tag
 * WallpaperPluginBridgeProbe for adb evidence collectors.
 *
 * Extras (optional):
 *   operationId, sourceUri, actionToken, actionEpoch, method
 */
public final class WallpaperPluginBridgeProbeActivity extends Activity {
    public static final String TAG = "WallpaperPluginBridgeProbe";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        String method = getIntent() != null ? getIntent().getStringExtra("method") : null;
        if (method == null || method.isEmpty()) {
            method = "ping";
        }
        String result;
        try {
            switch (method) {
                case "status":
                    result = WallpaperPluginProviderClient.status(
                            extra("operationId"));
                    break;
                case "import_mpkg":
                    result = WallpaperPluginProviderClient.importMpkg(
                            extra("operationId"),
                            extra("sourceUri"),
                            getIntent().getLongExtra("bytes", 1L),
                            extra("sha256"));
                    break;
                case "renew_action":
                    result = WallpaperPluginProviderClient.renewAction(
                            extra("operationId"),
                            extra("actionToken"),
                            getIntent().getIntExtra("actionEpoch", 1));
                    break;
                case "ping":
                default:
                    result = WallpaperPluginProviderClient.ping();
                    break;
            }
        } catch (Throwable t) {
            result = WallpaperPluginProviderClient.failClosed("PROBE_EXCEPTION");
            Log.e(TAG, "probe failed", t);
        }
        Log.i(TAG, "method=" + method + " result=" + result);
        // Also write to stdout for adb shell am instrument-style capture.
        System.out.println(TAG + " " + result);
        finish();
    }

    private String extra(String key) {
        if (getIntent() == null) return null;
        return getIntent().getStringExtra(key);
    }
}
