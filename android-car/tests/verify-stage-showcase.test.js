'use strict';

/**
 * Structure-only checks for verify-stage-showcase.sh.
 * Does not require a physical device or adb — safe for local / CI-less unit runs.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..', '..');
const script = path.join(root, 'android-car', 'scripts', 'verify-stage-showcase.sh');

test('verify-stage-showcase.sh exists and is executable', () => {
  assert.ok(fs.existsSync(script), `missing ${script}`);
  const mode = fs.statSync(script).mode;
  assert.ok((mode & 0o111) !== 0, 'script should be executable');
});

test('verify-stage-showcase.sh passes bash -n', () => {
  const result = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('verify-stage-showcase.sh encodes stage smoke contract', () => {
  const src = fs.readFileSync(script, 'utf8');

  assert.match(src, /SERIAL="\$\{1:-LD249H019625\}"/);
  assert.match(src, /TARGET_USER="\$\{TARGET_USER:-12\}"/);
  assert.match(src, /PACKAGE="com\.mineradio\.app"/);
  assert.match(src, /LandscapeWebActivity/);
  assert.match(src, /set -Eeuo pipefail/);

  // Reuses baseline acceptance
  assert.match(src, /verify-huawei-car\.sh/);

  // Screenshots land under verification/ (gitignored)
  assert.match(src, /android-car\/verification|OUT_DIR/);
  assert.match(src, /screencap/);
  assert.match(src, /stage-smoke-/);

  // Stage mode switch + play taps (physical px @ 320dpi)
  assert.match(src, /input -d 0 tap/);
  assert.match(src, /200 985|240 990/);
  assert.match(src, /960 990/);

  // Soft log markers (stage health / duck / native AF)
  assert.match(src, /MineradioCarVisual|stage-health|audio-duck|native-af/);
  assert.match(src, /FATAL EXCEPTION/);
  assert.match(src, /SPICaMusic/);

  // Non-destructive body
  const body = src
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  assert.doesNotMatch(body, /\bpm uninstall\b/);
  assert.doesNotMatch(body, /\bpm install\b/);
  assert.doesNotMatch(body, /CLEAN_REINSTALL/);
  assert.doesNotMatch(body, /\buninstall\b/i);
});
