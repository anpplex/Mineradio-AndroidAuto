#!/usr/bin/env bash
# Non-destructive stage showcase smoke on Huawei car HMI.
# Taps the car visual mode switch, captures screenshots under verification/,
# and scans logcat for stage-health / audio-duck markers.
# Does not install/uninstall or wipe app data.
set -Eeuo pipefail

SERIAL="${1:-LD249H019625}"
ADB="${ADB:-adb}"
TARGET_USER="${TARGET_USER:-12}"
PACKAGE="com.mineradio.app"
ACTIVITY="$PACKAGE/.LandscapeWebActivity"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="${OUT_DIR:-$ROOT/android-car/verification}"
STAMP="$(date +%Y-%m-%d_%H%M%S)"
SETTLE="${SETTLE_SECONDS:-4}"

mkdir -p "$OUT_DIR"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

if [[ "$("$ADB" -s "$SERIAL" get-state 2>/dev/null || true)" != "device" ]]; then
  fail "device not ready: $SERIAL"
fi
ok "device $SERIAL"

# Baseline launch (reuse acceptance launcher path)
"$ROOT/android-car/scripts/verify-huawei-car.sh" "$SERIAL" || fail "baseline verify failed"

"$ADB" -s "$SERIAL" logcat -c 2>/dev/null || true
"$ADB" -s "$SERIAL" shell am force-stop --user "$TARGET_USER" "$PACKAGE"
"$ADB" -s "$SERIAL" shell am start --user "$TARGET_USER" --windowingMode 1 -W -n "$ACTIVITY" >/dev/null
sleep "$SETTLE"

# Dismiss splash (center of 1920x1080)
"$ADB" -s "$SERIAL" shell input -d 0 tap 960 700
sleep 2
"$ADB" -s "$SERIAL" shell input -d 0 tap 960 700
sleep 2

shot() {
  local name="$1"
  local path="$OUT_DIR/${name}-${STAMP}.png"
  "$ADB" -s "$SERIAL" shell screencap -p "/sdcard/${name}.png" || fail "screencap failed: $name"
  "$ADB" -s "$SERIAL" pull "/sdcard/${name}.png" "$path" >/dev/null || fail "pull screenshot failed: $name"
  "$ADB" -s "$SERIAL" shell rm -f "/sdcard/${name}.png" >/dev/null || true
  if [[ ! -s "$path" ]]; then
    fail "screenshot empty or missing: $path"
  fi
  ok "screenshot $path ($(wc -c <"$path" | tr -d ' ') bytes)"
}

shot "stage-smoke-home"

# Stage button is the third segment in bottom-left mode switch (physical px @ 320dpi).
# Try a small grid; physical finger may still be needed if multi-window offsets apply.
for xy in "200 985" "240 990" "180 970" "260 1000" "220 960"; do
  # shellcheck disable=SC2086
  "$ADB" -s "$SERIAL" shell input -d 0 tap $xy
  sleep 0.35
done
sleep 3
shot "stage-smoke-after-stage-tap"

# Play button area (center bottom transport)
"$ADB" -s "$SERIAL" shell input -d 0 tap 960 990
sleep 2
"$ADB" -s "$SERIAL" shell input -d 0 tap 1100 720
sleep 4
shot "stage-smoke-after-play-tap"

# Soft log markers from car-visual-runtime / bridge
log="$("$ADB" -s "$SERIAL" logcat -d -t 500 2>/dev/null || true)"
echo "$log" >"$OUT_DIR/stage-smoke-logcat-${STAMP}.txt"
ok "logcat saved $OUT_DIR/stage-smoke-logcat-${STAMP}.txt"

if grep -qF "FATAL EXCEPTION" <<<"$log" && grep -qF "$PACKAGE" <<<"$log"; then
  fail "FATAL EXCEPTION for $PACKAGE in logcat"
fi
ok "no FATAL for package"

if grep -qiE 'MineradioCarVisual|stage-health|audio-duck|native-af|Showcase' <<<"$log"; then
  ok "found MineradioCarVisual / stage / duck markers in logcat"
else
  echo "warn: no JS console markers in logcat (WebView may not mirror console to logcat)" >&2
fi

if grep -F "Creating a non-default top level directory" <<<"$log" | grep -qF "SPICaMusic"; then
  echo "warn: MediaProvider still rejects top-level SPICaMusic" >&2
else
  ok "no illegal SPICaMusic top-level rejection"
fi

echo "=== stage showcase smoke OK (screenshots local only, not for git) ==="
echo "PASS: stage smoke for $PACKAGE on $SERIAL"
