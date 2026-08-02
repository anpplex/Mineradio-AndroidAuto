'use strict';

/**
 * WP-08 / RED-01 — 队列、公开 WallpaperManager apply/stop、binding 对账.
 *
 * RED only: catalog + plugin sandbox capacity gaps. Does not implement
 * production Kotlin. Does not claim WP-08 EffectiveDone or raise Core above 56%.
 *
 * Spec: Task 8 weight 8 E1; WallpaperQueue / PluginRuntimeState /
 * WallpaperApplyController + public ACTION_CHANGE_LIVE_WALLPAPER path.
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
  pluginSandboxRoot,
  finalInfraReceipt,
  wp00MergeReceipt,
  wp01TxnReceipt,
  wp02TxnReceipt,
  wp03TxnReceipt,
  wp04TxnReceipt,
  wp05TxnReceipt,
  wp06TxnReceipt,
  wp07TxnReceipt,
  wp08TxnReceipt,
  TASK_ID,
  EXPECTED_CURRENT_CORE_PROGRESS,
  EXPECTED_WEIGHT_FROM_PROGRESS_TABLE,
  EXPECTED_PROGRESS_WHEN_DONE,
  WP08_CREATE_REL,
  WP08_MODIFY_REL,
  WP08_PUBLIC_API_MARKERS,
  FailureReason,
  runRunner,
  parseRunnerJson,
  readJson,
  pathExists,
  liveAuthoritativeBaseSha,
  isGitAncestor,
  readTaskWorktreeIdentity,
  loadWp08CatalogEntry,
  parseWp08CatalogIdentity,
  readPrerequisiteDone,
  assertPluginSandboxPresent,
  listMissingCreateSurfaces,
  assertWp08ProductionSurfacesPresent,
  assertWp08QueuePresent,
  assertWp08RuntimeStatePresent,
  assertWp08ApplyControllerPresent,
  assertWp08PublicApiContract,
  assertWp08UnitTestsPresent,
  assertWp08ProviderActivityPresent,
  assertWp08FullProductionCapacity,
  computeCoreProgress,
  defaultDoneReceiptsThroughWp07,
  defaultDoneReceiptsWithWp08,
  liveWp08OperationalProgress,
  attemptCallerForgeEffectiveDone,
  initTempWp08Receipt,
} = require('./wallpaper-wp08-red-helpers');

// ---------------------------------------------------------------------------
// Environment / prerequisites (must PASS in RED)
// ---------------------------------------------------------------------------

test('WP-08 RED-01: environment paths and tools are real', () => {
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
  assert.equal(pathExists(wp07TxnReceipt), true);
  assert.equal(pathExists(path.join(repoRoot, 'wallpaper-plugin')), true);
});

test('WP-08 RED-01: worktree branch and live base identity', () => {
  const identity = readTaskWorktreeIdentity();
  assert.equal(identity.ok, true, JSON.stringify(identity));
  assert.match(identity.branch, /^codex\/wallpaper-plugin-/);
  assert.match(identity.head, /^[0-9a-f]{40}$/);
  assert.equal(identity.liveBaseSha, liveAuthoritativeBaseSha());
  assert.ok(
    identity.relation === 'equal' || identity.relation === 'ahead',
    identity.relation,
  );
  if (identity.relation === 'ahead') {
    assert.equal(isGitAncestor(identity.liveBaseSha, identity.head), true);
  }
});

test('WP-08 RED-01: prerequisites WP-INFRA / WP-00…WP-07 EffectiveDone', () => {
  const prereq = readPrerequisiteDone();
  assert.equal(prereq.ok, true, JSON.stringify(prereq));
  assert.equal(prereq['WP-INFRA'].EffectiveDone, true);
  assert.equal(prereq['WP-INFRA'].EffectiveGate, true);
  assert.equal(prereq['WP-07'].EffectiveDone, true);
  assert.equal(prereq['WP-07'].state, 'DONE');
});

test('WP-08 RED-01: WP-07 DONE is required catalog-level prerequisite', () => {
  const wp07 = readJson(wp07TxnReceipt);
  assert.equal(wp07.EffectiveDone, true);
  assert.equal(wp07.state, 'DONE');
  assert.equal(wp07.taskId, 'WP-07');
  assert.ok(wp07.verifyDone, 'WP-07 DONE requires verifyDone proof');
});

test('WP-08 RED-01: plugin sandbox root exists', () => {
  const r = assertPluginSandboxPresent();
  assert.equal(r.ok, true, r.message || FailureReason.WP08_PLUGIN_SANDBOX_MISSING);
  assert.equal(pathExists(pluginSandboxRoot), true);
});

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

test('WP-08 RED-01.1 catalog must contain unique WP-08 task identity', () => {
  const loaded = loadWp08CatalogEntry();
  if (!loaded.ok) {
    assert.equal(loaded.failureReason, FailureReason.WP08_CATALOG_ENTRY_MISSING);
    assert.fail(
      `${FailureReason.WP08_CATALOG_ENTRY_MISSING}: catalog must register unique WP-08 ` +
        `(weight=${EXPECTED_WEIGHT_FROM_PROGRESS_TABLE}, E1, prereqs INFRA…WP-07)`,
    );
  }
  assert.equal(loaded.task.taskId, TASK_ID);
});

test('WP-08 RED-01.2 catalog WP-08 fields must be dynamically parseable', () => {
  const loaded = loadWp08CatalogEntry();
  if (!loaded.ok) {
    assert.fail(`${loaded.failureReason}: catalog WP-08 missing`);
  }
  const parsed = parseWp08CatalogIdentity(loaded.task);
  if (!parsed.ok) {
    assert.equal(parsed.failureReason, FailureReason.WP08_CATALOG_FIELD_MISSING);
    assert.fail(
      `${FailureReason.WP08_CATALOG_FIELD_MISSING}: ${JSON.stringify(parsed.missing)}`,
    );
  }
  assert.equal(loaded.task.weight, EXPECTED_WEIGHT_FROM_PROGRESS_TABLE);
  assert.equal(loaded.task.evidenceLevel, 'E1');
});

// ---------------------------------------------------------------------------
// Transaction / runner
// ---------------------------------------------------------------------------

test('WP-08 RED-01.4 transaction receipt initializes fail-closed (not DONE)', () => {
  assert.equal(pathExists(wp08TxnReceipt), true, 'wp-08.json missing');
  const data = readJson(wp08TxnReceipt);
  assert.equal(data.taskId, TASK_ID);
  // Temp init path is always fail-closed; operational may be DONE only via verifyDone.
  const { receipt, init } = initTempWp08Receipt();
  assert.equal(init.status, 0, init.combined);
  const temp = readJson(receipt);
  assert.equal(temp.EffectiveDone, false);
  assert.notEqual(temp.state, 'DONE');
  try {
    fs.unlinkSync(receipt);
  } catch {
    // ignore
  }
  if (data.EffectiveDone === true) {
    assert.equal(data.state, 'DONE');
    assert.ok(data.verifyDone, 'operational DONE requires verifyDone proof');
  } else {
    assert.ok(
      ['INIT', 'RED_RECORDED', 'GREEN_RECORDED', 'REFACTOR_RECORDED', 'VERIFY_READY'].includes(
        data.state,
      ),
      data.state,
    );
  }
});

test('WP-08 RED-01.5 runner receipt-init for WP-08', () => {
  const { receipt, init } = initTempWp08Receipt();
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
// Production capacity (must FAIL in RED until GREEN)
// ---------------------------------------------------------------------------

test('WP-08 RED-01.7 production Create surfaces must exist (capacity gap)', () => {
  const r = assertWp08ProductionSurfacesPresent();
  const missing = listMissingCreateSurfaces();
  if (missing.length) {
    assert.equal(r.ok, false);
    assert.equal(r.failureReason, FailureReason.WP08_PRODUCTION_SURFACE_MISSING);
    assert.fail(
      `${FailureReason.WP08_PRODUCTION_SURFACE_MISSING}: ${missing.join(', ')}`,
    );
  }
  assert.equal(r.ok, true);
});

test('WP-08 RED-01.8 WallpaperQueue.kt production surface', () => {
  const r = assertWp08QueuePresent();
  if (!r.ok) {
    assert.equal(r.failureReason, FailureReason.WP08_QUEUE_MISSING);
    assert.fail(`${FailureReason.WP08_QUEUE_MISSING}: ${r.message}`);
  }
  assert.equal(r.ok, true);
});

test('WP-08 RED-01.9 PluginRuntimeState.kt production surface', () => {
  const r = assertWp08RuntimeStatePresent();
  if (!r.ok) {
    assert.equal(r.failureReason, FailureReason.WP08_RUNTIME_STATE_MISSING);
    assert.fail(`${FailureReason.WP08_RUNTIME_STATE_MISSING}: ${r.message}`);
  }
  assert.equal(r.ok, true);
});

test('WP-08 RED-01.10 WallpaperApplyController.kt production surface', () => {
  const r = assertWp08ApplyControllerPresent();
  if (!r.ok) {
    assert.equal(r.failureReason, FailureReason.WP08_APPLY_CONTROLLER_MISSING);
    assert.fail(`${FailureReason.WP08_APPLY_CONTROLLER_MISSING}: ${r.message}`);
  }
  assert.equal(r.ok, true);
});

test('WP-08 RED-01.11 public WallpaperManager apply/stop contract markers', () => {
  const r = assertWp08PublicApiContract();
  if (!r.ok) {
    assert.equal(r.failureReason, FailureReason.WP08_PUBLIC_API_CONTRACT_MISSING);
    assert.fail(
      `${FailureReason.WP08_PUBLIC_API_CONTRACT_MISSING}: need ${WP08_PUBLIC_API_MARKERS.join(',')}`,
    );
  }
  assert.equal(r.ok, true);
});

test('WP-08 RED-01.12 PluginControlProvider + PluginActionActivity modify surfaces', () => {
  const r = assertWp08ProviderActivityPresent();
  if (!r.ok) {
    assert.equal(r.failureReason, FailureReason.WP08_PROVIDER_ACTIVITY_MISSING);
    assert.fail(`${FailureReason.WP08_PROVIDER_ACTIVITY_MISSING}: ${r.message}`);
  }
  assert.equal(r.ok, true);
});

test('WP-08 RED-01.13 WallpaperQueueTest + PluginRuntimeStateTest unit tests', () => {
  const r = assertWp08UnitTestsPresent();
  if (!r.ok) {
    assert.equal(r.failureReason, FailureReason.WP08_UNIT_TEST_MISSING);
    assert.fail(`${FailureReason.WP08_UNIT_TEST_MISSING}: ${r.message}`);
  }
  assert.equal(r.ok, true);
});

test('WP-08 RED-01.14 full production capacity aggregate (stable gap signatures)', () => {
  const r = assertWp08FullProductionCapacity();
  if (!r.ok) {
    assert.match(String(r.failureReason), /^WP08_/);
    assert.equal(r.EffectiveDone, false);
    assert.fail(`${r.failureReason}: ${r.message}`);
  }
  assert.equal(r.ok, true);
});

// ---------------------------------------------------------------------------
// Fail-closed forgery / progress
// ---------------------------------------------------------------------------

test('WP-08 RED-01.15 caller cannot forge EffectiveDone=true', () => {
  // Forge always attempted on temp receipt so operational DONE is never required false.
  const { receipt, init } = initTempWp08Receipt();
  assert.equal(init.status, 0, init.combined);
  const before = readJson(receipt);
  const cas = runRunner([
    'receipt-cas',
    '--receipt',
    receipt,
    '--expected-revision',
    String(before.revision || 1),
    '--expected-state',
    String(before.state || 'INIT'),
    '--state',
    'DONE',
    '--set-json',
    JSON.stringify({ EffectiveDone: true, coreProgressPercent: 64 }),
  ]);
  assert.notEqual(cas.status, 0, cas.combined);
  assert.match(
    cas.combined,
    /ONLY_VERIFY_DONE_MAY_ENABLE_EFFECTIVE_DONE|CALLER|EffectiveDone|ILLEGAL/i,
  );
  assert.equal(readJson(receipt).EffectiveDone, false);
  try {
    fs.unlinkSync(receipt);
  } catch {
    // ignore
  }
  const op = readJson(wp08TxnReceipt);
  if (op.EffectiveDone === true) {
    assert.ok(op.verifyDone, 'operational DONE requires verifyDone');
  }
});

test('WP-08 RED-01.16 caller cannot forge Core progress via WP-08 receipt', () => {
  const before = computeCoreProgress(defaultDoneReceiptsThroughWp07());
  const bodyBefore = parseRunnerJson(before);
  assert.equal(bodyBefore.coreProgressPercent, EXPECTED_CURRENT_CORE_PROGRESS);

  const { receipt, init } = initTempWp08Receipt();
  assert.equal(init.status, 0, init.combined);
  const b = readJson(receipt);
  const cas = runRunner([
    'receipt-cas',
    '--receipt',
    receipt,
    '--expected-revision',
    String(b.revision || 1),
    '--expected-state',
    String(b.state || 'INIT'),
    '--state',
    'DONE',
    '--set-json',
    JSON.stringify({ EffectiveDone: true, coreProgressPercent: 64 }),
  ]);
  assert.notEqual(cas.status, 0, cas.combined);
  try {
    fs.unlinkSync(receipt);
  } catch {
    // ignore
  }

  const after = computeCoreProgress(defaultDoneReceiptsWithWp08());
  const bodyAfter = parseRunnerJson(after);
  const op = readJson(wp08TxnReceipt);
  if (op.EffectiveDone === true) {
    assert.equal(bodyAfter.coreProgressPercent, EXPECTED_PROGRESS_WHEN_DONE);
    assert.ok(op.verifyDone);
  } else {
    assert.equal(bodyAfter.coreProgressPercent, EXPECTED_CURRENT_CORE_PROGRESS);
    assert.notEqual(bodyAfter.coreProgressPercent, EXPECTED_PROGRESS_WHEN_DONE);
  }
});

test('WP-08 RED-01.18 evidence / receipt structure remain fail-closed; progress stays 56%', () => {
  const live = liveWp08OperationalProgress();
  const baseline = parseRunnerJson(computeCoreProgress(defaultDoneReceiptsThroughWp07()));
  assert.equal(baseline.coreProgressPercent, EXPECTED_CURRENT_CORE_PROGRESS);
  const prog = parseRunnerJson(computeCoreProgress(defaultDoneReceiptsWithWp08()));
  if (live.EffectiveDone) {
    assert.equal(prog.coreProgressPercent, EXPECTED_PROGRESS_WHEN_DONE);
    assert.ok(live.receipt.verifyDone);
  } else {
    assert.equal(live.expectedCoreProgressPercent, EXPECTED_CURRENT_CORE_PROGRESS);
    assert.equal(prog.coreProgressPercent, 56);
  }
});

test('WP-08 RED-01.19 GREEN surfaces never grant EffectiveDone; progress stays 56%', () => {
  // Even if some surfaces appeared, EffectiveDone only via verify-done.
  const r = assertWp08FullProductionCapacity();
  void r;
  const op = readJson(wp08TxnReceipt);
  if (op.EffectiveDone === true) {
    assert.ok(op.verifyDone, 'surfaces alone cannot DONE');
  }
  const prog = parseRunnerJson(computeCoreProgress(defaultDoneReceiptsThroughWp07()));
  assert.equal(prog.coreProgressPercent, 56);
});

test('WP-08 RED-01.20 WP-09 must not be started', () => {
  const wp09 = path.join(
    '/Users/anpple/Codex/Mineradio',
    'android-car',
    'verification',
    'wallpaper-plugin',
    'transactions',
    'wp-09.json',
  );
  const cat = readJson(catalogPath);
  const cat09 = (cat.tasks || []).find((t) => t && t.taskId === 'WP-09');
  if (cat09) {
    assert.equal(cat09.EffectiveDone, undefined);
    assert.equal(cat09.state, undefined);
  }
  // WP-09 may later exist/DONE only via its own verify-done.
  if (pathExists(wp09)) {
    const r = readJson(wp09);
    if (r.EffectiveDone === true) {
      assert.ok(r.verifyDone, 'WP-09 DONE requires own verifyDone (not WP-08)');
    }
  }
});

test('WP-08 RED-01.21 production Create path list is fixed (Task 8 Files)', () => {
  assert.deepEqual(WP08_CREATE_REL, [
    'app/src/main/java/com/motif/wallpaperengine/plugin/WallpaperApplyController.kt',
    'app/src/main/java/com/motif/wallpaperengine/plugin/WallpaperQueue.kt',
    'app/src/main/java/com/motif/wallpaperengine/plugin/PluginRuntimeState.kt',
    'app/src/test/java/com/motif/wallpaperengine/plugin/WallpaperQueueTest.kt',
    'app/src/test/java/com/motif/wallpaperengine/plugin/PluginRuntimeStateTest.kt',
  ]);
  assert.deepEqual(WP08_MODIFY_REL, [
    'app/src/main/java/com/motif/wallpaperengine/plugin/PluginControlProvider.kt',
    'app/src/main/java/com/motif/wallpaperengine/plugin/PluginActionActivity.kt',
  ]);
  assert.equal(EXPECTED_WEIGHT_FROM_PROGRESS_TABLE, 8);
  assert.equal(EXPECTED_PROGRESS_WHEN_DONE, 64);
});

test('WP-08 RED-01.22 stable WP08_* failure reason tokens are fixed', () => {
  assert.equal(FailureReason.WP08_CATALOG_ENTRY_MISSING, 'WP08_CATALOG_ENTRY_MISSING');
  assert.equal(FailureReason.WP08_QUEUE_MISSING, 'WP08_QUEUE_MISSING');
  assert.equal(FailureReason.WP08_RUNTIME_STATE_MISSING, 'WP08_RUNTIME_STATE_MISSING');
  assert.equal(FailureReason.WP08_APPLY_CONTROLLER_MISSING, 'WP08_APPLY_CONTROLLER_MISSING');
  assert.equal(
    FailureReason.WP08_PUBLIC_API_CONTRACT_MISSING,
    'WP08_PUBLIC_API_CONTRACT_MISSING',
  );
  assert.equal(
    FailureReason.WP08_PRODUCTION_SURFACE_MISSING,
    'WP08_PRODUCTION_SURFACE_MISSING',
  );
});
