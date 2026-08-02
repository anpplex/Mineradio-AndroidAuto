'use strict';

/**
 * WP-03 / VERIFY-DONE RED-01 — production verify-done path contracts.
 *
 * RED only: pins WP03_VERIFY_DONE_UNAVAILABLE until GREEN implements
 * evaluate_wp03_verify_done. Does not modify production CLI.
 * Does not elevate operational WP-03 EffectiveDone / Core progress.
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
  stagingContractPath,
  finalInfraReceipt,
  wp00MergeReceipt,
  wp01TxnReceipt,
  wp02TxnReceipt,
  wp03TxnReceipt,
  TASK_ID,
  EXPECTED_WEIGHT,
  EXPECTED_PROGRESS_WHEN_DONE,
  IMPLEMENTATION_PR,
  IMPLEMENTATION_HEAD,
  IMPLEMENTATION_MERGE,
  FailureReason,
  UNAVAILABLE_RE,
  git,
  runRunner,
  parseRunnerJson,
  readJson,
  pathExists,
  sha256File,
  liveAuthoritativeBaseSha,
  isAncestor,
  readTaskWorktreeIdentity,
  loadWp03CatalogTask,
  readPrerequisiteDone,
  initTempReceipt,
  discoverImplementationIdentity,
  identityProofs,
  runVerifyDone,
  computeCoreProgress,
  defaultDoneReceipts,
  defaultDoneReceiptsThroughWp02,
  liveWp03OperationalProgress,
  productionHasWp03VerifyDonePath,
  lastFailureReason,
} = require('./wallpaper-wp03-verify-done-helpers');

function validProofs(prNumber = IMPLEMENTATION_PR) {
  return identityProofs(prNumber, {
    catalogSha256: sha256File(catalogPath),
    schemaSha256: sha256File(schemaPath),
  });
}

// ---------------------------------------------------------------------------
// Environment / dynamic facts (may PASS in RED)
// ---------------------------------------------------------------------------

test('WP-03 VERIFY-DONE RED-0: worktree identity and live base from ls-remote', () => {
  const identity = readTaskWorktreeIdentity();
  assert.equal(identity.ok, true, JSON.stringify(identity));
  assert.match(identity.branch, /^codex\/wallpaper-plugin-/);
  assert.match(identity.head, /^[0-9a-f]{40}$/);
  assert.equal(identity.liveBaseSha, liveAuthoritativeBaseSha());
  assert.ok(
    identity.relation === 'equal' || identity.relation === 'ahead',
    identity.relation,
  );
});

test('WP-03 VERIFY-DONE RED-0.1: prerequisites WP-INFRA/00/01/02 DONE from real receipts', () => {
  const prereq = readPrerequisiteDone();
  assert.equal(prereq.ok, true, JSON.stringify(prereq));
  assert.equal(prereq.WP_INFRA.EffectiveDone, true);
  assert.equal(prereq['WP-00'].EffectiveDone, true);
  assert.equal(prereq['WP-01'].EffectiveDone, true);
  assert.equal(prereq['WP-02'].EffectiveDone, true);
  assert.equal(pathExists(finalInfraReceipt), true);
  assert.equal(pathExists(wp00MergeReceipt), true);
  assert.equal(pathExists(wp01TxnReceipt), true);
  assert.equal(pathExists(wp02TxnReceipt), true);
});

test('WP-03 VERIFY-DONE RED-0.2: catalog WP-03 unique weight=8 evidence E1', () => {
  const loaded = loadWp03CatalogTask();
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  assert.equal(loaded.task.weight, EXPECTED_WEIGHT);
  assert.equal(loaded.task.evidenceLevel, 'E1');
  assert.ok(Array.isArray(loaded.task.requiredEffectiveDone));
  for (const dep of ['WP-INFRA', 'WP-00', 'WP-01', 'WP-02']) {
    assert.ok(
      loaded.task.requiredEffectiveDone.includes(dep),
      `missing requiredEffectiveDone ${dep}`,
    );
  }
  assert.equal(pathExists(stagingContractPath), true);
});

test('WP-03 VERIFY-DONE RED-0.3: PR #10 identity + ancestry (dynamic gh API)', () => {
  const live = liveAuthoritativeBaseSha();
  const id = discoverImplementationIdentity({ prNumber: IMPLEMENTATION_PR });
  assert.equal(id.ok, true, JSON.stringify(id));
  assert.equal(id.merged, true);
  assert.ok(id.mergedAt);
  assert.equal(id.baseRefName, 'huawei-android12-car');
  assert.equal(id.headRefName, 'codex/wallpaper-plugin-wp03');
  assert.equal(String(id.headRefOid).toLowerCase(), IMPLEMENTATION_HEAD);
  assert.equal(String(id.mergeSha).toLowerCase(), IMPLEMENTATION_MERGE);
  assert.equal(id.mergeIsAncestorOfLiveBase, true);
  assert.equal(id.headIsAncestorOfLiveBase, true);
  assert.equal(isAncestor(id.mergeSha, live), true);
  assert.equal(isAncestor(id.headRefOid, live), true);
  // Must not require mergeSha == live tip as the only success condition.
  // (After PR merge they may coincide; gate must accept ancestry alone.)
  assert.equal(typeof id.mergeEqualsLiveTip, 'boolean');
});

// ---------------------------------------------------------------------------
// RED: production path missing — stable WP03_VERIFY_DONE_UNAVAILABLE
// ---------------------------------------------------------------------------

test('WP-03 VERIFY-DONE RED-1: production evaluate_wp03_verify_done path missing', () => {
  // GREEN must add evaluate_wp03_verify_done + WP-03 dispatch branch.
  assert.equal(
    productionHasWp03VerifyDonePath(),
    true,
    FailureReason.WP03_VERIFY_DONE_UNAVAILABLE,
  );
  const src = fs.readFileSync(runnerPath, 'utf8');
  assert.match(src, /evaluate_wp03_verify_done/, FailureReason.WP03_VERIFY_DONE_UNAVAILABLE);
  assert.match(
    src,
    /WP03_VERIFY_DONE_CALLER_FORGERY|WP03_VERIFY_DONE_PROOF_MISSING/,
    FailureReason.WP03_VERIFY_DONE_UNAVAILABLE,
  );
});

test('WP-03 VERIFY-DONE RED-1.1: bare verify-done fails closed without proofs', () => {
  const { receipt, init } = initTempReceipt();
  assert.equal(init.status, 0, init.combined);
  assert.equal(readJson(receipt).EffectiveDone, false);

  const result = runVerifyDone(receipt, null);
  const body = parseRunnerJson(result);
  assert.ok(body, result.combined);
  assert.equal(body.ok, false, result.combined);
  // Before GREEN: WP03_VERIFY_DONE_UNAVAILABLE. After GREEN: proof missing (WP03_*).
  if (productionHasWp03VerifyDonePath()) {
    assert.match(
      String(body.failureReason),
      /^WP03_/,
      body.failureReason,
    );
    assert.match(
      result.combined,
      /PROOF_MISSING|missing WP-03 proofs|WP03_VERIFY_DONE_PROOF_MISSING/i,
    );
  } else {
    assert.equal(
      body.failureReason,
      FailureReason.WP03_VERIFY_DONE_UNAVAILABLE,
      body.failureReason,
    );
  }
  assert.equal(readJson(receipt).EffectiveDone, false);
  assert.notEqual(readJson(receipt).state, 'DONE');
});

test('WP-03 VERIFY-DONE RED-1.2: GREEN success target fails until path exists', () => {
  const { receipt, init } = initTempReceipt();
  assert.equal(init.status, 0, init.combined);

  const result = runVerifyDone(receipt, validProofs(IMPLEMENTATION_PR));
  const body = parseRunnerJson(result);
  // Until GREEN: not ok; signature must be WP03_VERIFY_DONE_UNAVAILABLE.
  assert.equal(
    body && body.ok,
    true,
    `${FailureReason.WP03_VERIFY_DONE_UNAVAILABLE}: success path not implemented: ${result.combined}`,
  );
  assert.equal(body.EffectiveDone, true);
  assert.equal(body.taskId, TASK_ID);
  assert.equal(body.coreProgressWeight, EXPECTED_WEIGHT);

  const data = readJson(receipt);
  assert.equal(data.EffectiveDone, true);
  assert.equal(data.state, 'DONE');
  const vd = data.verifyDone || {};
  assert.equal(vd.weight, EXPECTED_WEIGHT);
  assert.equal(vd.liveBaseSha, liveAuthoritativeBaseSha());
  assert.ok(vd.implementationProof);
  assert.equal(vd.implementationProof.mergeIsAncestorOfLiveBase, true);
  // Ancestry only — must not require merge == tip
  assert.ok(vd.implementationMergeSha);
});

test('WP-03 VERIFY-DONE RED-1.3: operational wp-03 txn tracks live verify-done (non-DONE or DONE with proof)', () => {
  assert.equal(pathExists(wp03TxnReceipt), true);
  const before = readJson(wp03TxnReceipt);
  assert.equal(before.taskId, TASK_ID);
  const live = liveWp03OperationalProgress();
  if (live.EffectiveDone) {
    // Post CLOSE-VERIFY: only verify-done may set EffectiveDone; proof object required.
    assert.equal(before.EffectiveDone, true);
    assert.equal(before.state, 'DONE');
    assert.ok(before.verifyDone && typeof before.verifyDone === 'object');
  } else {
    assert.equal(before.EffectiveDone, false);
    assert.notEqual(before.state, 'DONE');
    assert.ok(
      ['INIT', 'RED_RECORDED', 'GREEN_RECORDED', 'REFACTOR_RECORDED', 'VERIFY_READY'].includes(
        before.state,
      ),
      before.state,
    );
  }
});

// ---------------------------------------------------------------------------
// Fail-closed rejections (PASS in RED: runner already rejects CAS / forgeries)
// ---------------------------------------------------------------------------

test('WP-03 VERIFY-DONE RED-2.1: rejects caller-forged EffectiveDone / progress on receipt-cas', () => {
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
    JSON.stringify({ EffectiveDone: true, coreProgressPercent: 26 }),
  ]);
  assert.notEqual(cas.status, 0);
  assert.match(
    cas.combined,
    /ONLY_VERIFY_DONE_MAY_ENABLE_EFFECTIVE_DONE|CALLER|EffectiveDone/i,
  );
  assert.equal(readJson(receipt).EffectiveDone, false);
});

test('WP-03 VERIFY-DONE RED-2.2: rejects caller-forged merged / REMOTE_VERIFIED / mergeSha / digests', () => {
  const { receipt, init } = initTempReceipt();
  assert.equal(init.status, 0);

  const forged = identityProofs(IMPLEMENTATION_PR, {
    merged: true,
    REMOTE_VERIFIED: true,
    EffectiveDone: true,
    mergeSha: 'a'.repeat(40),
    coreProgressPercent: 26,
    catalogSha256: '0'.repeat(64),
    schemaSha256: '1'.repeat(64),
    androidUnitTest: { pass: true, sha256: 'f'.repeat(64) },
    fullNodeTest: { pass: true, sha256: 'e'.repeat(64) },
  });
  const result = runVerifyDone(receipt, forged);
  const body = parseRunnerJson(result);
  assert.equal(body && body.ok, false, result.combined);
  // Forged remote facts must never succeed; GREEN uses WP03_* FORGERY/PROOF.
  assert.match(String(body.failureReason || ''), /^WP03_/);
  assert.match(
    result.combined,
    /FORGERY|PROOF|UNAVAILABLE|CALLER|WP03_/i,
  );
  if (productionHasWp03VerifyDonePath()) {
    assert.equal(
      body.failureReason,
      FailureReason.WP03_VERIFY_DONE_CALLER_FORGERY,
      body.failureReason,
    );
  } else {
    assert.equal(
      body.failureReason,
      FailureReason.WP03_VERIFY_DONE_UNAVAILABLE,
      body.failureReason,
    );
  }
  assert.equal(readJson(receipt).EffectiveDone, false);
  assert.notEqual(readJson(receipt).state, 'DONE');
});

test('WP-03 VERIFY-DONE RED-2.3: rejects missing proofs / empty proofs fail-closed', () => {
  const { receipt, init } = initTempReceipt();
  assert.equal(init.status, 0);

  const noProofs = runVerifyDone(receipt, null);
  const empty = runVerifyDone(receipt, {});
  for (const result of [noProofs, empty]) {
    const body = parseRunnerJson(result);
    assert.equal(body && body.ok, false, result.combined);
    assert.match(String(body.failureReason || ''), /^WP03_/);
    if (productionHasWp03VerifyDonePath()) {
      assert.match(
        result.combined,
        /PROOF_MISSING|missing WP-03 proofs|WP03_VERIFY_DONE_PROOF_MISSING/i,
      );
    } else {
      assert.equal(
        body.failureReason,
        FailureReason.WP03_VERIFY_DONE_UNAVAILABLE,
        body.failureReason,
      );
    }
  }
  assert.equal(readJson(receipt).EffectiveDone, false);
});

test('WP-03 VERIFY-DONE RED-2.4: rejects unmerged / nonexistent PR identity (when path exists)', () => {
  const { receipt, init } = initTempReceipt();
  assert.equal(init.status, 0);
  const result = runVerifyDone(receipt, validProofs(999999999));
  const body = parseRunnerJson(result);
  assert.equal(body && body.ok, false, result.combined);
  if (productionHasWp03VerifyDonePath()) {
    assert.match(String(body.failureReason || ''), /^WP03_/);
    assert.match(
      result.combined,
      /PR_PROOF|NOT_MERGED|PROOF|Could not resolve|WP03_/i,
    );
  } else {
    assert.equal(body.failureReason, FailureReason.WP03_VERIFY_DONE_UNAVAILABLE);
  }
  assert.equal(readJson(receipt).EffectiveDone, false);
});

test('WP-03 VERIFY-DONE RED-2.5: catalog SHA mismatch must fail-closed (when path exists)', () => {
  const { receipt, init } = initTempReceipt();
  assert.equal(init.status, 0);
  const proofs = identityProofs(IMPLEMENTATION_PR, {
    catalogSha256: '0'.repeat(64),
    schemaSha256: sha256File(schemaPath),
  });
  const result = runVerifyDone(receipt, proofs);
  const body = parseRunnerJson(result);
  assert.equal(body && body.ok, false);
  if (productionHasWp03VerifyDonePath()) {
    assert.match(String(body.failureReason || ''), /^WP03_/);
    assert.match(
      result.combined,
      /catalogSha256|WP03_CATALOG_PROOF_INVALID|CATALOG/i,
    );
  } else {
    assert.equal(body.failureReason, FailureReason.WP03_VERIFY_DONE_UNAVAILABLE);
  }
  assert.equal(readJson(receipt).EffectiveDone, false);
});

test('WP-03 VERIFY-DONE RED-2.6: suite digest pass:false must fail-closed (when path exists)', () => {
  const { receipt, init } = initTempReceipt();
  assert.equal(init.status, 0);
  const proofs = identityProofs(IMPLEMENTATION_PR, {
    androidUnitTest: { pass: false, sha256: 'a'.repeat(64) },
    catalogSha256: sha256File(catalogPath),
    schemaSha256: sha256File(schemaPath),
  });
  const result = runVerifyDone(receipt, proofs);
  const body = parseRunnerJson(result);
  assert.equal(body && body.ok, false);
  if (productionHasWp03VerifyDonePath()) {
    assert.match(String(body.failureReason || ''), /^WP03_/);
    assert.match(
      result.combined,
      /pass must be true|WP03_SUITE_RECEIPT_INVALID/i,
    );
  } else {
    assert.equal(body.failureReason, FailureReason.WP03_VERIFY_DONE_UNAVAILABLE);
  }
  assert.equal(readJson(receipt).EffectiveDone, false);
});

// ---------------------------------------------------------------------------
// Progress guards
// ---------------------------------------------------------------------------

test('WP-03 VERIFY-DONE RED-3.1: Core progress tracks live WP-03 EffectiveDone (18% pre / 26% post)', () => {
  const live = liveWp03OperationalProgress();
  // Without WP-03 weight always 18%.
  const without = computeCoreProgress(defaultDoneReceiptsThroughWp02());
  assert.equal(without.status, 0, without.combined);
  assert.equal(parseRunnerJson(without).coreProgressPercent, 18);

  const progress = computeCoreProgress(defaultDoneReceipts());
  assert.equal(progress.status, 0, progress.combined);
  const body = parseRunnerJson(progress);
  assert.equal(body.coreProgressPercent, live.expectedCoreProgressPercent);
  const wp03 = (body.breakdown || []).find((r) => r.taskId === TASK_ID);
  assert.ok(wp03);
  assert.equal(wp03.weight, EXPECTED_WEIGHT);
  assert.equal(wp03.EffectiveDone, live.EffectiveDone);
  assert.equal(readJson(wp03TxnReceipt).EffectiveDone, live.EffectiveDone);
});

test('WP-03 VERIFY-DONE RED-3.2: GREEN success target is progress 26% from catalog weights', () => {
  const loaded = loadWp03CatalogTask();
  assert.equal(loaded.task.weight, 8);
  assert.equal(18 + loaded.task.weight, EXPECTED_PROGRESS_WHEN_DONE);

  // When path exists, temp DONE + map elevates to 26%.
  const { receipt, init } = initTempReceipt();
  assert.equal(init.status, 0);
  const done = runVerifyDone(receipt, validProofs(IMPLEMENTATION_PR));
  if (!productionHasWp03VerifyDonePath()) {
    assert.equal(
      parseRunnerJson(done).failureReason,
      FailureReason.WP03_VERIFY_DONE_UNAVAILABLE,
    );
    assert.equal(readJson(receipt).EffectiveDone, false);
    // Still document weight target.
    assert.equal(EXPECTED_PROGRESS_WHEN_DONE, 26);
    return;
  }
  assert.equal(done.status, 0, done.combined);
  const progress = computeCoreProgress({
    'WP-00': wp00MergeReceipt,
    'WP-01': wp01TxnReceipt,
    'WP-02': wp02TxnReceipt,
    'WP-03': receipt,
  });
  assert.equal(progress.status, 0, progress.combined);
  assert.equal(parseRunnerJson(progress).coreProgressPercent, 26);
});

test('WP-03 VERIFY-DONE RED-3.3: runner source must not require mergeSha == live tip', () => {
  const src = fs.readFileSync(runnerPath, 'utf8');
  // WP-02 already documents ancestry-only; GREEN WP-03 must keep the same rule.
  assert.match(src, /never require mergeSha == live tip|Ancestry only|merge-base --is-ancestor/i);
});

test('WP-03 VERIFY-DONE RED-3.4: WP-04 EffectiveDone not elevated by WP-03 close', () => {
  const catalog = readJson(catalogPath);
  assert.ok(Array.isArray(catalog.tasks));
  const live = liveWp03OperationalProgress();
  // WP-03 close must not auto-elevate WP-04. Catalog may register WP-04 later.
  const wp04 = (catalog.tasks || []).find((t) => t && t.taskId === 'WP-04');
  if (wp04) {
    assert.equal(wp04.weight, 10);
    assert.equal(wp04.evidenceLevel, 'E1');
    // Catalog must never author EffectiveDone / state (runtime fields).
    assert.equal(wp04.EffectiveDone, undefined);
    assert.equal(wp04.state, undefined);
  }
  // WP-04 may later reach DONE only via its own verify-done (not WP-03 close).
  const wp04Path = path.join(path.dirname(wp03TxnReceipt), 'wp-04.json');
  if (pathExists(wp04Path)) {
    const wp04Receipt = readJson(wp04Path);
    if (wp04Receipt.EffectiveDone === true) {
      assert.equal(wp04Receipt.state, 'DONE');
      assert.ok(
        wp04Receipt.verifyDone,
        'WP-04 DONE must carry verifyDone proof (not elevated by WP-03 close alone)',
      );
    } else {
      assert.notEqual(wp04Receipt.state, 'DONE');
    }
  }
  if (live.EffectiveDone) {
    assert.ok(live.receipt.verifyDone, 'WP-03 DONE requires verifyDone proof');
  }
});
