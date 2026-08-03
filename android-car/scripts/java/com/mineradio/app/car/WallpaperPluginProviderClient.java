package com.mineradio.app.car;

import android.content.ContentResolver;
import android.content.Context;
import android.net.Uri;
import android.os.Bundle;
import android.os.Process;
import java.util.Set;

/**
 * WP-10A: real Binder ContentResolver.call from the Mineradio process.
 *
 * Identity is the process UID (com.mineradio.app), never shell. Returns JSON for
 * JavascriptInterface surfaces. Fail-closed on missing Application / null Bundle.
 *
 * Does not depend on car HMI assets — usable from native 1.1.7 + bridge inject.
 */
public final class WallpaperPluginProviderClient {
    public static final String AUTHORITY = "com.motif.wallpaperengine.control";
    public static final Uri CONTROL_URI = Uri.parse("content://" + AUTHORITY);
    public static final int PROTOCOL_VERSION = 1;

    private WallpaperPluginProviderClient() {}

    /** Current Application context via ActivityThread (no Activity inject required). */
    public static Context appContext() {
        try {
            Class<?> at = Class.forName("android.app.ActivityThread");
            Object app = at.getMethod("currentApplication").invoke(null);
            if (app instanceof Context) {
                return ((Context) app).getApplicationContext();
            }
        } catch (Throwable ignored) {
            // fail closed below
        }
        return null;
    }

    public static String ping() {
        Bundle extras = baseExtras("native-bridge-ping");
        return call("ping", extras);
    }

    public static String status(String operationId) {
        Bundle extras = baseExtras("native-bridge-status");
        if (operationId != null && !operationId.isEmpty()) {
            extras.putString("operationId", operationId);
        }
        return call("status", extras);
    }

    public static String importMpkg(String operationId, String sourceUri, long bytes, String sha256) {
        if (operationId == null || operationId.isEmpty() || sourceUri == null || sourceUri.isEmpty()) {
            return failClosed("BAD_REQUEST");
        }
        Bundle extras = baseExtras("native-bridge-import");
        extras.putString("operationId", operationId);
        extras.putString("sourceUri", sourceUri);
        extras.putString("displayName", "import.mpkg");
        extras.putLong("bytes", bytes > 0 ? bytes : 1L);
        if (sha256 != null && sha256.length() == 64) {
            extras.putString("sha256", sha256);
        } else {
            extras.putString("sha256", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        }
        return call("import_mpkg", extras);
    }

    /** Two-arg JS surface: operationId + sourceUri (bytes defaulted). */
    public static String importMpkg(String operationId, String sourceUri) {
        return importMpkg(operationId, sourceUri, 1L, null);
    }

    public static String renewAction(String operationId, String actionToken, int actionEpoch) {
        if (operationId == null || actionToken == null) {
            return failClosed("BAD_REQUEST");
        }
        Bundle extras = baseExtras("native-bridge-renew");
        extras.putString("operationId", operationId);
        extras.putString("actionToken", actionToken);
        extras.putInt("actionEpoch", actionEpoch);
        return call("renew_action", extras);
    }

    public static String renewAction(String operationId, String actionToken) {
        return renewAction(operationId, actionToken, 1);
    }

    public static String call(String method, Bundle extras) {
        Context ctx = appContext();
        if (ctx == null) {
            return failClosed("NO_APPLICATION");
        }
        ContentResolver cr = ctx.getContentResolver();
        if (cr == null) {
            return failClosed("NO_RESOLVER");
        }
        try {
            Bundle result = cr.call(CONTROL_URI, method, null, extras);
            if (result == null) {
                return failClosed("NULL_BUNDLE");
            }
            return bundleToJson(result);
        } catch (Throwable t) {
            return failClosed("PLUGIN_CALL_FAILED");
        }
    }

    private static Bundle baseExtras(String callId) {
        Bundle b = new Bundle();
        b.putInt("protocolVersion", PROTOCOL_VERSION);
        b.putString("callId", callId);
        return b;
    }

    static String failClosed(String reason) {
        return "{\"code\":60,\"operationState\":\"FAILED\",\"bindingState\":\"UNKNOWN\","
                + "\"message\":\"PLUGIN_CALL_FAILED\",\"reason\":\""
                + jsonEscape(reason)
                + "\",\"realCallerPid\":"
                + Process.myPid()
                + ",\"realCallerUid\":"
                + Process.myUid()
                + "}";
    }

    /** Best-effort Bundle → flat JSON (protocol keys only; no nested Parcelables). */
    static String bundleToJson(Bundle b) {
        StringBuilder sb = new StringBuilder(256);
        sb.append('{');
        // Always stamp process identity for E3 evidence parsers.
        sb.append("\"realCallerPid\":").append(Process.myPid());
        sb.append(",\"realCallerUid\":").append(Process.myUid());
        sb.append(",\"realCaller\":true");

        Set<String> keys = b.keySet();
        if (keys != null) {
            for (String key : keys) {
                if (key == null) continue;
                Object v = b.get(key);
                sb.append(',');
                sb.append('"').append(jsonEscape(key)).append('"').append(':');
                appendJsonValue(sb, v);
            }
        }
        sb.append('}');
        return sb.toString();
    }

    private static void appendJsonValue(StringBuilder sb, Object v) {
        if (v == null) {
            sb.append("null");
        } else if (v instanceof Boolean) {
            sb.append(((Boolean) v).booleanValue() ? "true" : "false");
        } else if (v instanceof Integer) {
            sb.append(((Integer) v).intValue());
        } else if (v instanceof Long) {
            sb.append(((Long) v).longValue());
        } else if (v instanceof Float) {
            sb.append(((Float) v).floatValue());
        } else if (v instanceof Double) {
            sb.append(((Double) v).doubleValue());
        } else if (v instanceof String) {
            sb.append('"').append(jsonEscape((String) v)).append('"');
        } else if (v instanceof String[]) {
            String[] arr = (String[]) v;
            sb.append('[');
            for (int i = 0; i < arr.length; i++) {
                if (i > 0) sb.append(',');
                sb.append('"').append(jsonEscape(arr[i] == null ? "" : arr[i])).append('"');
            }
            sb.append(']');
        } else {
            sb.append('"').append(jsonEscape(String.valueOf(v))).append('"');
        }
    }

    static String jsonEscape(String s) {
        if (s == null) return "";
        StringBuilder out = new StringBuilder(s.length() + 8);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '\\':
                    out.append("\\\\");
                    break;
                case '"':
                    out.append("\\\"");
                    break;
                case '\n':
                    out.append("\\n");
                    break;
                case '\r':
                    out.append("\\r");
                    break;
                case '\t':
                    out.append("\\t");
                    break;
                default:
                    if (c < 0x20) {
                        out.append(String.format("\\u%04x", (int) c));
                    } else {
                        out.append(c);
                    }
            }
        }
        return out.toString();
    }
}
