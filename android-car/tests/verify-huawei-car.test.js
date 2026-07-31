'use strict';

/**
 * Structure-only checks for verify-huawei-car.sh (bash -n style + required flags).
 * Does not require a physical device or adb — safe for local / CI-less unit runs.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..', '..');
const script = path.join(root, 'android-car', 'scripts', 'verify-huawei-car.sh');

test('verify-huawei-car.sh exists and is executable', () => {
  assert.ok(fs.existsSync(script), `missing ${script}`);
  const mode = fs.statSync(script).mode;
  // Owner or group/other execute bit
  assert.ok((mode & 0o111) !== 0, 'script should be executable');
});

test('verify-huawei-car.sh passes bash -n', () => {
  const result = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('verify-huawei-car.sh encodes required acceptance contract', () => {
  const src = fs.readFileSync(script, 'utf8');

  // Defaults
  assert.match(src, /SERIAL="\$\{1:-LD249H019625\}"/);
  assert.match(src, /TARGET_USER="\$\{TARGET_USER:-12\}"/);
  assert.match(src, /EXPECTED_VERSION="\$\{EXPECTED_VERSION:-1\.1\.7\.0\}"/);
  assert.match(src, /PACKAGE="com\.mineradio\.app"/);
  assert.match(src, /LandscapeWebActivity/);

  // Device + package + version checks
  assert.match(src, /get-state/);
  assert.match(src, /pm path --user "\$TARGET_USER"/);
  assert.match(src, /versionName=/);
  assert.match(src, /1\.1\.7\.0/);

  // Fullscreen launch path (non-destructive: force-stop + start only)
  assert.match(src, /am force-stop --user "\$TARGET_USER"/);
  assert.match(src, /am start --user "\$TARGET_USER" --windowingMode 1 -W -n/);
  assert.match(src, /\$ACTIVITY/);

  // Resumed activity smoke
  assert.match(src, /dumpsys activity activities/);
  assert.match(src, /mResumedActivity|ResumedActivity|topResumedActivity|mCurrentFocus|mFocusedApp/);

  // Optional logcat FATAL scan
  assert.match(src, /FATAL EXCEPTION/);
  assert.match(src, /logcat/);
  assert.match(src, /SKIP_LOGCAT/);

  // Non-destructive executable body: no install/uninstall commands
  const body = src
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  assert.doesNotMatch(body, /\bpm uninstall\b/);
  assert.doesNotMatch(body, /CLEAN_REINSTALL/);
  assert.doesNotMatch(body, /\bpm install\b/);

  // Fail-fast
  assert.match(src, /set -Eeuo pipefail/);
  assert.match(src, /fail\(\)/);
  assert.match(src, /exit 1/);
});

test('verify-huawei-car.sh is non-destructive (no install/uninstall flags in body)', () => {
  const src = fs.readFileSync(script, 'utf8');
  // Strip comments for a slightly stricter scan
  const body = src
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  assert.doesNotMatch(body, /\buninstall\b/i);
  assert.doesNotMatch(body, /\bclean[_-]?reinstall\b/i);
  assert.doesNotMatch(body, /\bpm\s+install\b/);
  assert.doesNotMatch(body, /\badb\s+install\b/);
});
