#!/usr/bin/env bash
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
  echo "Java 17+ is required. Set JAVA_HOME to a JDK installation." >&2
  exit 69
fi

APKTOOL_JAR="${APKTOOL_JAR:-$PROJECT_DIR/android-car/tools/apktool_3.0.2.jar}"
if [[ ! -f "$APKTOOL_JAR" ]]; then
  echo "Missing APKTool: $APKTOOL_JAR" >&2
  echo "Download apktool_3.0.2.jar and pass APKTOOL_JAR=/path/to/apktool.jar." >&2
  exit 69
fi

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
KEY_PASSWORD="${MINERADIO_CAR_KEYSTORE_PASSWORD:-}"
if [[ -z "$KEY_PASSWORD" ]]; then
  echo "Set MINERADIO_CAR_KEYSTORE_PASSWORD before building." >&2
  exit 64
fi

VERSION_NAME="$($AAPT dump badging "$INPUT_APK" | sed -n "s/^package:.*versionName='\([^']*\)'.*/\1/p")"
if [[ -z "$VERSION_NAME" ]]; then
  echo "Could not read versionName from $INPUT_APK" >&2
  exit 65
fi

if [[ ! -f "$KEYSTORE" ]]; then
  echo "Missing car signing keystore: $KEYSTORE" >&2
  echo "Refusing to generate a new certificate because it cannot update an existing car install." >&2
  exit 66
fi

OUTPUT_DIR="${OUTPUT_DIR:-$PROJECT_DIR/android-car/out}"
mkdir -p "$OUTPUT_DIR"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mineradio-car.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT
DECODED_DIR="$WORK_DIR/decoded"
UNSIGNED_APK="$WORK_DIR/Mineradio-${VERSION_NAME}-huawei-android12-car-unsigned.apk"
OUTPUT_APK="$OUTPUT_DIR/Mineradio-${VERSION_NAME}-huawei-android12-car.apk"

"$JAVA_BIN" -jar "$APKTOOL_JAR" d -f --output "$DECODED_DIR" "$INPUT_APK"
node "$SCRIPT_DIR/patch-apk-manifest.js" "$DECODED_DIR/AndroidManifest.xml"
node "$SCRIPT_DIR/patch-spica-storage.js" "$DECODED_DIR"
node "$SCRIPT_DIR/patch-audio-focus-bridge.js" "$DECODED_DIR"
# WP-04: WallpaperPlugin Smali bridge + trusted WebView policy injection (fail-closed).
node "$SCRIPT_DIR/patch-wallpaper-plugin-bridge.js" "$DECODED_DIR"
node "$SCRIPT_DIR/patch-car-hmi-assets.js" "$DECODED_DIR"
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
"$AAPT" dump badging "$OUTPUT_APK" | grep -F "launchable-activity: name='com.mineradio.app.LandscapeWebActivity'"
"$AAPT" dump xmltree "$OUTPUT_APK" AndroidManifest.xml | grep -F 'android.intent.category.CAR_LAUNCHER'
"$AAPT" dump xmltree "$OUTPUT_APK" AndroidManifest.xml | grep -F 'android:resizeableActivity'
shasum -a 256 "$OUTPUT_APK" | tee "$OUTPUT_APK.sha256"
printf '\nBuilt: %s\n' "$OUTPUT_APK"
printf 'Important: before installation, verify the APK signing certificate matches the existing com.mineradio.app package.\n'
