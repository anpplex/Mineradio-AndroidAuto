'use strict';

/**
 * WP-07 / RED-01 — 车机 HMI 状态卡与命令队列 / 轮询 runtime.
 *
 * RED only: catalog entry + production capacity gaps. Failures prove capacity
 * missing — not path/worktree self-injury. Does not implement production code.
 * Does not claim WP-07 EffectiveDone or raise Core progress above 50%.
 *
 * Spec anchors (read-only):
 *   PROGRESS: weight 6% E1; HMI status card + poll runtime
 *   DEVELOPMENT Task 7: wallpaper-plugin-runtime.js /
 *                       window.MineradioWallpaperPlugin 1:1 bridge map /
 *                       status poll 500ms/5s / UI states / fake-bridge fixtures
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  repoRoot,
  runnerPath,
  catalogPath,
  schemaPath,
  runtimePath,
  hmiPatcherPath,
  runtimeTestPath,
  finalInfraReceipt,
  wp00MergeReceipt,
  wp01TxnReceipt,
  wp02TxnReceipt,
  wp03TxnReceipt,
  wp04TxnReceipt,
  wp05TxnReceipt,
  wp06TxnReceipt,
  wp07TxnReceipt,
  TASK_ID,
  EXPECTED_CURRENT_CORE_PROGRESS,
  EXPECTED_WEIGHT_FROM_PROGRESS_TABLE,
  EXPECTED_PROGRESS_WHEN_DONE,
  WP07_PRODUCTION_CREATE_REL_PATHS,
  WP07_UNIT_TEST_REL_PATHS,
  WP07_SPEC_ACCEPTANCE,
  WP07_METHODS,
  WP07_UI_STATES,
  FailureReason,
  git,
  runRunner,
  parseRunnerJson,
  readJson,
  pathExists,
  liveAuthoritativeBaseSha,
  isGitAncestor,
  readTaskWorktreeIdentity,
  loadWp07CatalogEntry,
  parseWp07CatalogIdentity,
  readPrerequisiteDone,
  liveWp07OperationalProgress,
  assertWp07ProductionSurfacesPresent,
  assertWp07RuntimePresent,
  assertWp07RuntimeApiCapacity,
  assertWp07PollContract,
  assertWp07UiStateContract,
  assertWp07HmiInjectCapacity,
  assertWp07FullProductionCapacity,
  listMissingProductionCreates,
  attemptCallerForgeEffectiveDone,
  computeCoreProgress,
  defaultDoneReceiptsThroughWp06,
  defaultDoneReceiptsWithWp07,
  initTempWp07Receipt,
} = require('./wallpaper-wp07-red-helpers');

// ---------------------------------------------------------------------------
// Environment / prerequisites (must PASS in RED — no self-injury)
// ---------------------------------------------------------------------------

test('WP-07 RED-01: environment paths and tools are real', () => {
  assert.equal(pathExists(runnerPath), true, 'runner missing');
  assert.equal(pathExists(catalogPath), true, 'catalog missing');
  assert.equal(pathExists(schemaPath), true, 'schema missing');
  assert.equal(pathExists(finalInfraReceipt), true);
  assert.equal(pathExists(wp00MergeReceipt), true);
  assert.equal(pathExists(wp01TxnReceipt), true);
  assert.equal(pathExists(wp02TxnReceipt), true);
  assert.equal(pathExists(wp03TxnReceipt), true);
  assert.equal(pathExists(wp04TxnReceipt), true);
  assert.equal(pathExists(wp05TxnReceipt), true);
  assert.equal(pathExists(wp06TxnReceipt), true);
  assert.equal(pathExists(hmiPatcherPath), true, 'patch-car-hmi-assets.js missing');
  assert.equal(pathExists(path.join(repoRoot, 'wallpaper-plugin')), true);
});

test('WP-07 RED-01: worktree branch and live base identity', () => {
  const identity = readTaskWorktreeIdentity();
  assert.equal(identity.ok, true, JSON.stringify(identity));
  assert.match(
    identity.branch,
    /^codex\/wallpaper-plugin-/,
    `unexpected task branch: ${identity.branch}`,
  );
  assert.match(identity.head, /^[0-9a-f]{40}$/);
  assert.match(identity.liveBaseSha, /^[0-9a-f]{40}$/);
  assert.equal(identity.liveBaseSha, liveAuthoritativeBaseSha());
  assert.ok(
    identity.relation === 'equal' || identity.relation === 'ahead',
    `unexpected relation: ${identity.relation}`,
  );
  if (identity.relation === 'ahead') {
    assert.equal(isGitAncestor(identity.liveBaseSha, identity.head), true);
  } else {
    assert.equal(identity.head, identity.liveBaseSha);
  }
});

test('WP-07 RED-01: prerequisites WP-INFRA / WP-00…WP-06 EffectiveDone', () => {
  const prereq = readPrerequisiteDone();
  assert.equal(prereq.ok, true, JSON.stringify(prereq));
  assert.equal(prereq['WP-INFRA'].EffectiveDone, true);
  assert.equal(prereq['WP-INFRA'].EffectiveGate, true);
  assert.equal(prereq['WP-00'].EffectiveDone, true);
  assert.equal(prereq['WP-01'].EffectiveDone, true);
  assert.equal(prereq['WP-02'].EffectiveDone, true);
  assert.equal(prereq['WP-03'].EffectiveDone, true);
  assert.equal(prereq['WP-04'].EffectiveDone, true);
  assert.equal(prereq['WP-05'].EffectiveDone, true);
  assert.equal(prereq['WP-05'].state, 'DONE');
  assert.equal(prereq['WP-06'].EffectiveDone, true);
  assert.equal(prereq['WP-06'].state, 'DONE');
});

test('WP-07 RED-01: WP-06 DONE is required catalog-level prerequisite for WP-07', () => {
  const wp06 = readJson(wp06TxnReceipt);
  assert.equal(wp06.EffectiveDone, true);
  assert.equal(wp06.state, 'DONE');
  assert.equal(wp06.taskId, 'WP-06');
});

// ---------------------------------------------------------------------------
// Catalog (RED: missing or incomplete WP-07 entry is a capacity gap)
// ---------------------------------------------------------------------------

test('WP-07 RED-01.1 catalog must contain unique WP-07 task identity', () => {
  const loaded = loadWp07CatalogEntry();
  if (!loaded.ok) {
    assert.equal(loaded.failureReason, FailureReason.WP07_CATALOG_ENTRY_MISSING);
    assert.fail(
      `${FailureReason.WP07_CATALOG_ENTRY_MISSING}: catalog must register unique WP-07 ` +
        `(weight=${EXPECTED_WEIGHT_FROM_PROGRESS_TABLE}, E1, prereqs INFRA…WP-06)`,
    );
  }
  assert.equal(loaded.ok, true);
  assert.equal(loaded.task.taskId, TASK_ID);
});

test('WP-07 RED-01.2 catalog WP-07 fields must be dynamically parseable', () => {
  const loaded = loadWp07CatalogEntry();
  if (!loaded.ok) {
    assert.fail(`${loaded.failureReason}: catalog WP-07 missing`);
  }
  const parsed = parseWp07CatalogIdentity(loaded.task);
  if (!parsed.ok) {
    assert.equal(parsed.failureReason, FailureReason.WP07_CATALOG_FIELD_MISSING);
    assert.fail(
      `${FailureReason.WP07_CATALOG_FIELD_MISSING}: ${JSON.stringify(parsed.missing)}`,
    );
  }
  assert.equal(loaded.task.weight, EXPECTED_WEIGHT_FROM_PROGRESS_TABLE);
  assert.equal(loaded.task.evidenceLevel, 'E1');
});

// ---------------------------------------------------------------------------
// Transaction / runner (fail-closed; not DONE)
// ---------------------------------------------------------------------------

test('WP-07 RED-01.4 transaction receipt initializes fail-closed (not DONE)', () => {
  assert.equal(pathExists(wp07TxnReceipt), true, 'wp-07.json missing');
  const data = readJson(wp07TxnReceipt);
  assert.equal(data.taskId, TASK_ID);
  assert.equal(data.EffectiveDone, false);
  assert.notEqual(data.state, 'DONE');
  assert.ok(
    ['INIT', 'RED_RECORDED', 'GREEN_RECORDED', 'REFACTOR_RECORDED', 'VERIFY_READY'].includes(
      data.state,
    ),
    data.state,
  );
});

test('WP-07 RED-01.5 runner reconcile/init/assert-state for WP-07', () => {
  const { receipt, init } = initTempWp07Receipt();
  assert.equal(init.status, 0, init.combined);
  const body = parseRunnerJson(init);
  assert.equal(body && body.ok, true, init.combined);
  const data = readJson(receipt);
  assert.equal(data.taskId, TASK_ID);
  assert.equal(data.EffectiveDone, false);
  try {
    fs.unlinkSync(receipt);
  } catch {
    // ignore
  }
});

// ---------------------------------------------------------------------------
// Production Create capacity (must FAIL in RED until GREEN)
// ---------------------------------------------------------------------------

test('WP-07 RED-01.7 production Create surfaces must exist (capacity gap)', () => {
  const r = assertWp07ProductionSurfacesPresent();
  const missing = listMissingProductionCreates();
  if (missing.length) {
    assert.equal(r.ok, false);
    assert.equal(r.failureReason, FailureReason.WP07_PRODUCTION_SURFACE_MISSING);
    assert.fail(
      `${FailureReason.WP07_PRODUCTION_SURFACE_MISSING}: ${missing.join(', ')}`,
    );
  }
  assert.equal(r.ok, true);
});

test('WP-07 RED-01.8 wallpaper-plugin-runtime.js production surface', () => {
  const r = assertWp07RuntimePresent();
  if (!pathExists(runtimePath)) {
    assert.equal(r.failureReason, FailureReason.WP07_RUNTIME_MISSING);
    assert.fail(`${FailureReason.WP07_RUNTIME_MISSING}: ${runtimePath}`);
  }
  assert.equal(r.ok, true, `${r.failureReason}: ${r.message}`);
});

test('WP-07 RED-01.9 MineradioWallpaperPlugin 1:1 bridge method map', () => {
  const r = assertWp07RuntimeApiCapacity();
  if (!r.ok) {
    assert.match(
      String(r.failureReason),
      /WP07_RUNTIME_MISSING|WP07_RUNTIME_API_MISSING/,
    );
    assert.fail(
      `${r.failureReason}: ${r.message || ''} — need window.${WP07_SPEC_ACCEPTANCE.globalName} ` +
        `mapping ${WP07_METHODS.join(',')}; no second protocol`,
    );
  }
  assert.equal(r.ok, true);
});

test('WP-07 RED-01.10 status poll contract (500ms active / 5s idle / stop on hide)', () => {
  const r = assertWp07PollContract();
  if (!r.ok) {
    assert.equal(r.failureReason, FailureReason.WP07_POLL_CONTRACT_MISSING);
    assert.fail(
      `${FailureReason.WP07_POLL_CONTRACT_MISSING}: pollActiveMs=${WP07_SPEC_ACCEPTANCE.pollActiveMs} ` +
        `pollIdleMs=${WP07_SPEC_ACCEPTANCE.pollIdleMs}; stopPollingWhenHidden`,
    );
  }
  assert.equal(r.ok, true);
});

test('WP-07 RED-01.11 UI state contract (11 allowed states; ENGINE_LAUNCHED≠可预览)', () => {
  const r = assertWp07UiStateContract();
  if (!r.ok) {
    assert.equal(r.failureReason, FailureReason.WP07_UI_STATE_CONTRACT_MISSING);
    assert.fail(
      `${FailureReason.WP07_UI_STATE_CONTRACT_MISSING}: need all of [${WP07_UI_STATES.join(' | ')}] ` +
        `and forbid ENGINE_LAUNCHED→可预览`,
    );
  }
  assert.equal(r.ok, true);
});

test('WP-07 RED-01.12 patch-car-hmi-assets inject runtime + status card', () => {
  const r = assertWp07HmiInjectCapacity();
  if (!r.ok) {
    assert.equal(r.failureReason, FailureReason.WP07_HMI_INJECT_MISSING);
    assert.fail(
      `${FailureReason.WP07_HMI_INJECT_MISSING}: ${r.message} — inject wallpaper-plugin-runtime.js ` +
        `+ status card into MENC/settings experimental zone`,
    );
  }
  assert.equal(r.ok, true);
});

test('WP-07 RED-01.13 wallpaper-plugin-runtime unit test must exist', () => {
  assert.equal(
    pathExists(runtimeTestPath),
    true,
    `${FailureReason.WP07_UNIT_TEST_MISSING}: ${WP07_UNIT_TEST_REL_PATHS[0]}`,
  );
});

test('WP-07 RED-01.14 full production capacity aggregate (stable gap signatures)', () => {
  const r = assertWp07FullProductionCapacity();
  if (!r.ok) {
    assert.match(String(r.failureReason), /^WP07_/);
    assert.equal(r.EffectiveDone, false);
    assert.fail(`${r.failureReason}: ${r.message}`);
  }
  assert.equal(r.ok, true);
});

// ---------------------------------------------------------------------------
// Fail-closed forgery / progress
// ---------------------------------------------------------------------------

test('WP-07 RED-01.15 caller cannot forge EffectiveDone=true', () => {
  const forge = attemptCallerForgeEffectiveDone();
  assert.equal(forge.ok, true, forge.combined || forge.failureReason);
  assert.equal(readJson(wp07TxnReceipt).EffectiveDone, false);
});

test('WP-07 RED-01.16 caller cannot forge Core progress via WP-07 receipt', () => {
  const before = computeCoreProgress(defaultDoneReceiptsThroughWp06());
  const bodyBefore = parseRunnerJson(before);
  assert.equal(bodyBefore.coreProgressPercent, EXPECTED_CURRENT_CORE_PROGRESS);

  const forge = attemptCallerForgeEffectiveDone();
  assert.equal(forge.ok, true, forge.combined);

  const after = computeCoreProgress(defaultDoneReceiptsWithWp07());
  const bodyAfter = parseRunnerJson(after);
  assert.equal(bodyAfter.coreProgressPercent, EXPECTED_CURRENT_CORE_PROGRESS);
  assert.notEqual(bodyAfter.coreProgressPercent, EXPECTED_PROGRESS_WHEN_DONE);
});

test('WP-07 RED-01.18 evidence / receipt structure remain fail-closed; progress stays 50%', () => {
  const live = liveWp07OperationalProgress();
  assert.equal(live.EffectiveDone, false);
  assert.equal(live.expectedCoreProgressPercent, EXPECTED_CURRENT_CORE_PROGRESS);
  const prog = parseRunnerJson(computeCoreProgress(defaultDoneReceiptsWithWp07()));
  assert.equal(prog.coreProgressPercent, 50);
});

test('WP-07 RED-01.19 GREEN surfaces never grant EffectiveDone; progress stays 50%', () => {
  // Even if some surfaces appeared, EffectiveDone only via verify-done.
  const r = assertWp07FullProductionCapacity();
  void r;
  assert.equal(readJson(wp07TxnReceipt).EffectiveDone, false);
  const prog = parseRunnerJson(computeCoreProgress(defaultDoneReceiptsThroughWp06()));
  assert.equal(prog.coreProgressPercent, 50);
});

test('WP-07 RED-01.20 WP-08 must not be started', () => {
  const wp08 = path.join(
    '/Users/anpple/Codex/Mineradio',
    'android-car',
    'verification',
    'wallpaper-plugin',
    'transactions',
    'wp-08.json',
  );
  assert.equal(pathExists(wp08), false, 'WP-08 transaction must not exist yet');
});

test('WP-07 RED-01.21 production Create path list is fixed (Task 7 Files)', () => {
  assert.deepEqual(WP07_PRODUCTION_CREATE_REL_PATHS, [
    'android-car/scripts/wallpaper-plugin-runtime.js',
  ]);
  assert.deepEqual(WP07_UNIT_TEST_REL_PATHS, [
    'android-car/tests/wallpaper-plugin-runtime.test.js',
  ]);
  assert.equal(WP07_SPEC_ACCEPTANCE.globalName, 'MineradioWallpaperPlugin');
  assert.equal(WP07_SPEC_ACCEPTANCE.pollActiveMs, 500);
  assert.equal(WP07_SPEC_ACCEPTANCE.pollIdleMs, 5000);
  assert.equal(WP07_METHODS.length, 11);
  assert.equal(WP07_UI_STATES.length, 11);
});

test('WP-07 RED-01.22 stable WP07_* failure reason tokens are fixed', () => {
  assert.equal(FailureReason.WP07_CATALOG_ENTRY_MISSING, 'WP07_CATALOG_ENTRY_MISSING');
  assert.equal(FailureReason.WP07_RUNTIME_MISSING, 'WP07_RUNTIME_MISSING');
  assert.equal(FailureReason.WP07_RUNTIME_API_MISSING, 'WP07_RUNTIME_API_MISSING');
  assert.equal(FailureReason.WP07_HMI_INJECT_MISSING, 'WP07_HMI_INJECT_MISSING');
  assert.equal(FailureReason.WP07_POLL_CONTRACT_MISSING, 'WP07_POLL_CONTRACT_MISSING');
  assert.equal(
    FailureReason.WP07_UI_STATE_CONTRACT_MISSING,
    'WP07_UI_STATE_CONTRACT_MISSING',
  );
  assert.equal(
    FailureReason.WP07_PRODUCTION_SURFACE_MISSING,
    'WP07_PRODUCTION_SURFACE_MISSING',
  );
});
