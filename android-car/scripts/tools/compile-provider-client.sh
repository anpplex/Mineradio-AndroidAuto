#!/usr/bin/env bash
# Compile WallpaperPluginProviderClient (+ probe Activity) to smali for inject.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
JAVA_SRC="$ROOT/scripts/java"
OUT="$ROOT/scripts/.build/provider-client"
SMALI_DEST="$ROOT/scripts/smali/com/mineradio/app/car"
ANDROID_JAR="${ANDROID_JAR:-$HOME/Library/Android/sdk/platforms/android-34/android.jar}"
D8="${D8:-$HOME/Library/Android/sdk/build-tools/35.0.0/d8}"
AAPT="${AAPT:-$HOME/Library/Android/sdk/build-tools/35.0.0/aapt}"
APKTOOL_JAR="${APKTOOL_JAR:-$ROOT/tools/apktool_3.0.2.jar}"
JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}"
export PATH="$JAVA_HOME/bin:$PATH"

if [[ ! -f "$ANDROID_JAR" || ! -x "$D8" || ! -f "$APKTOOL_JAR" ]]; then
  echo "Missing ANDROID_JAR/d8/apktool" >&2
  exit 69
fi

rm -rf "$OUT"
mkdir -p "$OUT/classes" "$OUT/dex" "$OUT/apkwork"

javac --release 11 -classpath "$ANDROID_JAR" -d "$OUT/classes" \
  "$JAVA_SRC/com/mineradio/app/car/WallpaperPluginProviderClient.java" \
  "$JAVA_SRC/com/mineradio/app/car/WallpaperPluginBridgeProbeActivity.java"

"$D8" --lib "$ANDROID_JAR" --min-api 31 --output "$OUT/dex" \
  $(find "$OUT/classes" -name '*.class')

cat >"$OUT/apkwork/AndroidManifest.xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.mineradio.app.car.stub"
    android:versionCode="1" android:versionName="1">
  <uses-sdk android:minSdkVersion="31" android:targetSdkVersion="34"/>
  <application android:label="stub">
    <activity android:name="com.mineradio.app.car.WallpaperPluginBridgeProbeActivity"/>
  </application>
</manifest>
XML
"$AAPT" package -f -M "$OUT/apkwork/AndroidManifest.xml" -I "$ANDROID_JAR" -F "$OUT/stub.apk"
(cd "$OUT/dex" && zip -q -u "$OUT/stub.apk" classes.dex)
java -jar "$APKTOOL_JAR" d -f -o "$OUT/decoded" "$OUT/stub.apk" >/dev/null

mkdir -p "$SMALI_DEST"
cp -f "$OUT/decoded/smali/com/mineradio/app/car/"*.smali "$SMALI_DEST/"
# Require realCaller marker
grep -q 'realCaller' "$SMALI_DEST/WallpaperPluginProviderClient.smali"
ls -la "$SMALI_DEST"/WallpaperPlugin*.smali
echo "OK: provider client smali → $SMALI_DEST"
