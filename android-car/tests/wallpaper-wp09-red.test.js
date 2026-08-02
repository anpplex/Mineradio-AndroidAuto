'use strict';

/**
 * WP-09 / RED-01 — 双仓签名闭环、三包/split 同签名静态 verifier.
 *
 * RED only: catalog + production capacity gaps. Failures prove capacity missing.
 * Does not claim EffectiveDone or raise Core above 64%.
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
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
  wp07TxnReceipt,
  wp08TxnReceipt,
  wp09TxnReceipt,
  TASK_ID,
  EXPECTED_CURRENT_CORE_PROGRESS,
  EXPECTED_WEIGHT_FROM_PROGRESS_TABLE,
  EXPECTED_PROGRESS_WHEN_DONE,
  WP09_CREATE_REL,
  WP09_STATIC_MARKERS,
  FailureReason,
  parseRunnerJson,
  readJson,
  pathExists,
  liveAuthoritativeBaseSha,
  isGitAncestor,
  readTaskWorktreeIdentity,
  loadWp09CatalogEntry,
  parseWp09CatalogIdentity,
  readPrerequisiteDone,
  listMissingCreates,
  assertWp09ProductionSurfacesPresent,
  assertWp09VerifierJsPresent,
  assertWp09VerifierShPresent,
  assertWp09UnitTestPresent,
  assertWp09TransactionToolPresent,
  assertWp09TransactionTestPresent,
  assertWp09StaticContract,
  assertWp09MismatchFixtures,
  assertWp09FullProductionCapacity,
  computeCoreProgress,
  defaultDoneReceiptsThroughWp08,
  defaultDoneReceiptsWithWp09,
  liveWp09OperationalProgress,
  attemptCallerForgeEffectiveDone,
  initTempWp09Receipt,
  runRunner,
} = require('./wallpaper-wp09-red-helpers');

test('WP-09 RED-01: environment paths and tools are real', () => {
  assert.equal(pathExists(runnerPath), true);
  assert.equal(pathExists(catalogPath), true);
  assert.equal(pathExists(schemaPath), true);
  assert.equal(pathExists(finalInfraReceipt), true);
  assert.equal(pathExists(wp08TxnReceipt), true);
});

test('WP-09 RED-01: worktree branch and live base identity', () => {
  const identity = readTaskWorktreeIdentity();
  assert.equal(identity.ok, true, JSON.stringify(identity));
  assert.match(identity.branch, /^codex\/wallpaper-plugin-/);
  assert.equal(identity.liveBaseSha, liveAuthoritativeBaseSha());
  assert.ok(identity.relation === 'equal' || identity.relation === 'ahead');
  if (identity.relation === 'ahead') {
    assert.equal(isGitAncestor(identity.liveBaseSha, identity.head), true);
  }
});

test('WP-09 RED-01: prerequisites WP-INFRA…WP-08 EffectiveDone', () => {
  const prereq = readPrerequisiteDone();
  assert.equal(prereq.ok, true, JSON.stringify(prereq));
  assert.equal(prereq['WP-08'].EffectiveDone, true);
  assert.equal(prereq['WP-08'].state, 'DONE');
  assert.ok(readJson(wp08TxnReceipt).verifyDone);
});

test('WP-09 RED-01.1 catalog must contain unique WP-09 task identity', () => {
  const loaded = loadWp09CatalogEntry();
  if (!loaded.ok) {
    assert.equal(loaded.failureReason, FailureReason.WP09_CATALOG_ENTRY_MISSING);
    assert.fail(
      `${FailureReason.WP09_CATALOG_ENTRY_MISSING}: catalog must register unique WP-09 ` +
        `(weight=${EXPECTED_WEIGHT_FROM_PROGRESS_TABLE}, E2, prereqs INFRA…WP-08)`,
    );
  }
  assert.equal(loaded.task.taskId, TASK_ID);
});

test('WP-09 RED-01.2 catalog WP-09 fields must be dynamically parseable', () => {
  const loaded = loadWp09CatalogEntry();
  if (!loaded.ok) {
    assert.fail(`${loaded.failureReason}: catalog WP-09 missing`);
  }
  const parsed = parseWp09CatalogIdentity(loaded.task);
  if (!parsed.ok) {
    assert.equal(parsed.failureReason, FailureReason.WP09_CATALOG_FIELD_MISSING);
    assert.fail(
      `${FailureReason.WP09_CATALOG_FIELD_MISSING}: ${JSON.stringify(parsed.missing)}`,
    );
  }
  assert.equal(loaded.task.weight, EXPECTED_WEIGHT_FROM_PROGRESS_TABLE);
  assert.equal(loaded.task.evidenceLevel, 'E2');
});

test('WP-09 RED-01.4 transaction receipt initializes fail-closed (not DONE)', () => {
  assert.equal(pathExists(wp09TxnReceipt), true);
  const data = readJson(wp09TxnReceipt);
  assert.equal(data.taskId, TASK_ID);
  // Temp init path is always fail-closed; operational may be DONE only via verifyDone.
  const { receipt, init } = initTempWp09Receipt();
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
    assert.notEqual(data.state, 'DONE');
  }
});

test('WP-09 RED-01.5 runner receipt-init for WP-09', () => {
  const { receipt, init } = initTempWp09Receipt();
  assert.equal(init.status, 0, init.combined);
  const body = parseRunnerJson(init);
  assert.equal(body && body.ok, true, init.combined);
  assert.equal(readJson(receipt).EffectiveDone, false);
  try {
    fs.unlinkSync(receipt);
  } catch {
    // ignore
  }
});

test('WP-09 RED-01.7 production Create surfaces must exist (capacity gap)', () => {
  const r = assertWp09ProductionSurfacesPresent();
  const missing = listMissingCreates();
  if (missing.length) {
    assert.equal(r.ok, false);
    assert.equal(r.failureReason, FailureReason.WP09_PRODUCTION_SURFACE_MISSING);
    assert.fail(`${FailureReason.WP09_PRODUCTION_SURFACE_MISSING}: ${missing.join(', ')}`);
  }
  assert.equal(r.ok, true);
});

test('WP-09 RED-01.8 verify-wallpaper-plugin.js production surface', () => {
  const r = assertWp09VerifierJsPresent();
  if (!r.ok) {
    assert.equal(r.failureReason, FailureReason.WP09_VERIFIER_JS_MISSING);
    assert.fail(`${FailureReason.WP09_VERIFIER_JS_MISSING}: ${r.message}`);
  }
  assert.equal(r.ok, true);
});

test('WP-09 RED-01.9 verify-wallpaper-plugin.sh production surface', () => {
  const r = assertWp09VerifierShPresent();
  if (!r.ok) {
    assert.equal(r.failureReason, FailureReason.WP09_VERIFIER_SH_MISSING);
    assert.fail(`${FailureReason.WP09_VERIFIER_SH_MISSING}: ${r.message}`);
  }
  assert.equal(r.ok, true);
});

test('WP-09 RED-01.10 verify-wallpaper-plugin unit test surface', () => {
  const r = assertWp09UnitTestPresent();
  if (!r.ok) {
    assert.equal(r.failureReason, FailureReason.WP09_UNIT_TEST_MISSING);
    assert.fail(`${FailureReason.WP09_UNIT_TEST_MISSING}: ${r.message}`);
  }
  assert.equal(r.ok, true);
});

test('WP-09 RED-01.11 wp09-transaction.py tool surface', () => {
  const r = assertWp09TransactionToolPresent();
  if (!r.ok) {
    assert.equal(r.failureReason, FailureReason.WP09_TRANSACTION_TOOL_MISSING);
    assert.fail(`${FailureReason.WP09_TRANSACTION_TOOL_MISSING}: ${r.message}`);
  }
  assert.equal(r.ok, true);
});

test('WP-09 RED-01.12 wp09-transaction unit test surface', () => {
  const r = assertWp09TransactionTestPresent();
  if (!r.ok) {
    assert.equal(r.failureReason, FailureReason.WP09_TRANSACTION_TEST_MISSING);
    assert.fail(`${FailureReason.WP09_TRANSACTION_TEST_MISSING}: ${r.message}`);
  }
  assert.equal(r.ok, true);
});

test('WP-09 RED-01.13 static three-package contract markers', () => {
  const r = assertWp09StaticContract();
  if (!r.ok) {
    assert.equal(r.failureReason, FailureReason.WP09_STATIC_CONTRACT_MISSING);
    assert.fail(
      `${FailureReason.WP09_STATIC_CONTRACT_MISSING}: need ${WP09_STATIC_MARKERS.join(',')}`,
    );
  }
  assert.equal(r.ok, true);
});

test('WP-09 RED-01.14 cert/split mismatch fixtures present', () => {
  const r = assertWp09MismatchFixtures();
  if (!r.ok) {
    assert.equal(r.failureReason, FailureReason.WP09_MISMATCH_FIXTURES_MISSING);
    assert.fail(`${FailureReason.WP09_MISMATCH_FIXTURES_MISSING}: ${r.message}`);
  }
  assert.equal(r.ok, true);
});

test('WP-09 RED-01.15 full production capacity aggregate', () => {
  const r = assertWp09FullProductionCapacity();
  if (!r.ok) {
    assert.match(String(r.failureReason), /^WP09_/);
    assert.equal(r.EffectiveDone, false);
    assert.fail(`${r.failureReason}: ${r.message}`);
  }
  assert.equal(r.ok, true);
});

test('WP-09 RED-01.16 caller cannot forge EffectiveDone=true', () => {
  // Forge always attempted on temp receipt so operational DONE is never required false.
  const { receipt, init } = initTempWp09Receipt();
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
    JSON.stringify({ EffectiveDone: true, coreProgressPercent: 70 }),
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
  const op = readJson(wp09TxnReceipt);
  if (op.EffectiveDone === true) {
    assert.ok(op.verifyDone, 'operational DONE requires verifyDone');
  }
});

test('WP-09 RED-01.17 caller cannot forge Core progress via WP-09 receipt', () => {
  const before = parseRunnerJson(computeCoreProgress(defaultDoneReceiptsThroughWp08()));
  assert.equal(before.coreProgressPercent, EXPECTED_CURRENT_CORE_PROGRESS);

  const { receipt, init } = initTempWp09Receipt();
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
    JSON.stringify({ EffectiveDone: true, coreProgressPercent: 70 }),
  ]);
  assert.notEqual(cas.status, 0, cas.combined);
  try {
    fs.unlinkSync(receipt);
  } catch {
    // ignore
  }

  const after = parseRunnerJson(computeCoreProgress(defaultDoneReceiptsWithWp09()));
  const op = readJson(wp09TxnReceipt);
  if (op.EffectiveDone === true) {
    assert.equal(after.coreProgressPercent, EXPECTED_PROGRESS_WHEN_DONE);
    assert.ok(op.verifyDone);
  } else {
    assert.equal(after.coreProgressPercent, EXPECTED_CURRENT_CORE_PROGRESS);
    assert.notEqual(after.coreProgressPercent, EXPECTED_PROGRESS_WHEN_DONE);
  }
});

test('WP-09 RED-01.18 progress stays 64% without EffectiveDone', () => {
  const live = liveWp09OperationalProgress();
  const baseline = parseRunnerJson(computeCoreProgress(defaultDoneReceiptsThroughWp08()));
  assert.equal(baseline.coreProgressPercent, EXPECTED_CURRENT_CORE_PROGRESS);
  const prog = parseRunnerJson(computeCoreProgress(defaultDoneReceiptsWithWp09()));
  if (live.EffectiveDone) {
    assert.equal(prog.coreProgressPercent, EXPECTED_PROGRESS_WHEN_DONE);
    assert.ok(live.receipt.verifyDone);
  } else {
    assert.equal(live.expectedCoreProgressPercent, 64);
    assert.equal(prog.coreProgressPercent, 64);
  }
});

test('WP-09 RED-01.19 WP-10A must not be started', () => {
  const wp10 = path.join(
    '/Users/anpple/Codex/Mineradio',
    'android-car',
    'verification',
    'wallpaper-plugin',
    'transactions',
    'wp-10a.json',
  );
  // WP-10A may later exist/DONE only via its own verify-done (not forged by WP-09).
  if (pathExists(wp10)) {
    const r = readJson(wp10);
    if (r.EffectiveDone === true) {
      assert.ok(r.verifyDone, 'WP-10A DONE requires own verifyDone (not WP-09)');
    }
  }
});

test('WP-09 RED-01.20 production Create path list is fixed (Task 9 Files)', () => {
  assert.deepEqual(WP09_CREATE_REL, [
    'android-car/scripts/verify-wallpaper-plugin.js',
    'android-car/scripts/verify-wallpaper-plugin.sh',
    'android-car/tests/verify-wallpaper-plugin.test.js',
  ]);
  assert.equal(EXPECTED_WEIGHT_FROM_PROGRESS_TABLE, 6);
  assert.equal(EXPECTED_PROGRESS_WHEN_DONE, 70);
});

test('WP-09 RED-01.21 stable WP09_* failure reason tokens are fixed', () => {
  assert.equal(FailureReason.WP09_CATALOG_ENTRY_MISSING, 'WP09_CATALOG_ENTRY_MISSING');
  assert.equal(FailureReason.WP09_VERIFIER_JS_MISSING, 'WP09_VERIFIER_JS_MISSING');
  assert.equal(FailureReason.WP09_STATIC_CONTRACT_MISSING, 'WP09_STATIC_CONTRACT_MISSING');
  assert.equal(
    FailureReason.WP09_MISMATCH_FIXTURES_MISSING,
    'WP09_MISMATCH_FIXTURES_MISSING',
  );
});
