#!/usr/bin/env bash
# Non-destructive acceptance: Huawei Android 12 car Mineradio launch + HMI smoke.
# Verifies an already-installed car APK; never installs, uninstalls, or wipes app data.
set -Eeuo pipefail

SERIAL="${1:-LD249H019625}"
ADB="${ADB:-adb}"
TARGET_USER="${TARGET_USER:-12}"
EXPECTED_VERSION="${EXPECTED_VERSION:-1.1.7.0}"
PACKAGE="com.mineradio.app"
ACTIVITY="$PACKAGE/.LandscapeWebActivity"
# Seconds to wait for activity resume / optional crash window after start.
SETTLE_SECONDS="${SETTLE_SECONDS:-3}"
# Set SKIP_LOGCAT=1 to skip the FATAL EXCEPTION scan (still non-fatal if logcat is noisy).
SKIP_LOGCAT="${SKIP_LOGCAT:-0}"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

ok() {
  echo "OK: $*"
}

echo "=== verify Huawei car Mineradio on $SERIAL (user $TARGET_USER) ==="

# 1. Device present
if ! state="$("$ADB" -s "$SERIAL" get-state 2>/dev/null)"; then
  fail "ADB cannot reach device: $SERIAL"
fi
if [[ "$state" != "device" ]]; then
  fail "ADB device is not ready: $SERIAL (state=$state)"
fi
ok "device present ($SERIAL)"

# 2. Package installed for TARGET_USER
path_out="$("$ADB" -s "$SERIAL" shell pm path --user "$TARGET_USER" "$PACKAGE" 2>/dev/null || true)"
if [[ -z "$path_out" ]] || ! grep -q "^package:" <<<"$path_out"; then
  fail "package $PACKAGE is not installed for user $TARGET_USER"
fi
ok "package installed for user $TARGET_USER: $(echo "$path_out" | tr -d '\r' | head -1)"

# 3. versionName matches expected car build
pkg_dump="$("$ADB" -s "$SERIAL" shell dumpsys package "$PACKAGE" 2>/dev/null || true)"
version_line="$(grep -E 'versionName=' <<<"$pkg_dump" | head -1 | tr -d '\r' || true)"
if [[ -z "$version_line" ]]; then
  fail "could not read versionName for $PACKAGE"
fi
if ! grep -qE "versionName=${EXPECTED_VERSION}([[:space:]]|$)" <<<"$version_line" \
  && ! grep -qF "versionName=$EXPECTED_VERSION" <<<"$version_line"; then
  fail "expected versionName=$EXPECTED_VERSION, got: $version_line"
fi
ok "versionName=$EXPECTED_VERSION ($version_line)"

# 4. Force-stop + fullscreen start LandscapeWebActivity
# Huawei HMI may place third-party apps in a secondary multi-window pane without --windowingMode 1.
echo "=== force-stop + fullscreen start $ACTIVITY ==="
# Clear logcat before start so the optional FATAL scan only covers post-start noise.
if [[ "$SKIP_LOGCAT" != "1" ]]; then
  "$ADB" -s "$SERIAL" logcat -c 2>/dev/null || true
fi
"$ADB" -s "$SERIAL" shell am force-stop --user "$TARGET_USER" "$PACKAGE"
start_ok=0
start_out=""
for attempt in 1 2 3 4 5; do
  start_out="$("$ADB" -s "$SERIAL" shell am start --user "$TARGET_USER" --windowingMode 1 -W -n "$ACTIVITY" 2>&1 || true)"
  echo "$start_out" | tr -d '\r'
  if grep -qiE 'Status: *ok' <<<"$start_out"; then
    start_ok=1
    break
  fi
  if grep -qiE 'error code 102|Error: Activity not started' <<<"$start_out"; then
    echo "warn: am start attempt $attempt returned 102; retrying..." >&2
    sleep 1
    "$ADB" -s "$SERIAL" shell am force-stop --user "$TARGET_USER" "$PACKAGE" >/dev/null || true
    sleep 0.5
    continue
  fi
  if grep -qiE 'SecurityException|does not exist|Unable to find|Activity class' <<<"$start_out"; then
    fail "am start failed: $start_out"
  fi
  sleep 0.5
done
if [[ "$start_ok" != "1" ]]; then
  fail "am start failed after retries: $start_out"
fi
ok "am start issued for $ACTIVITY (user $TARGET_USER, windowingMode 1)"

# Brief settle so activity can resume before dumpsys / logcat checks.
sleep "$SETTLE_SECONDS"

# 5. dumpsys shows resumed activity
# Prefer activity activities; fall back to window/activity dumps used across Android 12 variants.
activity_dump="$("$ADB" -s "$SERIAL" shell dumpsys activity activities 2>/dev/null || true)"
resumed_hit=0
if grep -qiE "mResumedActivity.*${PACKAGE}/\.?LandscapeWebActivity|ResumedActivity:.*${PACKAGE}/\.?LandscapeWebActivity|topResumedActivity.*${PACKAGE}/\.?LandscapeWebActivity" <<<"$activity_dump"; then
  resumed_hit=1
fi
if [[ "$resumed_hit" -eq 0 ]]; then
  # Some Huawei builds only list component in resumed stack lines.
  if grep -qiE "resumed=true" <<<"$activity_dump" \
    && grep -qiE "${PACKAGE}/\.?LandscapeWebActivity" <<<"$activity_dump"; then
    resumed_hit=1
  fi
fi
if [[ "$resumed_hit" -eq 0 ]]; then
  # Fallback: dumpsys window focused app / activity
  win_dump="$("$ADB" -s "$SERIAL" shell dumpsys window windows 2>/dev/null || true)"
  if grep -qiE "mCurrentFocus.*${PACKAGE}/\.?LandscapeWebActivity|mFocusedApp.*${PACKAGE}/\.?LandscapeWebActivity" <<<"$win_dump"; then
    resumed_hit=1
  fi
fi
if [[ "$resumed_hit" -eq 0 ]]; then
  fail "dumpsys does not show resumed/focused $ACTIVITY for user $TARGET_USER"
fi
ok "dumpsys shows resumed/focused LandscapeWebActivity"

# 6. Optional logcat scan for FATAL EXCEPTION in this package after start
if [[ "$SKIP_LOGCAT" != "1" ]]; then
  echo "=== optional logcat scan for FATAL EXCEPTION ($PACKAGE) ==="
  log_out="$("$ADB" -s "$SERIAL" logcat -d -t 400 2>/dev/null || true)"
  # Classic Android crash banner: "FATAL EXCEPTION: main" then "Process: com.mineradio.app"
  if grep -A8 -F "FATAL EXCEPTION" <<<"$log_out" | grep -qE "Process:[[:space:]]*${PACKAGE}"; then
    echo "$log_out" | grep -A20 -F "FATAL EXCEPTION" | head -40 >&2 || true
    fail "FATAL EXCEPTION (Process: $PACKAGE) detected in logcat after start"
  fi
  # Package name on the same FATAL line (rare) or AndroidRuntime tagged for this package
  if grep -F "FATAL EXCEPTION" <<<"$log_out" | grep -qF "$PACKAGE"; then
    echo "$log_out" | grep -F "FATAL EXCEPTION" -A 20 | head -40 >&2 || true
    fail "FATAL EXCEPTION detected for $PACKAGE in logcat after start"
  fi
  ok "no FATAL EXCEPTION for $PACKAGE in recent logcat"

  # Soft check: legacy illegal top-level SPICaMusic should not appear after car storage patch.
  # Music/SPICaMusic is the legal remapped path and is OK.
  if grep -F "Creating a non-default top level directory" <<<"$log_out" \
    | grep -qF "SPICaMusic"; then
    echo "warn: MediaProvider still rejects top-level SPICaMusic (storage patch may be missing in installed APK)" >&2
  else
    ok "no MediaProvider top-level SPICaMusic rejection in recent logcat"
  fi
else
  ok "logcat scan skipped (SKIP_LOGCAT=1)"
fi

echo "=== acceptance OK ==="
echo "PASS: $PACKAGE user $TARGET_USER version $EXPECTED_VERSION launched full-screen; HMI smoke checks passed."
exit 0
