'use strict';

/**
 * WP-10A / RED-01 — user 12 install, real Mineradio caller, PID isolation (E3).
 *
 * RED only: catalog + E3 fixture / device-context capacity gaps.
 * Does not claim EffectiveDone or raise Core above 70%.
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
  wp09TxnReceipt,
  wp10aTxnReceipt,
  TASK_ID,
  EXPECTED_CURRENT_CORE_PROGRESS,
  EXPECTED_WEIGHT_FROM_PROGRESS_TABLE,
  EXPECTED_PROGRESS_WHEN_DONE,
  TARGET_SERIAL,
  TARGET_USER,
  WP10A_E3_FAIL_FIXTURES,
  FailureReason,
  parseRunnerJson,
  readJson,
  pathExists,
  liveAuthoritativeBaseSha,
  isGitAncestor,
  readTaskWorktreeIdentity,
  loadWp10aCatalogEntry,
  parseWp10aCatalogIdentity,
  readPrerequisiteDone,
  assertDeviceContextCommandPresent,
  probeTargetDevice,
  assertE3VerifierSurface,
  assertBundleParserSurface,
  assertE3FixturesPresent,
  assertWp10aFullProductionCapacity,
  computeCoreProgress,
  defaultDoneReceiptsThroughWp09,
  defaultDoneReceiptsWithWp10a,
  liveWp10aOperationalProgress,
  initTempWp10aReceipt,
  runRunner,
} = require('./wallpaper-wp10a-red-helpers');

test('WP-10A RED-01: environment paths and tools are real', () => {
  assert.equal(pathExists(runnerPath), true, 'runner missing');
  assert.equal(pathExists(catalogPath), true, 'catalog missing');
  assert.equal(pathExists(schemaPath), true, 'schema missing');
  assert.equal(pathExists(finalInfraReceipt), true);
  assert.equal(pathExists(wp09TxnReceipt), true, 'wp-09.json missing');
});

test('WP-10A RED-01: worktree branch and live base identity', () => {
  const identity = readTaskWorktreeIdentity();
  assert.equal(identity.ok, true, JSON.stringify(identity));
  assert.match(identity.branch, /^codex\/wallpaper-plugin-/);
  assert.equal(identity.liveBaseSha, liveAuthoritativeBaseSha());
  assert.ok(identity.relation === 'equal' || identity.relation === 'ahead');
  if (identity.relation === 'ahead') {
    assert.equal(isGitAncestor(identity.liveBaseSha, identity.head), true);
  }
});

test('WP-10A RED-01: prerequisites WP-INFRA…WP-09 EffectiveDone', () => {
  const prereq = readPrerequisiteDone();
  assert.equal(prereq.ok, true, JSON.stringify(prereq));
  assert.equal(prereq['WP-09'].EffectiveDone, true);
  assert.equal(readJson(wp09TxnReceipt).state, 'DONE');
  assert.ok(readJson(wp09TxnReceipt).verifyDone);
});

test('WP-10A RED-01.1 catalog must contain unique WP-10A task identity', () => {
  const loaded = loadWp10aCatalogEntry();
  if (!loaded.ok) {
    assert.equal(loaded.failureReason, FailureReason.WP10A_CATALOG_ENTRY_MISSING);
    assert.fail(
      `${FailureReason.WP10A_CATALOG_ENTRY_MISSING}: catalog must register unique WP-10A ` +
        `(weight=${EXPECTED_WEIGHT_FROM_PROGRESS_TABLE}, E3, prereqs INFRA…WP-09)`,
    );
  }
  assert.equal(loaded.task.taskId, TASK_ID);
});

test('WP-10A RED-01.2 catalog WP-10A fields must be dynamically parseable', () => {
  const loaded = loadWp10aCatalogEntry();
  if (!loaded.ok) {
    assert.fail(`${loaded.failureReason}: catalog WP-10A missing`);
  }
  const parsed = parseWp10aCatalogIdentity(loaded.task);
  if (!parsed.ok) {
    assert.equal(parsed.failureReason, FailureReason.WP10A_CATALOG_FIELD_MISSING);
    assert.fail(
      `${FailureReason.WP10A_CATALOG_FIELD_MISSING}: ${JSON.stringify(parsed.missing)}`,
    );
  }
  assert.equal(loaded.task.weight, EXPECTED_WEIGHT_FROM_PROGRESS_TABLE);
  assert.equal(loaded.task.evidenceLevel, 'E3');
});

test('WP-10A RED-01.4 transaction receipt initializes fail-closed (not DONE)', () => {
  assert.equal(pathExists(wp10aTxnReceipt), true, 'wp-10a.json missing');
  const data = readJson(wp10aTxnReceipt);
  assert.equal(data.taskId, TASK_ID);
  const { receipt, init } = initTempWp10aReceipt();
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

test('WP-10A RED-01.5 runner receipt-init for WP-10A', () => {
  const { receipt, init } = initTempWp10aReceipt();
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

test('WP-10A RED-01.7 assert-device-context command must exist (capacity gap)', () => {
  const r = assertDeviceContextCommandPresent();
  if (!r.ok) {
    assert.equal(r.failureReason, FailureReason.WP10A_DEVICE_CONTEXT_CMD_MISSING);
    assert.fail(`${FailureReason.WP10A_DEVICE_CONTEXT_CMD_MISSING}: ${r.message}`);
  }
  assert.equal(r.ok, true);
});

test('WP-10A RED-01.8 E3 verifier surface (verifyE3Evidence) must exist', () => {
  const r = assertE3VerifierSurface();
  if (!r.ok) {
    assert.equal(r.failureReason, FailureReason.WP10A_E3_VERIFIER_MISSING);
    assert.fail(`${FailureReason.WP10A_E3_VERIFIER_MISSING}: ${r.message}`);
  }
  assert.equal(r.ok, true);
});

test('WP-10A RED-01.9 content-call Bundle parser must exist', () => {
  const r = assertBundleParserSurface();
  if (!r.ok) {
    assert.equal(r.failureReason, FailureReason.WP10A_BUNDLE_PARSER_MISSING);
    assert.fail(`${FailureReason.WP10A_BUNDLE_PARSER_MISSING}: ${r.message}`);
  }
  assert.equal(r.ok, true);
});

test('WP-10A RED-01.10 E3 fail fixtures must be registered', () => {
  const r = assertE3FixturesPresent();
  if (!r.ok) {
    assert.equal(r.failureReason, FailureReason.WP10A_E3_FIXTURES_MISSING);
    assert.fail(
      `${FailureReason.WP10A_E3_FIXTURES_MISSING}: need ${WP10A_E3_FAIL_FIXTURES.join(',')}`,
    );
  }
  assert.equal(r.ok, true);
});

test('WP-10A RED-01.11 full production capacity aggregate (stable gap signatures)', () => {
  const r = assertWp10aFullProductionCapacity();
  if (!r.ok) {
    assert.match(String(r.failureReason), /^WP10A_/);
    assert.equal(r.EffectiveDone, false);
    assert.fail(`${r.failureReason}: ${r.message}`);
  }
  assert.equal(r.ok, true);
});

test('WP-10A RED-01.12 target device probe is real (offline → BLOCKED_DEVICE, not forged pass)', () => {
  const probe = probeTargetDevice();
  if (!probe.ok) {
    assert.equal(probe.failureReason, FailureReason.WP10A_DEVICE_OFFLINE);
    assert.equal(probe.blocked, FailureReason.WP10A_BLOCKED_DEVICE);
    assert.equal(probe.serial, TARGET_SERIAL);
    // Capacity RED still PASSES this pin: offline is a real fail-closed observation.
    assert.ok(true, `observed BLOCKED_DEVICE: ${probe.message}`);
    return;
  }
  assert.equal(probe.state, 'device');
  assert.equal(probe.serial, TARGET_SERIAL);
});

test('WP-10A RED-01.15 caller cannot forge EffectiveDone=true', () => {
  const { receipt, init } = initTempWp10aReceipt();
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
    JSON.stringify({ EffectiveDone: true, coreProgressPercent: 76 }),
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
  const op = readJson(wp10aTxnReceipt);
  if (op.EffectiveDone === true) {
    assert.ok(op.verifyDone, 'operational DONE requires verifyDone');
  }
});

test('WP-10A RED-01.16 caller cannot forge Core progress via WP-10A receipt', () => {
  const before = computeCoreProgress(defaultDoneReceiptsThroughWp09());
  const bodyBefore = parseRunnerJson(before);
  assert.equal(bodyBefore.coreProgressPercent, EXPECTED_CURRENT_CORE_PROGRESS);

  const { receipt, init } = initTempWp10aReceipt();
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
    JSON.stringify({ EffectiveDone: true, coreProgressPercent: 76 }),
  ]);
  assert.notEqual(cas.status, 0, cas.combined);
  try {
    fs.unlinkSync(receipt);
  } catch {
    // ignore
  }

  const after = computeCoreProgress(defaultDoneReceiptsWithWp10a());
  const bodyAfter = parseRunnerJson(after);
  const op = readJson(wp10aTxnReceipt);
  if (op.EffectiveDone === true) {
    assert.equal(bodyAfter.coreProgressPercent, EXPECTED_PROGRESS_WHEN_DONE);
    assert.ok(op.verifyDone);
  } else {
    assert.equal(bodyAfter.coreProgressPercent, EXPECTED_CURRENT_CORE_PROGRESS);
    assert.notEqual(bodyAfter.coreProgressPercent, EXPECTED_PROGRESS_WHEN_DONE);
  }
});

test('WP-10A RED-01.18 progress stays 70% without EffectiveDone', () => {
  const live = liveWp10aOperationalProgress();
  const baseline = parseRunnerJson(computeCoreProgress(defaultDoneReceiptsThroughWp09()));
  assert.equal(baseline.coreProgressPercent, EXPECTED_CURRENT_CORE_PROGRESS);
  const prog = parseRunnerJson(computeCoreProgress(defaultDoneReceiptsWithWp10a()));
  if (live.EffectiveDone) {
    assert.equal(prog.coreProgressPercent, EXPECTED_PROGRESS_WHEN_DONE);
    assert.ok(live.receipt.verifyDone);
  } else {
    assert.equal(live.expectedCoreProgressPercent, EXPECTED_CURRENT_CORE_PROGRESS);
    assert.equal(prog.coreProgressPercent, 70);
  }
});

test('WP-10A RED-01.19 GREEN surfaces never grant EffectiveDone; progress stays 70%', () => {
  const r = assertWp10aFullProductionCapacity();
  void r;
  const op = readJson(wp10aTxnReceipt);
  if (op.EffectiveDone === true) {
    assert.ok(op.verifyDone, 'surfaces alone cannot DONE');
  }
  const prog = parseRunnerJson(computeCoreProgress(defaultDoneReceiptsThroughWp09()));
  assert.equal(prog.coreProgressPercent, 70);
});

test('WP-10A RED-01.20 WP-10B must not be started', () => {
  const wp10b = path.join(
    '/Users/anpple/Codex/Mineradio',
    'android-car',
    'verification',
    'wallpaper-plugin',
    'transactions',
    'wp-10b.json',
  );
  const cat = readJson(catalogPath);
  const cat10b = (cat.tasks || []).find((t) => t && t.taskId === 'WP-10B');
  if (cat10b) {
    assert.equal(cat10b.EffectiveDone, undefined);
    assert.equal(cat10b.state, undefined);
  }
  if (pathExists(wp10b)) {
    const r = readJson(wp10b);
    if (r.EffectiveDone === true) {
      assert.ok(r.verifyDone, 'WP-10B DONE requires own verifyDone (not WP-10A)');
    }
  }
});

test('WP-10A RED-01.21 E3 fixture path list is fixed (Task 10A)', () => {
  assert.deepEqual([...WP10A_E3_FAIL_FIXTURES], [
    'missingUser12',
    'shellCallerOnly',
    'actionTokenMissing',
    'actionTokenReplay',
    'confirmUserActionSkipped',
    'sourceConsumedMissing',
    'sourceUriNotRevoked',
    'runtimePidEmpty',
    'runtimePidDuplicate',
    'runtimePidEqualsMineradio',
  ]);
  assert.equal(EXPECTED_WEIGHT_FROM_PROGRESS_TABLE, 6);
  assert.equal(EXPECTED_PROGRESS_WHEN_DONE, 76);
  assert.equal(TARGET_USER, '12');
  assert.equal(TARGET_SERIAL, 'LD249H019625');
});

test('WP-10A RED-01.22 stable WP10A_* failure reason tokens are fixed', () => {
  assert.equal(FailureReason.WP10A_CATALOG_ENTRY_MISSING, 'WP10A_CATALOG_ENTRY_MISSING');
  assert.equal(FailureReason.WP10A_E3_FIXTURES_MISSING, 'WP10A_E3_FIXTURES_MISSING');
  assert.equal(FailureReason.WP10A_E3_VERIFIER_MISSING, 'WP10A_E3_VERIFIER_MISSING');
  assert.equal(FailureReason.WP10A_BUNDLE_PARSER_MISSING, 'WP10A_BUNDLE_PARSER_MISSING');
  assert.equal(
    FailureReason.WP10A_DEVICE_CONTEXT_CMD_MISSING,
    'WP10A_DEVICE_CONTEXT_CMD_MISSING',
  );
  assert.equal(FailureReason.WP10A_BLOCKED_DEVICE, 'WP10A_BLOCKED_DEVICE');
  assert.equal(FailureReason.WP10A_DEVICE_OFFLINE, 'WP10A_DEVICE_OFFLINE');
});
