'use strict';

/**
 * WP-06 / RED-01 — plugin install control + package visibility.
 *
 * RED only: catalog entry + production capacity gaps. Failures prove capacity
 * missing — not path/worktree self-injury. Does not implement production code.
 * Does not claim WP-06 EffectiveDone or raise Core progress above 44%.
 *
 * Spec anchors (read-only):
 *   PROGRESS: weight 6% E1; install action-token / recheck RED fixtures
 *   DEVELOPMENT Task 6: installer Smali / package queries /
 *                       isInstalled/getPluginVersion/installPlugin /
 *                       wallpaper-plugin-installer unit test
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
  finalInfraReceipt,
  wp00MergeReceipt,
  wp01TxnReceipt,
  wp02TxnReceipt,
  wp03TxnReceipt,
  wp04TxnReceipt,
  wp05TxnReceipt,
  wp06TxnReceipt,
  TASK_ID,
  EXPECTED_CURRENT_CORE_PROGRESS,
  EXPECTED_WEIGHT_FROM_PROGRESS_TABLE,
  EXPECTED_PROGRESS_WHEN_DONE,
  WP06_PRODUCTION_CREATE_REL_PATHS,
  WP06_UNIT_TEST_REL_PATHS,
  WP06_SPEC_ACCEPTANCE,
  FailureReason,
  git,
  runRunner,
  parseRunnerJson,
  readJson,
  pathExists,
  liveAuthoritativeBaseSha,
  isGitAncestor,
  readTaskWorktreeIdentity,
  loadWp06CatalogEntry,
  parseWp06CatalogIdentity,
  readPrerequisiteDone,
  liveWp06OperationalProgress,
  assertWp06ProductionSurfacesPresent,
  assertWp06InstallerSmaliPresent,
  assertWp06ManifestInstallCapacity,
  assertWp06BridgeMethodsCapacity,
  assertWp06InstallPluginCapacity,
  assertWp06FullProductionCapacity,
  listMissingProductionCreates,
  attemptCallerForgeEffectiveDone,
  computeCoreProgress,
  defaultDoneReceiptsThroughWp05,
  defaultDoneReceiptsWithWp06,
  initTempWp06Receipt,
  installerUnitTestPath,
  installerSmaliPath,
} = require('./wallpaper-wp06-red-helpers');

// ---------------------------------------------------------------------------
// Environment / prerequisites (must PASS in RED — no self-injury)
// ---------------------------------------------------------------------------

test('WP-06 RED-01: environment paths and tools are real', () => {
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
  assert.equal(pathExists(path.join(repoRoot, 'wallpaper-plugin')), true);
});

test('WP-06 RED-01: worktree branch and live base identity', () => {
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
    assert.equal(identity.liveIsAncestorOfHead, true);
    assert.equal(isGitAncestor(identity.liveBaseSha, identity.head), true);
  } else {
    assert.equal(identity.head, identity.liveBaseSha);
  }
});

test('WP-06 RED-01: prerequisites WP-INFRA / WP-00…WP-05 EffectiveDone', () => {
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
});

test('WP-06 RED-01: WP-05 DONE is required catalog-level prerequisite for WP-06', () => {
  const wp05 = readJson(wp05TxnReceipt);
  assert.equal(wp05.EffectiveDone, true);
  assert.equal(wp05.state, 'DONE');
  assert.equal(wp05.taskId, 'WP-05');
});

// ---------------------------------------------------------------------------
// Catalog (RED: missing or incomplete WP-06 entry is a capacity gap)
// ---------------------------------------------------------------------------

test('WP-06 RED-01.1 catalog must contain unique WP-06 task identity', () => {
  const loaded = loadWp06CatalogEntry();
  if (!loaded.ok) {
    assert.equal(loaded.failureReason, FailureReason.WP06_CATALOG_ENTRY_MISSING);
    assert.fail(
      `${FailureReason.WP06_CATALOG_ENTRY_MISSING}: catalog must register unique WP-06 ` +
        `(weight=${EXPECTED_WEIGHT_FROM_PROGRESS_TABLE}, E1, prereqs INFRA…WP-05)`,
    );
  }
  assert.equal(loaded.ok, true);
  assert.equal(loaded.task.taskId, TASK_ID);
});

test('WP-06 RED-01.2 catalog WP-06 fields must be dynamically parseable', () => {
  const loaded = loadWp06CatalogEntry();
  if (!loaded.ok) {
    assert.fail(`${loaded.failureReason}: catalog WP-06 missing`);
  }
  const parsed = parseWp06CatalogIdentity(loaded.task);
  if (!parsed.ok) {
    assert.equal(parsed.failureReason, FailureReason.WP06_CATALOG_FIELD_MISSING);
    assert.fail(
      `${FailureReason.WP06_CATALOG_FIELD_MISSING}: ${JSON.stringify(parsed.missing)}`,
    );
  }
  assert.equal(loaded.task.weight, EXPECTED_WEIGHT_FROM_PROGRESS_TABLE);
  assert.equal(loaded.task.evidenceLevel, 'E1');
});

// ---------------------------------------------------------------------------
// Transaction / runner (fail-closed; not DONE)
// ---------------------------------------------------------------------------

test('WP-06 RED-01.4 transaction receipt initializes fail-closed (not DONE)', () => {
  assert.equal(pathExists(wp06TxnReceipt), true, 'wp-06.json missing');
  const data = readJson(wp06TxnReceipt);
  assert.equal(data.taskId, TASK_ID);
  // Temp init path is always fail-closed; operational may be DONE only via verifyDone.
  const { receipt, init } = initTempWp06Receipt();
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

test('WP-06 RED-01.5 runner reconcile/init/assert-state for WP-06', () => {
  const { receipt, init } = initTempWp06Receipt();
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

test('WP-06 RED-01.7 production Create surfaces must exist (capacity gap)', () => {
  const r = assertWp06ProductionSurfacesPresent();
  const missing = listMissingProductionCreates();
  if (missing.length) {
    assert.equal(r.ok, false);
    assert.equal(r.failureReason, FailureReason.WP06_PRODUCTION_SURFACE_MISSING);
    assert.fail(
      `${FailureReason.WP06_PRODUCTION_SURFACE_MISSING}: ${missing.join(', ')}`,
    );
  }
  assert.equal(r.ok, true);
});

test('WP-06 RED-01.8 CarWallpaperPluginInstaller.smali production surface', () => {
  const r = assertWp06InstallerSmaliPresent();
  if (!pathExists(installerSmaliPath)) {
    assert.equal(r.failureReason, FailureReason.WP06_INSTALLER_SMALI_MISSING);
    assert.fail(`${FailureReason.WP06_INSTALLER_SMALI_MISSING}: ${installerSmaliPath}`);
  }
  assert.equal(r.ok, true, `${r.failureReason}: ${r.message}`);
});

test('WP-06 RED-01.9 Manifest REQUEST_INSTALL_PACKAGES + package queries', () => {
  const r = assertWp06ManifestInstallCapacity();
  if (!r.ok) {
    assert.fail(`${r.failureReason}: ${r.message}`);
  }
  assert.equal(r.ok, true);
});

test('WP-06 RED-01.10 isInstalled / getPluginVersion / installPlugin methods', () => {
  const r = assertWp06BridgeMethodsCapacity();
  if (!r.ok) {
    assert.equal(r.failureReason, FailureReason.WP06_BRIDGE_METHODS_MISSING);
    assert.fail(`${r.failureReason}: ${r.message}`);
  }
  assert.equal(r.ok, true);
});

test('WP-06 RED-01.11 installPlugin PackageInstaller path (not silent success stub)', () => {
  const r = assertWp06InstallPluginCapacity();
  if (!r.ok) {
    assert.equal(r.failureReason, FailureReason.WP06_INSTALL_PLUGIN_STUB);
    assert.fail(
      `${FailureReason.WP06_INSTALL_PLUGIN_STUB}: content:// only; MIME ` +
        `${WP06_SPEC_ACCEPTANCE.apkMime}; PackageInstaller UI via action-token; ` +
        `recheck package ${WP06_SPEC_ACCEPTANCE.pluginPackage}`,
    );
  }
  assert.equal(r.ok, true);
});

test('WP-06 RED-01.12 wallpaper-plugin-installer unit test must exist', () => {
  assert.equal(
    pathExists(installerUnitTestPath),
    true,
    `${FailureReason.WP06_UNIT_TEST_MISSING}: ${WP06_UNIT_TEST_REL_PATHS[0]}`,
  );
});

test('WP-06 RED-01.13 full production capacity aggregate (stable gap signatures)', () => {
  const r = assertWp06FullProductionCapacity();
  if (!r.ok) {
    assert.match(String(r.failureReason), /^WP06_/);
    assert.equal(r.EffectiveDone, false);
    assert.fail(`${r.failureReason}: ${r.message}`);
  }
  assert.equal(r.ok, true);
});

// ---------------------------------------------------------------------------
// Fail-closed forgery / progress
// ---------------------------------------------------------------------------

test('WP-06 RED-01.15 caller cannot forge EffectiveDone=true', () => {
  // Forge always attempted on temp receipt so operational DONE is never required false.
  const { receipt, init } = initTempWp06Receipt();
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
    JSON.stringify({ EffectiveDone: true, coreProgressPercent: 50 }),
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
  // Operational: if DONE, must be via verifyDone (not caller).
  const op = readJson(wp06TxnReceipt);
  if (op.EffectiveDone === true) {
    assert.ok(op.verifyDone, 'operational DONE requires verifyDone');
  }
});

test('WP-06 RED-01.16 caller cannot forge Core progress via WP-06 receipt', () => {
  const before = computeCoreProgress(defaultDoneReceiptsThroughWp05());
  const bodyBefore = parseRunnerJson(before);
  assert.equal(bodyBefore.coreProgressPercent, EXPECTED_CURRENT_CORE_PROGRESS);

  // Caller forge rejected on temp; progress baseline stays 44 without WP-06 DONE.
  const { receipt, init } = initTempWp06Receipt();
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
    JSON.stringify({ EffectiveDone: true, coreProgressPercent: 50 }),
  ]);
  assert.notEqual(cas.status, 0, cas.combined);
  try {
    fs.unlinkSync(receipt);
  } catch {
    // ignore
  }

  const after = computeCoreProgress(defaultDoneReceiptsWithWp06());
  const bodyAfter = parseRunnerJson(after);
  const op = readJson(wp06TxnReceipt);
  if (op.EffectiveDone === true) {
    assert.equal(bodyAfter.coreProgressPercent, EXPECTED_PROGRESS_WHEN_DONE);
    assert.ok(op.verifyDone);
  } else {
    assert.equal(bodyAfter.coreProgressPercent, EXPECTED_CURRENT_CORE_PROGRESS);
    assert.notEqual(bodyAfter.coreProgressPercent, EXPECTED_PROGRESS_WHEN_DONE);
  }
});

test('WP-06 RED-01.18 evidence / receipt structure remain fail-closed; progress stays 44%', () => {
  const live = liveWp06OperationalProgress();
  // Baseline without WP-06 weight is always 44%.
  const baseline = parseRunnerJson(computeCoreProgress(defaultDoneReceiptsThroughWp05()));
  assert.equal(baseline.coreProgressPercent, EXPECTED_CURRENT_CORE_PROGRESS);
  const prog = parseRunnerJson(computeCoreProgress(defaultDoneReceiptsWithWp06()));
  if (live.EffectiveDone) {
    assert.equal(prog.coreProgressPercent, EXPECTED_PROGRESS_WHEN_DONE);
    assert.ok(live.receipt.verifyDone);
  } else {
    assert.equal(live.expectedCoreProgressPercent, EXPECTED_CURRENT_CORE_PROGRESS);
    assert.equal(prog.coreProgressPercent, 44);
  }
});

test('WP-06 RED-01.19 GREEN surfaces never grant EffectiveDone; progress stays 44%', () => {
  // Even if some surfaces appeared, EffectiveDone only via verify-done.
  const r = assertWp06FullProductionCapacity();
  void r;
  const op = readJson(wp06TxnReceipt);
  if (op.EffectiveDone === true) {
    assert.ok(op.verifyDone, 'surfaces alone cannot DONE');
  }
  const prog = parseRunnerJson(computeCoreProgress(defaultDoneReceiptsThroughWp05()));
  assert.equal(prog.coreProgressPercent, 44);
});

test('WP-06 RED-01.20 WP-07 must not be started', () => {
  const wp07 = path.join(
    '/Users/anpple/Codex/Mineradio',
    'android-car',
    'verification',
    'wallpaper-plugin',
    'transactions',
    'wp-07.json',
  );
  const cat = readJson(catalogPath);
  const cat07 = (cat.tasks || []).find((t) => t && t.taskId === 'WP-07');
  if (cat07) {
    assert.equal(cat07.EffectiveDone, undefined);
    assert.equal(cat07.state, undefined);
  }
  // WP-07 may later exist/DONE only via its own verify-done.
  if (pathExists(wp07)) {
    const r = readJson(wp07);
    if (r.EffectiveDone === true) {
      assert.ok(r.verifyDone, 'WP-07 DONE requires own verifyDone (not WP-06)');
    }
  }
});

test('WP-06 RED-01.21 production Create path list is fixed (Task 6 Files)', () => {
  assert.deepEqual(WP06_PRODUCTION_CREATE_REL_PATHS, [
    'android-car/scripts/smali/com/mineradio/app/car/CarWallpaperPluginInstaller.smali',
  ]);
  assert.deepEqual(WP06_UNIT_TEST_REL_PATHS, [
    'android-car/tests/wallpaper-plugin-installer.test.js',
  ]);
});
