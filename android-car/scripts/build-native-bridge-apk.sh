#!/usr/bin/env bash
# Build native 1.1.7 base + wallpaper realCaller bridge ONLY (no car HMI patches).
# Does NOT apply: car HMI assets, CAR_LAUNCHER, audio-focus, SPICa storage rewrites.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
INPUT_APK="${1:-}"

if [[ -z "$INPUT_APK" || ! -f "$INPUT_APK" ]]; then
  echo "Usage: $0 /absolute/path/to/Mineradio_1.1.7.0.apk" >&2
  exit 64
fi

JAVA_BIN="${JAVA_HOME:+$JAVA_HOME/bin/}java"
if ! command -v "$JAVA_BIN" >/dev/null 2>&1; then
  echo "Java 17+ is required. Set JAVA_HOME." >&2
  exit 69
fi

APKTOOL_JAR="${APKTOOL_JAR:-$PROJECT_DIR/android-car/tools/apktool_3.0.2.jar}"
ANDROID_BUILD_TOOLS="${ANDROID_BUILD_TOOLS:-$HOME/Library/Android/sdk/build-tools/35.0.0}"
AAPT="${AAPT:-$ANDROID_BUILD_TOOLS/aapt}"
APKSIGNER="${APKSIGNER:-$ANDROID_BUILD_TOOLS/apksigner}"
for tool in "$AAPT" "$APKSIGNER"; do
  if [[ ! -x "$tool" ]]; then
    echo "Missing Android build tool: $tool" >&2
    exit 69
  fi
done

KEYSTORE="${MINERADIO_CAR_KEYSTORE:-$PROJECT_DIR/android-car/.signing/mineradio-car.jks}"
KEY_ALIAS="${MINERADIO_CAR_KEY_ALIAS:-mineradio-car}"
if [[ -z "${MINERADIO_CAR_KEYSTORE_PASSWORD:-}" ]]; then
  if [[ -f "$PROJECT_DIR/android-car/.signing/keystore-password.local" ]]; then
    MINERADIO_CAR_KEYSTORE_PASSWORD="$(tr -d '\n' <"$PROJECT_DIR/android-car/.signing/keystore-password.local")"
    export MINERADIO_CAR_KEYSTORE_PASSWORD
  else
    echo "Set MINERADIO_CAR_KEYSTORE_PASSWORD (or keystore-password.local)." >&2
    exit 64
  fi
fi
if [[ ! -f "$KEYSTORE" ]]; then
  echo "Missing keystore: $KEYSTORE" >&2
  exit 66
fi

VERSION_NAME="$($AAPT dump badging "$INPUT_APK" | sed -n "s/^package:.*versionName='\([^']*\)'.*/\1/p")"
if [[ -z "$VERSION_NAME" ]]; then
  echo "Could not read versionName from $INPUT_APK" >&2
  exit 65
fi

OUTPUT_DIR="${OUTPUT_DIR:-$PROJECT_DIR/android-car/out}"
mkdir -p "$OUTPUT_DIR"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mineradio-native-bridge.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT
DECODED_DIR="$WORK_DIR/decoded"
UNSIGNED_APK="$WORK_DIR/Mineradio-${VERSION_NAME}-native-bridge-unsigned.apk"
OUTPUT_APK="$OUTPUT_DIR/Mineradio-${VERSION_NAME}-native-bridge.apk"

# Ensure ProviderClient smali is present (compiled from Java).
if [[ ! -f "$SCRIPT_DIR/smali/com/mineradio/app/car/WallpaperPluginProviderClient.smali" ]]; then
  bash "$SCRIPT_DIR/tools/compile-provider-client.sh"
fi

"$JAVA_BIN" -jar "$APKTOOL_JAR" d -f --output "$DECODED_DIR" "$INPUT_APK"
# WP-05/06 FileProvider + install visibility (not HMI launcher).
node "$SCRIPT_DIR/patch-apk-manifest.js" "$DECODED_DIR/AndroidManifest.xml"
# Wallpaper bridge + ProviderClient + probe Activity only.
node "$SCRIPT_DIR/patch-wallpaper-plugin-bridge.js" "$DECODED_DIR"

"$JAVA_BIN" -jar "$APKTOOL_JAR" b "$DECODED_DIR" -o "$UNSIGNED_APK"
"$APKSIGNER" sign \
  --ks "$KEYSTORE" \
  --ks-key-alias "$KEY_ALIAS" \
  --ks-pass "env:MINERADIO_CAR_KEYSTORE_PASSWORD" \
  --key-pass "env:MINERADIO_CAR_KEYSTORE_PASSWORD" \
  --out "$OUTPUT_APK" \
  "$UNSIGNED_APK"

unzip -tqq "$OUTPUT_APK"
"$APKSIGNER" verify --verbose "$OUTPUT_APK"
"$APKSIGNER" verify --print-certs "$OUTPUT_APK" | tee "$OUTPUT_APK.certs.txt"
# Stock 1.1.7 may already ship CAR_LAUNCHER / assets/mineradio; policy is no extra HMI patch set.
# Prove realCaller client + probe present in some classes*.dex
FOUND_CLIENT=0
FOUND_PROBE=0
while IFS= read -r dex; do
  [[ -z "$dex" ]] && continue
  blob="$(unzip -p "$OUTPUT_APK" "$dex" 2>/dev/null | strings || true)"
  if printf '%s' "$blob" | grep -q 'WallpaperPluginProviderClient'; then FOUND_CLIENT=1; fi
  if printf '%s' "$blob" | grep -q 'WallpaperPluginBridgeProbe'; then FOUND_PROBE=1; fi
done < <(unzip -Z1 "$OUTPUT_APK" | grep -E '^classes[0-9]*\.dex$')
if [[ "$FOUND_CLIENT" -ne 1 ]]; then
  echo "FAIL: WallpaperPluginProviderClient missing from dex" >&2
  exit 1
fi
if [[ "$FOUND_PROBE" -ne 1 ]]; then
  echo "FAIL: probe activity missing from dex" >&2
  exit 1
fi
echo "dex-markers: providerClient=ok probe=ok"
shasum -a 256 "$OUTPUT_APK" | tee "$OUTPUT_APK.sha256"
printf '\nBuilt native-bridge (no HMI): %s\n' "$OUTPUT_APK"
printf 'Note: signing cert differs from stock CN=wuqi; plugin allowlist must use this APK cert.\n'
printf 'Policy: not the HMI-adapted car build; base is stock %s.\n' "$VERSION_NAME"
