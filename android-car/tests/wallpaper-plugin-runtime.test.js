'use strict';

/**
 * Task 7 RED contract suite: HMI status card + command queue runtime.
 *
 * Named path from WALLPAPER-PLUGIN-DEVELOPMENT Task 7 Files:
 *   Create: android-car/tests/wallpaper-plugin-runtime.test.js
 *
 * RED: production capacity must fail closed with stable WP07_* signatures.
 * GREEN implements wallpaper-plugin-runtime.js (window.MineradioWallpaperPlugin
 * 1:1 bridge map, status poll, UI states) + patch-car-hmi-assets inject.
 *
 * Fake-bridge fixtures (GREEN must satisfy; RED pins absence):
 *   not-installed, protocol-mismatch, import-success, BUSY×3, TIMEOUT,
 *   page-hide stops poll, no file paths in errors, stable operationId,
 *   stop(targetOperationId), top-level allowlist only, code=20 actionToken,
 *   confirmUserAction once, token-expired renew path, ENGINE_LAUNCHED≠可预览.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  repoRoot,
  runtimePath,
  hmiPatcherPath,
  WP07_SPEC_ACCEPTANCE,
  WP07_METHODS,
  WP07_UI_STATES,
  FailureReason,
  assertWp07RuntimePresent,
  assertWp07RuntimeApiCapacity,
  assertWp07PollContract,
  assertWp07UiStateContract,
  assertWp07HmiInjectCapacity,
  assertWp07ProductionSurfacesPresent,
  assertWp07FullProductionCapacity,
  listMissingProductionCreates,
  pathExists,
  readText,
  readPrerequisiteDone,
  liveAuthoritativeBaseSha,
  readTaskWorktreeIdentity,
} = require('./wallpaper-wp07-red-helpers');

test('runtime RED: prerequisites WP-INFRA…WP-06 DONE (no self-injury)', () => {
  const prereq = readPrerequisiteDone();
  assert.equal(prereq.ok, true, JSON.stringify(prereq));
  assert.equal(prereq['WP-06'].EffectiveDone, true);
  assert.equal(prereq['WP-06'].state, 'DONE');
});

test('runtime RED: live base from origin ls-remote', () => {
  const identity = readTaskWorktreeIdentity();
  assert.equal(identity.ok, true, JSON.stringify(identity));
  const live = liveAuthoritativeBaseSha();
  assert.match(live, /^[0-9a-f]{40}$/);
  assert.equal(identity.liveBaseSha, live);
});

test('runtime RED: Task 7 Create surfaces missing → WP07_PRODUCTION_SURFACE_MISSING', () => {
  const r = assertWp07ProductionSurfacesPresent();
  const missing = listMissingProductionCreates();
  if (missing.length) {
    assert.equal(r.ok, false);
    assert.equal(r.failureReason, FailureReason.WP07_PRODUCTION_SURFACE_MISSING);
    assert.equal(r.EffectiveDone, false);
    assert.match(
      `${r.failureReason}: ${r.message}`,
      /WP07_PRODUCTION_SURFACE_MISSING/,
    );
  } else {
    assert.equal(r.ok, true);
    assert.notEqual(r.EffectiveDone, true);
  }
});

test('runtime RED: wallpaper-plugin-runtime.js capacity', () => {
  const r = assertWp07RuntimePresent();
  if (!pathExists(runtimePath)) {
    assert.equal(r.ok, false);
    assert.equal(r.failureReason, FailureReason.WP07_RUNTIME_MISSING);
    assert.fail(
      `${FailureReason.WP07_RUNTIME_MISSING}: ${runtimePath}`,
    );
  }
  assert.equal(r.ok, true, `${r.failureReason}: ${r.message}`);
});

test('runtime RED: MineradioWallpaperPlugin 1:1 bridge API (no second protocol)', () => {
  const r = assertWp07RuntimeApiCapacity();
  if (!r.ok) {
    assert.match(
      String(r.failureReason),
      /WP07_RUNTIME_MISSING|WP07_RUNTIME_API_MISSING/,
    );
    assert.fail(
      `${r.failureReason}: ${r.message || ''} — global=${WP07_SPEC_ACCEPTANCE.globalName}; ` +
        `methods=${WP07_METHODS.join(',')}`,
    );
  }
  assert.equal(r.ok, true);
  const text = readText(runtimePath);
  assert.ok(text.includes(WP07_SPEC_ACCEPTANCE.globalName));
  for (const m of WP07_METHODS) {
    assert.ok(text.includes(m), `missing method surface: ${m}`);
  }
});

test('runtime RED: status poll 500ms/5s + stop on page hide', () => {
  const r = assertWp07PollContract();
  if (!r.ok) {
    assert.equal(r.failureReason, FailureReason.WP07_POLL_CONTRACT_MISSING);
    assert.fail(
      `${FailureReason.WP07_POLL_CONTRACT_MISSING}: active=${WP07_SPEC_ACCEPTANCE.pollActiveMs}ms ` +
        `idle=${WP07_SPEC_ACCEPTANCE.pollIdleMs}ms; visibilitychange/hidden stop`,
    );
  }
  assert.equal(r.ok, true);
});

test('runtime RED: 11 UI states; ENGINE_LAUNCHED must not map to 可预览', () => {
  const r = assertWp07UiStateContract();
  if (!r.ok) {
    assert.equal(r.failureReason, FailureReason.WP07_UI_STATE_CONTRACT_MISSING);
    assert.fail(
      `${FailureReason.WP07_UI_STATE_CONTRACT_MISSING}: ${r.message} — states: ` +
        WP07_UI_STATES.join(' | '),
    );
  }
  assert.equal(r.ok, true);
});

test('runtime RED: patch-car-hmi-assets inject runtime + status card', () => {
  const r = assertWp07HmiInjectCapacity();
  if (!r.ok) {
    assert.equal(r.failureReason, FailureReason.WP07_HMI_INJECT_MISSING);
    assert.fail(
      `${FailureReason.WP07_HMI_INJECT_MISSING}: ${r.message}`,
    );
  }
  assert.equal(r.ok, true);
  const text = readText(hmiPatcherPath);
  assert.ok(text.includes('wallpaper-plugin-runtime.js'));
});

test('runtime RED: stable WP07_* failure reason tokens are fixed', () => {
  assert.equal(FailureReason.WP07_RUNTIME_MISSING, 'WP07_RUNTIME_MISSING');
  assert.equal(FailureReason.WP07_RUNTIME_API_MISSING, 'WP07_RUNTIME_API_MISSING');
  assert.equal(FailureReason.WP07_POLL_CONTRACT_MISSING, 'WP07_POLL_CONTRACT_MISSING');
  assert.equal(
    FailureReason.WP07_UI_STATE_CONTRACT_MISSING,
    'WP07_UI_STATE_CONTRACT_MISSING',
  );
  assert.equal(FailureReason.WP07_HMI_INJECT_MISSING, 'WP07_HMI_INJECT_MISSING');
  assert.equal(
    FailureReason.WP07_PRODUCTION_SURFACE_MISSING,
    'WP07_PRODUCTION_SURFACE_MISSING',
  );
});

test('runtime RED: full production capacity aggregate fail-closed', () => {
  const r = assertWp07FullProductionCapacity();
  if (!r.ok) {
    assert.match(String(r.failureReason), /^WP07_/);
    assert.equal(r.EffectiveDone, false);
    assert.fail(`${r.failureReason}: ${r.message}`);
  }
  assert.equal(r.ok, true);
  assert.notEqual(r.EffectiveDone, true);
});

test('runtime RED/GREEN: fake-bridge fixtures must pass (Task 7 coverage)', () => {
  // GREEN exports createFakeBridge / runFakeBridgeFixtures / assertRuntimeFixtures.
  if (!pathExists(runtimePath)) {
    assert.fail(
      `${FailureReason.WP07_RUNTIME_MISSING}: fake-bridge fixtures require ` +
        `wallpaper-plugin-runtime.js (not-installed, protocol-mismatch, import-success, ` +
        `BUSY×3, TIMEOUT, page-hide-stop-poll, no-path-in-errors, stable-operationId, ` +
        `stop+targetOperationId, top-level-allowlist, code20+actionToken, ` +
        `confirmUserAction-once, token-expired renew, ENGINE_LAUNCHED≠可预览)`,
    );
  }
  // eslint-disable-next-line import/no-dynamic-require, global-require
  let runtime;
  try {
    runtime = require(runtimePath);
  } catch (err) {
    assert.fail(
      `${FailureReason.WP07_RUNTIME_API_MISSING}: require runtime failed: ${err.message}`,
    );
  }
  assert.equal(typeof runtime.createFakeBridge, 'function');
  assert.equal(typeof runtime.runFakeBridgeFixtures, 'function');
  assert.equal(typeof runtime.assertRuntimeFixtures, 'function');
  const result = runtime.assertRuntimeFixtures();
  assert.equal(result.ok, true, result.message || JSON.stringify(result.failed));
  assert.equal(result.POLL_ACTIVE_MS, 500);
  assert.equal(result.POLL_IDLE_MS, 5000);
  assert.equal(result.forbidEngineLaunchedPreview, true);
});

test('runtime RED: touch target + settings-only entry contract tokens', () => {
  if (!pathExists(runtimePath)) {
    assert.fail(
      `${FailureReason.WP07_RUNTIME_MISSING}: need minTouchCssPx=${WP07_SPEC_ACCEPTANCE.minTouchCssPx} ` +
        `minPrimaryCssPx=${WP07_SPEC_ACCEPTANCE.minPrimaryCssPx}; settingsOnlyEntry; ` +
        `noDefaultPlaybackMainOps`,
    );
  }
  const text = readText(runtimePath);
  const need = [
    String(WP07_SPEC_ACCEPTANCE.minTouchCssPx),
    String(WP07_SPEC_ACCEPTANCE.minPrimaryCssPx),
  ];
  const missing = need.filter((s) => !text.includes(s));
  if (
    missing.length ||
    (!/settings|实验|settingsOnly|settings-only/i.test(text) &&
      !/noDefaultPlayback|主操作/.test(text))
  ) {
    assert.fail(
      `${FailureReason.WP07_UI_STATE_CONTRACT_MISSING}: touch/settings entry contract incomplete ` +
        `(missing ${missing.join(',') || 'settings-only markers'})`,
    );
  }
});

test('runtime RED: module must not live under wrong path', () => {
  // Guard against accidental placement outside scripts/.
  const wrong = path.join(repoRoot, 'android-car', 'wallpaper-plugin-runtime.js');
  assert.equal(pathExists(wrong), false, 'runtime must not sit at android-car root');
  assert.equal(
    WP07_SPEC_ACCEPTANCE.globalName,
    'MineradioWallpaperPlugin',
  );
});
