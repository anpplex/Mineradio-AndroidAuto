'use strict';

/**
 * WP-02 / VERIFY-DONE contracts (RED + GREEN).
 *
 * GREEN implements evaluate_wp02_verify_done: dynamic PR API + ancestry +
 * suite digests. Caller cannot forge remote/done/progress facts.
 * Temp receipts may reach DONE; production wp-02 transaction is not mutated
 * by success-path tests (CLOSE-VERIFY operational path remains separate).
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
  runtimeContractPath,
  finalInfraReceipt,
  wp00MergeReceipt,
  wp01TxnReceipt,
  wp02TxnReceipt,
  TASK_ID,
  EXPECTED_WEIGHT,
  EXPECTED_PROGRESS_WHEN_DONE,
  git,
  runRunner,
  parseRunnerJson,
  readJson,
  pathExists,
  sha256File,
  liveAuthoritativeBaseSha,
  isAncestor,
  loadWp02CatalogTask,
  readPrerequisiteDone,
  initTempReceipt,
  discoverImplementationIdentity,
  suiteProofs,
  identityProofs,
  runVerifyDone,
  computeCoreProgress,
  defaultDoneReceipts,
  productionHasWp02VerifyDonePath,
} = require('./wallpaper-wp02-verify-done-helpers');

function validProofs(prNumber = 8) {
  return identityProofs(prNumber, {
    catalogSha256: sha256File(catalogPath),
    schemaSha256: sha256File(schemaPath),
  });
}

// ---------------------------------------------------------------------------
// Environment / dynamic facts
// ---------------------------------------------------------------------------

test('WP-02 VERIFY-DONE RED-0: worktree identity and live base from ls-remote', () => {
  const branch = git(['branch', '--show-current']);
  assert.equal(branch.stdout, 'codex/wallpaper-plugin-wp02-verify-done');
  const head = git(['rev-parse', 'HEAD']);
  assert.match(head.stdout, /^[0-9a-f]{40}$/);
  const live = liveAuthoritativeBaseSha();
  assert.equal(head.stdout.toLowerCase(), live);
  assert.match(live, /^[0-9a-f]{40}$/);
});

test('WP-02 VERIFY-DONE RED-0.1: prerequisites WP-INFRA/WP-00/WP-01 DONE from real receipts', () => {
  const prereq = readPrerequisiteDone();
  assert.equal(prereq.ok, true, JSON.stringify(prereq));
  assert.equal(prereq.WP_INFRA.EffectiveDone, true);
  assert.equal(prereq['WP-00'].EffectiveDone, true);
  assert.equal(prereq['WP-01'].EffectiveDone, true);
});

test('WP-02 VERIFY-DONE RED-0.2: catalog WP-02 unique entry weight=8 evidence E1', () => {
  const loaded = loadWp02CatalogTask();
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  assert.equal(loaded.task.weight, EXPECTED_WEIGHT);
  assert.equal(loaded.task.evidenceLevel, 'E1');
  assert.equal(pathExists(runtimeContractPath), true);
});

test('WP-02 VERIFY-DONE RED-0.3: implementation commit is ancestor of live base (dynamic)', () => {
  const live = liveAuthoritativeBaseSha();
  const id = discoverImplementationIdentity({ prNumber: 8 });
  assert.equal(id.ok, true, JSON.stringify(id));
  assert.equal(id.merged, true);
  assert.equal(id.baseRefName, 'huawei-android12-car');
  assert.equal(id.mergeIsAncestorOfLiveBase, true);
  assert.equal(id.headIsAncestorOfLiveBase, true);
  assert.equal(isAncestor(id.mergeSha, live), true);
});

// ---------------------------------------------------------------------------
// GREEN capacity
// ---------------------------------------------------------------------------

test('WP-02 VERIFY-DONE GREEN-1: production implements evaluate_wp02_verify_done', () => {
  assert.equal(productionHasWp02VerifyDonePath(), true);
  const src = fs.readFileSync(runnerPath, 'utf8');
  assert.match(src, /evaluate_wp02_verify_done/);
  assert.match(src, /WP02_VERIFY_DONE_CALLER_FORGERY|WP02_VERIFY_DONE_PROOF_MISSING/);
});

test('WP-02 VERIFY-DONE GREEN-1.1: verify-done with valid identity proofs succeeds on temp receipt', () => {
  const { receipt, init } = initTempReceipt();
  assert.equal(init.status, 0, init.combined);

  const result = runVerifyDone(receipt, validProofs(8));
  assert.equal(result.status, 0, result.combined);
  const body = parseRunnerJson(result);
  assert.ok(body && body.ok === true, result.combined);
  assert.equal(body.EffectiveDone, true);
  assert.equal(body.taskId, TASK_ID);
  assert.equal(body.coreProgressWeight, 8);

  const data = readJson(receipt);
  assert.equal(data.EffectiveDone, true);
  assert.equal(data.state, 'DONE');
  const vd = data.verifyDone || {};
  assert.equal(vd.weight, 8);
  assert.match(String(vd.liveBaseSha || ''), /^[0-9a-f]{40}$/);
  assert.equal(vd.liveBaseSha, liveAuthoritativeBaseSha());
  assert.ok(vd.implementationProof);
  assert.equal(vd.implementationProof.mergeIsAncestorOfLiveBase, true);
  // Must not require merge == tip
  assert.ok(vd.implementationMergeSha);
});

test('WP-02 VERIFY-DONE GREEN-1.2: production wp-02 txn remains non-DONE without operational CLOSE', () => {
  // Success-path tests use temp receipts; operational txn is not auto-closed here.
  assert.equal(pathExists(wp02TxnReceipt), true);
  const before = readJson(wp02TxnReceipt);
  assert.equal(before.EffectiveDone, false);
  assert.notEqual(before.state, 'DONE');
});

// ---------------------------------------------------------------------------
// Fail-closed rejections
// ---------------------------------------------------------------------------

test('WP-02 VERIFY-DONE RED-2.1: rejects caller-forged EffectiveDone / progress on receipt-cas', () => {
  const { receipt, init } = initTempReceipt();
  assert.equal(init.status, 0);
  const cas = runRunner([
    'receipt-cas',
    '--receipt',
    receipt,
    '--expected-revision',
    '1',
    '--expected-state',
    'INIT',
    '--state',
    'DONE',
    '--set-json',
    JSON.stringify({ EffectiveDone: true, coreProgressPercent: 18 }),
  ]);
  assert.notEqual(cas.status, 0);
  assert.match(
    cas.combined,
    /ONLY_VERIFY_DONE_MAY_ENABLE_EFFECTIVE_DONE|CALLER|EffectiveDone/i,
  );
  assert.equal(readJson(receipt).EffectiveDone, false);
});

test('WP-02 VERIFY-DONE RED-2.2: rejects caller-forged merged / REMOTE_VERIFIED via verify-done proofs', () => {
  const { receipt, init } = initTempReceipt();
  assert.equal(init.status, 0);

  const forged = identityProofs(8, {
    merged: true,
    REMOTE_VERIFIED: true,
    EffectiveDone: true,
    mergeSha: 'a'.repeat(40),
    coreProgressPercent: 18,
    catalogSha256: sha256File(catalogPath),
    schemaSha256: sha256File(schemaPath),
  });
  const result = runVerifyDone(receipt, forged);
  assert.notEqual(result.status, 0);
  assert.match(
    result.combined,
    /WP02_VERIFY_DONE_CALLER_FORGERY|FORGERY|CALLER/i,
  );
  assert.equal(readJson(receipt).EffectiveDone, false);
});

test('WP-02 VERIFY-DONE RED-2.3: rejects missing proofs / empty proofs fail-closed', () => {
  const { receipt, init } = initTempReceipt();
  assert.equal(init.status, 0);

  const noProofs = runVerifyDone(receipt, null);
  assert.notEqual(noProofs.status, 0);
  assert.match(noProofs.combined, /WP02_VERIFY_DONE_PROOF_MISSING|PROOF|missing/i);

  const empty = runVerifyDone(receipt, {});
  assert.notEqual(empty.status, 0);
  assert.match(empty.combined, /WP02_VERIFY_DONE_PROOF_MISSING|PROOF|missing/i);
  assert.equal(readJson(receipt).EffectiveDone, false);
});

test('WP-02 VERIFY-DONE RED-2.4: rejects unmerged / nonexistent PR identity', () => {
  const { receipt, init } = initTempReceipt();
  assert.equal(init.status, 0);

  const bad = runVerifyDone(receipt, validProofs(999999999));
  assert.notEqual(bad.status, 0);
  assert.match(
    bad.combined,
    /PR_READBACK|NOT_MERGED|PROOF|Could not resolve|WP02_VERIFY_DONE|gh pr view/i,
  );
  assert.equal(readJson(receipt).EffectiveDone, false);
});

test('WP-02 VERIFY-DONE RED-2.5: rejects catalog SHA mismatch payload', () => {
  const { receipt, init } = initTempReceipt();
  assert.equal(init.status, 0);

  const proofs = identityProofs(8, {
    catalogSha256: '0'.repeat(64),
    schemaSha256: sha256File(schemaPath),
  });
  const result = runVerifyDone(receipt, proofs);
  assert.notEqual(result.status, 0);
  assert.match(result.combined, /catalogSha256 mismatch|WP02_VERIFY_DONE_PROOF_MISSING|CATALOG/i);
  assert.equal(readJson(receipt).EffectiveDone, false);
});

test('WP-02 VERIFY-DONE RED-2.6: rejects suite digest fail / pass:false', () => {
  const { receipt, init } = initTempReceipt();
  assert.equal(init.status, 0);

  const proofs = identityProofs(8, {
    pluginContractTest: { pass: false, sha256: 'a'.repeat(64) },
    catalogSha256: sha256File(catalogPath),
    schemaSha256: sha256File(schemaPath),
  });
  const result = runVerifyDone(receipt, proofs);
  assert.notEqual(result.status, 0);
  assert.match(
    result.combined,
    /pluginContractTest\.pass must be true|WP02_VERIFY_DONE_PROOF_MISSING/i,
  );
  assert.equal(readJson(receipt).EffectiveDone, false);
});

test('WP-02 VERIFY-DONE RED-2.7: must not require mergeSha == live tip (ancestry only)', () => {
  const src = fs.readFileSync(runnerPath, 'utf8');
  assert.match(src, /never require mergeSha == live tip|Ancestry only/i);
  const id = discoverImplementationIdentity({ prNumber: 8 });
  assert.equal(id.mergeIsAncestorOfLiveBase, true);
});

// ---------------------------------------------------------------------------
// Progress guards
// ---------------------------------------------------------------------------

test('WP-02 VERIFY-DONE RED-3.1: Core progress stays 10% while operational WP-02 EffectiveDone=false', () => {
  const progress = computeCoreProgress(defaultDoneReceipts());
  assert.equal(progress.status, 0, progress.combined);
  const body = parseRunnerJson(progress);
  assert.equal(body.coreProgressPercent, 10);
  const wp02 = (body.breakdown || []).find((r) => r.taskId === TASK_ID);
  assert.ok(wp02);
  assert.equal(wp02.weight, EXPECTED_WEIGHT);
  assert.equal(wp02.EffectiveDone, false);
  assert.equal(readJson(wp02TxnReceipt).EffectiveDone, false);
});

test('WP-02 VERIFY-DONE RED-3.2: GREEN success target is progress 18% from catalog weights', () => {
  const loaded = loadWp02CatalogTask();
  assert.equal(loaded.task.weight, 8);
  assert.equal(10 + loaded.task.weight, EXPECTED_PROGRESS_WHEN_DONE);

  // Temp DONE receipt contributes weight when mapped into compute-core-progress.
  const { receipt, init } = initTempReceipt();
  assert.equal(init.status, 0);
  const done = runVerifyDone(receipt, validProofs(8));
  assert.equal(done.status, 0, done.combined);
  const progress = computeCoreProgress({
    'WP-00': wp00MergeReceipt,
    'WP-01': wp01TxnReceipt,
    'WP-02': receipt,
  });
  assert.equal(progress.status, 0, progress.combined);
  const body = parseRunnerJson(progress);
  assert.equal(body.coreProgressPercent, 18);
});

test('WP-02 VERIFY-DONE GREEN-3.3: full proof chain succeeds with dynamic PR identity', () => {
  const { receipt, init } = initTempReceipt();
  assert.equal(init.status, 0);
  const id = discoverImplementationIdentity({ prNumber: 8 });
  assert.equal(id.merged, true);
  const result = runVerifyDone(receipt, validProofs(8));
  assert.equal(result.status, 0, result.combined);
  assert.equal(readJson(receipt).EffectiveDone, true);
  assert.equal(pathExists(runtimeContractPath), true);
});

test('WP-02 VERIFY-DONE RED-3.4: WP-03 not started', () => {
  const catalog = readJson(catalogPath);
  assert.ok(!catalog.tasks.some((t) => t.taskId === 'WP-03'));
  assert.equal(productionHasWp02VerifyDonePath(), true);
});
