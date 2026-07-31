#!/usr/bin/env bash
# Install the Huawei Android 12 car variant using the proven Lyra installation flow.
# This deliberately installs only the active car-HMI user, then starts the app full-screen.
set -Eeuo pipefail

SERIAL="${1:-LD249H019625}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APK="${2:-$ROOT/android-car/out/Mineradio-1.1.7.0-huawei-android12-car.apk}"
ADB="${ADB:-adb}"
TARGET_USER="${TARGET_USER:-12}"
CLEAN_REINSTALL="${CLEAN_REINSTALL:-0}"
ALLOW_DATA_LOSS_REINSTALL="${ALLOW_DATA_LOSS_REINSTALL:-}"
PACKAGE="com.mineradio.app"
ACTIVITY="$PACKAGE/.LandscapeWebActivity"
INSTALLER="com.huawei.appinstaller.car"
PACKAGE_INSTALLER="com.android.packageinstaller"
REMOTE_APK="/data/local/tmp/Mineradio-1.1.7.0-huawei-android12-car.apk"

if [[ ! -f "$APK" ]]; then
  echo "APK missing: $APK" >&2
  echo "Build it first, or pass the APK as the second argument." >&2
  exit 1
fi

if [[ "$CLEAN_REINSTALL" != "0" && "$CLEAN_REINSTALL" != "1" ]]; then
  echo "CLEAN_REINSTALL must be 0 or 1." >&2
  exit 64
fi
if [[ "$CLEAN_REINSTALL" == "1" && "$ALLOW_DATA_LOSS_REINSTALL" != "YES" ]]; then
  echo "Refusing destructive reinstall. Set ALLOW_DATA_LOSS_REINSTALL=YES after backing up and accepting data loss." >&2
  exit 64
fi

if [[ "$("$ADB" -s "$SERIAL" get-state)" != "device" ]]; then
  echo "ADB device is not ready: $SERIAL" >&2
  exit 1
fi

package_installer_state() {
  local user="$1" disabled_packages
  disabled_packages="$("$ADB" -s "$SERIAL" shell pm list packages --user "$user" -d)"
  if grep -Fxq "package:$PACKAGE_INSTALLER" <<<"$disabled_packages"; then
    echo disabled
  else
    echo enabled
  fi
}

restore_package_installer() {
  local user="$1" state="$2"
  if [[ "$state" == "disabled" ]]; then
    "$ADB" -s "$SERIAL" shell pm disable-user --user "$user" "$PACKAGE_INSTALLER" >/dev/null
  else
    "$ADB" -s "$SERIAL" shell pm enable --user "$user" "$PACKAGE_INSTALLER" >/dev/null
  fi
}

TARGET_INSTALLER_STATE="$(package_installer_state "$TARGET_USER")"
SYSTEM_INSTALLER_STATE="$(package_installer_state 0)"
TARGET_INSTALLER_CHANGED=0
SYSTEM_INSTALLER_CHANGED=0

cleanup() {
  local exit_code=$?
  trap - EXIT
  set +e
  if [[ "$TARGET_INSTALLER_CHANGED" == "1" ]]; then
    restore_package_installer "$TARGET_USER" "$TARGET_INSTALLER_STATE"
  fi
  if [[ "$SYSTEM_INSTALLER_CHANGED" == "1" ]]; then
    restore_package_installer 0 "$SYSTEM_INSTALLER_STATE"
  fi
  "$ADB" -s "$SERIAL" shell rm -f "$REMOTE_APK" >/dev/null
  exit "$exit_code"
}
trap cleanup EXIT

# This is the Lyra car-HMI install flow: push to the shell-owned temporary area,
# temporarily disable PackageInstaller (which otherwise shows an HMI confirmation),
# then attribute installation to Huawei's car installer.
echo "=== install $PACKAGE on $SERIAL (user $TARGET_USER) ==="
"$ADB" -s "$SERIAL" push "$APK" "$REMOTE_APK"

if [[ "$TARGET_INSTALLER_STATE" == "enabled" ]]; then
  "$ADB" -s "$SERIAL" shell pm disable-user --user "$TARGET_USER" "$PACKAGE_INSTALLER"
  TARGET_INSTALLER_CHANGED=1
fi
if [[ "$SYSTEM_INSTALLER_STATE" == "enabled" ]]; then
  "$ADB" -s "$SERIAL" shell pm disable-user --user 0 "$PACKAGE_INSTALLER"
  SYSTEM_INSTALLER_CHANGED=1
fi

if [[ "$CLEAN_REINSTALL" == "1" ]]; then
  echo "=== destructive clean reinstall: removing $PACKAGE data for user $TARGET_USER ===" >&2
  "$ADB" -s "$SERIAL" shell pm uninstall --user "$TARGET_USER" "$PACKAGE"
fi

"$ADB" -s "$SERIAL" shell pm install -r -d -g -t \
  -i "$INSTALLER" --user "$TARGET_USER" "$REMOTE_APK"
"$ADB" -s "$SERIAL" shell pm enable --user "$TARGET_USER" "$PACKAGE" >/dev/null || true

# Restore the original PackageInstaller state before executing the app.
restore_package_installer "$TARGET_USER" "$TARGET_INSTALLER_STATE"
restore_package_installer 0 "$SYSTEM_INSTALLER_STATE"
TARGET_INSTALLER_CHANGED=0
SYSTEM_INSTALLER_CHANGED=0

# The Huawei HMI can otherwise place third-party apps in its secondary pane.
# Some builds return flaky "Error: Activity not started, unknown error code 102"
# on the first am start after pm install — retry a few times.
"$ADB" -s "$SERIAL" shell am force-stop --user "$TARGET_USER" "$PACKAGE"
start_ok=0
for attempt in 1 2 3 4 5; do
  start_out="$("$ADB" -s "$SERIAL" shell am start --user "$TARGET_USER" --windowingMode 1 -W -n "$ACTIVITY" 2>&1 || true)"
  echo "$start_out" | tr -d '\r'
  if grep -qiE 'Status: *ok' <<<"$start_out"; then
    start_ok=1
    break
  fi
  if grep -qiE 'error code 102|Error: Activity not started' <<<"$start_out"; then
    echo "warn: am start attempt $attempt flaky (102); retrying..." >&2
    sleep 1
    "$ADB" -s "$SERIAL" shell am force-stop --user "$TARGET_USER" "$PACKAGE" >/dev/null || true
    sleep 0.5
    continue
  fi
  # Non-102 errors: still try once more then stop retrying this path.
  sleep 0.5
done
if [[ "$start_ok" != "1" ]]; then
  echo "warn: am start did not report Status: ok after retries; package is installed — use verify-huawei-car.sh" >&2
fi

echo "=== installed package ==="
"$ADB" -s "$SERIAL" shell pm path --user "$TARGET_USER" "$PACKAGE"
"$ADB" -s "$SERIAL" shell dumpsys package "$PACKAGE" \
  | grep -E 'versionName|versionCode|installerPackageName' | head -8 || true

echo "OK: $PACKAGE installed for user $TARGET_USER and launched full-screen."
