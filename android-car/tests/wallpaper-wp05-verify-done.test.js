'use strict';

/**
 * WP-05 / VERIFY-DONE RED-01 — production verify-done path contracts.
 *
 * RED only: pins WP05_VERIFY_DONE_UNAVAILABLE until GREEN implements
 * evaluate_wp05_verify_done. Does not modify production CLI.
 * Does not elevate operational WP-05 EffectiveDone / Core progress (36%).
 *
 * Implementation proof (dynamic readback target):
 *   PR #14 · head b173d9c4… · merge/live tip cf5b4b0c…
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
  contractPath,
  finalInfraReceipt,
  wp00MergeReceipt,
  wp01TxnReceipt,
  wp02TxnReceipt,
  wp03TxnReceipt,
  wp04TxnReceipt,
  wp05TxnReceipt,
  TASK_ID,
  EXPECTED_WEIGHT,
  EXPECTED_PROGRESS_WHEN_DONE,
  EXPECTED_PROGRESS_PRE_DONE,
  IMPLEMENTATION_PR,
  IMPLEMENTATION_HEAD,
  IMPLEMENTATION_MERGE,
  IMPLEMENTATION_HEAD_REF,
  FailureReason,
  MISTAG_RE,
  git,
  runRunner,
  parseRunnerJson,
  readJson,
  pathExists,
  sha256File,
  liveAuthoritativeBaseSha,
  isAncestor,
  readTaskWorktreeIdentity,
  loadWp05CatalogTask,
  readPrerequisiteDone,
  assertWp05ProductionSurfacesPresent,
  initTempReceipt,
  discoverImplementationIdentity,
  identityProofs,
  runVerifyDone,
  computeCoreProgress,
  defaultDoneReceipts,
  defaultDoneReceiptsThroughWp04,
  liveWp05OperationalProgress,
  productionHasWp05VerifyDonePath,
} = require('./wallpaper-wp05-verify-done-helpers');

function validProofs(prNumber = IMPLEMENTATION_PR) {
  return identityProofs(prNumber, {
    catalogSha256: sha256File(catalogPath),
    schemaSha256: sha256File(schemaPath),
  });
}

function assertWp05FailureNamespace(body, resultCombined) {
  assert.ok(body, resultCombined);
  assert.equal(body.ok, false, resultCombined);
  // Never mis-tag WP-05 as WP04/WP03/WP02 unavailable.
  assert.notEqual(body.failureReason, FailureReason.WP04_VERIFY_DONE_UNAVAILABLE);
  assert.notEqual(body.failureReason, FailureReason.WP03_VERIFY_DONE_UNAVAILABLE);
  assert.notEqual(body.failureReason, FailureReason.WP02_VERIFY_DONE_UNAVAILABLE);
  assert.doesNotMatch(String(body.failureReason || ''), MISTAG_RE);
  assert.match(String(body.failureReason || ''), /^WP05_/, body.failureReason);
}

// ---------------------------------------------------------------------------
// Environment / dynamic facts (may PASS in RED)
// ---------------------------------------------------------------------------

test('WP-05 VERIFY-DONE RED-0: worktree identity and live base from ls-remote', () => {
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

test('WP-05 VERIFY-DONE RED-0.1: prerequisites WP-INFRA/00/01/02/03/04 DONE from real receipts', () => {
  const prereq = readPrerequisiteDone();
  assert.equal(prereq.ok, true, JSON.stringify(prereq));
  assert.equal(prereq.WP_INFRA.EffectiveDone, true);
  assert.equal(prereq['WP-00'].EffectiveDone, true);
  assert.equal(prereq['WP-01'].EffectiveDone, true);
  assert.equal(prereq['WP-02'].EffectiveDone, true);
  assert.equal(prereq['WP-03'].EffectiveDone, true);
  assert.equal(prereq['WP-04'].EffectiveDone, true);
  assert.equal(prereq['WP-04'].state, 'DONE');
  assert.equal(pathExists(finalInfraReceipt), true);
  assert.equal(pathExists(wp00MergeReceipt), true);
  assert.equal(pathExists(wp01TxnReceipt), true);
  assert.equal(pathExists(wp02TxnReceipt), true);
  assert.equal(pathExists(wp03TxnReceipt), true);
  assert.equal(pathExists(wp04TxnReceipt), true);
});

test('WP-05 VERIFY-DONE RED-0.2: catalog WP-05 unique weight=8 evidence E1', () => {
  const loaded = loadWp05CatalogTask();
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  assert.equal(loaded.task.weight, EXPECTED_WEIGHT);
  assert.equal(loaded.task.evidenceLevel, 'E1');
  assert.ok(Array.isArray(loaded.task.requiredEffectiveDone));
  for (const dep of ['WP-INFRA', 'WP-00', 'WP-01', 'WP-02', 'WP-03', 'WP-04']) {
    assert.ok(
      loaded.task.requiredEffectiveDone.includes(dep),
      `missing requiredEffectiveDone ${dep}`,
    );
  }
  assert.equal(
    (loaded.catalog.tasks || []).filter((t) => t && t.taskId === TASK_ID).length,
    1,
  );
  const surfaces = assertWp05ProductionSurfacesPresent();
  assert.equal(surfaces.ok, true, JSON.stringify(surfaces));
  assert.equal(pathExists(contractPath), true);
});

test('WP-05 VERIFY-DONE RED-0.3: PR #14 identity + ancestry (dynamic gh API)', () => {
  const live = liveAuthoritativeBaseSha();
  const id = discoverImplementationIdentity({ prNumber: IMPLEMENTATION_PR });
  assert.equal(id.ok, true, JSON.stringify(id));
  assert.equal(id.merged, true);
  assert.ok(id.mergedAt);
  assert.equal(id.baseRefName, 'huawei-android12-car');
  assert.equal(id.headRefName, IMPLEMENTATION_HEAD_REF);
  assert.equal(String(id.headRefOid).toLowerCase(), IMPLEMENTATION_HEAD);
  assert.equal(String(id.mergeSha).toLowerCase(), IMPLEMENTATION_MERGE);
  assert.equal(id.mergeIsAncestorOfLiveBase, true);
  assert.equal(id.headIsAncestorOfLiveBase, true);
  assert.equal(isAncestor(id.mergeSha, live), true);
  assert.equal(isAncestor(id.headRefOid, live), true);
  // Must not require mergeSha == live tip as the only success condition.
  assert.equal(typeof id.mergeEqualsLiveTip, 'boolean');
  if (id.headRepo) {
    assert.equal(id.headRepo, 'anpplex/Mineradio-AndroidAuto');
  }
});

// ---------------------------------------------------------------------------
// RED: production path missing — stable WP05_VERIFY_DONE_UNAVAILABLE
// ---------------------------------------------------------------------------

test('WP-05 VERIFY-DONE RED-1: production evaluate_wp05_verify_done path status', () => {
  const src = fs.readFileSync(runnerPath, 'utf8');
  if (productionHasWp05VerifyDonePath()) {
    // GREEN landed: evaluate path + WP05_* namespace present.
    assert.match(src, /evaluate_wp05_verify_done/, FailureReason.WP05_VERIFY_DONE_UNAVAILABLE);
    assert.match(src, /WP05_VERIFY_DONE_UNAVAILABLE/);
    assert.match(src, /WP05_VERIFY_DONE_PROOF_MISSING/);
    assert.match(src, /WP05_VERIFY_DONE_CALLER_FORGERY/);
  } else {
    // RED: path absent.
    assert.equal(
      productionHasWp05VerifyDonePath(),
      false,
      'RED expects evaluate_wp05_verify_done absent until GREEN',
    );
    assert.doesNotMatch(src, /evaluate_wp05_verify_done/);
  }
  // Never route WP-05 through WP04_*/WP03_* unavailable as the only reason.
  assert.doesNotMatch(
    src,
    /elif task_id == ["']WP-05["'][\s\S]{0,200}WP04_VERIFY_DONE_UNAVAILABLE/,
  );
  assert.doesNotMatch(
    src,
    /elif task_id == ["']WP-05["'][\s\S]{0,200}WP03_VERIFY_DONE_UNAVAILABLE/,
  );
});

test('WP-05 VERIFY-DONE RED-1.0: WP-05 failures use WP05_* never WP04/WP03/WP02 mis-tag', () => {
  const { receipt, init } = initTempReceipt();
  assert.equal(init.status, 0, init.combined);
  const result = runVerifyDone(receipt, null);
  const body = parseRunnerJson(result);
  assertWp05FailureNamespace(body, result.combined);
  if (productionHasWp05VerifyDonePath()) {
    assert.equal(
      body.failureReason,
      FailureReason.WP05_VERIFY_DONE_PROOF_MISSING,
      body.failureReason,
    );
  } else {
    assert.equal(
      body.failureReason,
      FailureReason.WP05_VERIFY_DONE_UNAVAILABLE,
      body.failureReason,
    );
  }
  assert.equal(readJson(receipt).EffectiveDone, false);
});

test('WP-05 VERIFY-DONE RED-1.1: bare verify-done fails closed without proofs', () => {
  const { receipt, init } = initTempReceipt();
  assert.equal(init.status, 0, init.combined);
  assert.equal(readJson(receipt).EffectiveDone, false);

  const result = runVerifyDone(receipt, null);
  const body = parseRunnerJson(result);
  assertWp05FailureNamespace(body, result.combined);
  if (productionHasWp05VerifyDonePath()) {
    assert.match(
      result.combined,
      /PROOF_MISSING|missing WP-05 proofs|WP05_VERIFY_DONE_PROOF_MISSING/i,
    );
  } else {
    assert.equal(
      body.failureReason,
      FailureReason.WP05_VERIFY_DONE_UNAVAILABLE,
      body.failureReason,
    );
  }
  assert.equal(readJson(receipt).EffectiveDone, false);
  assert.notEqual(readJson(receipt).state, 'DONE');
});

test('WP-05 VERIFY-DONE RED-1.2: GREEN success target fails until path exists', () => {
  const { receipt, init } = initTempReceipt();
  assert.equal(init.status, 0, init.combined);

  const result = runVerifyDone(receipt, validProofs(IMPLEMENTATION_PR));
  const body = parseRunnerJson(result);
  if (!productionHasWp05VerifyDonePath()) {
    assert.equal(body && body.ok, false, result.combined);
    assert.equal(
      body.failureReason,
      FailureReason.WP05_VERIFY_DONE_UNAVAILABLE,
      `${FailureReason.WP05_VERIFY_DONE_UNAVAILABLE}: ${result.combined}`,
    );
    assert.equal(readJson(receipt).EffectiveDone, false);
    return;
  }
  assert.equal(
    body && body.ok,
    true,
    `${FailureReason.WP05_VERIFY_DONE_UNAVAILABLE}: success path not implemented: ${result.combined}`,
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
  assert.ok(vd.implementationMergeSha);
});

test('WP-05 VERIFY-DONE RED-1.3: operational wp-05 txn tracks live verify-done (non-DONE or DONE with proof)', () => {
  assert.equal(pathExists(wp05TxnReceipt), true);
  const before = readJson(wp05TxnReceipt);
  assert.equal(before.taskId, TASK_ID);
  const live = liveWp05OperationalProgress();
  if (live.EffectiveDone) {
    assert.equal(before.EffectiveDone, true);
    assert.equal(before.state, 'DONE');
    assert.ok(before.verifyDone && typeof before.verifyDone === 'object');
  } else {
    assert.equal(before.EffectiveDone, false);
    assert.notEqual(before.state, 'DONE');
    assert.ok(
      [
        'INIT',
        'RED_RECORDED',
        'GREEN_RECORDED',
        'REFACTOR_RECORDED',
        'VERIFY_READY',
      ].includes(before.state),
      before.state,
    );
  }
});

// ---------------------------------------------------------------------------
// Fail-closed rejections
// ---------------------------------------------------------------------------

test('WP-05 VERIFY-DONE RED-2.1: rejects caller-forged EffectiveDone / progress on receipt-cas', () => {
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
    JSON.stringify({ EffectiveDone: true, coreProgressPercent: 44 }),
  ]);
  assert.notEqual(cas.status, 0);
  assert.match(
    cas.combined,
    /ONLY_VERIFY_DONE_MAY_ENABLE_EFFECTIVE_DONE|CALLER|EffectiveDone/i,
  );
  assert.equal(readJson(receipt).EffectiveDone, false);
});

test('WP-05 VERIFY-DONE RED-2.2: rejects caller-forged merged / REMOTE_VERIFIED / mergeSha / digests', () => {
  const { receipt, init } = initTempReceipt();
  assert.equal(init.status, 0);

  const forged = identityProofs(IMPLEMENTATION_PR, {
    merged: true,
    REMOTE_VERIFIED: true,
    EffectiveDone: true,
    mergeSha: 'a'.repeat(40),
    coreProgressPercent: 44,
    catalogSha: '0'.repeat(64),
    schemaSha: '1'.repeat(64),
    suiteDigests: { forged: true },
    catalogSha256: '0'.repeat(64),
    schemaSha256: '1'.repeat(64),
    androidUnitTest: { pass: true, sha256: 'f'.repeat(64) },
    fullNodeTest: { pass: true, sha256: 'e'.repeat(64) },
    bridgeUnitTest: { pass: true, sha256: 'd'.repeat(64) },
  });
  const result = runVerifyDone(receipt, forged);
  const body = parseRunnerJson(result);
  assertWp05FailureNamespace(body, result.combined);
  assert.match(result.combined, /FORGERY|PROOF|UNAVAILABLE|CALLER|WP05_/i);
  if (productionHasWp05VerifyDonePath()) {
    assert.equal(
      body.failureReason,
      FailureReason.WP05_VERIFY_DONE_CALLER_FORGERY,
      body.failureReason,
    );
  } else {
    assert.equal(
      body.failureReason,
      FailureReason.WP05_VERIFY_DONE_UNAVAILABLE,
      body.failureReason,
    );
  }
  assert.equal(readJson(receipt).EffectiveDone, false);
  assert.notEqual(readJson(receipt).state, 'DONE');
});

test('WP-05 VERIFY-DONE RED-2.3: rejects missing proofs / empty proofs fail-closed', () => {
  const { receipt, init } = initTempReceipt();
  assert.equal(init.status, 0);

  const noProofs = runVerifyDone(receipt, null);
  const empty = runVerifyDone(receipt, {});
  for (const result of [noProofs, empty]) {
    const body = parseRunnerJson(result);
    assertWp05FailureNamespace(body, result.combined);
    if (productionHasWp05VerifyDonePath()) {
      assert.match(
        result.combined,
        /PROOF_MISSING|missing WP-05 proofs|WP05_VERIFY_DONE_PROOF_MISSING/i,
      );
    } else {
      assert.equal(
        body.failureReason,
        FailureReason.WP05_VERIFY_DONE_UNAVAILABLE,
        body.failureReason,
      );
    }
  }
  assert.equal(readJson(receipt).EffectiveDone, false);
});

test('WP-05 VERIFY-DONE RED-2.4: rejects unmerged / nonexistent PR identity (when path exists)', () => {
  const { receipt, init } = initTempReceipt();
  assert.equal(init.status, 0);
  const result = runVerifyDone(receipt, validProofs(999999999));
  const body = parseRunnerJson(result);
  assertWp05FailureNamespace(body, result.combined);
  if (productionHasWp05VerifyDonePath()) {
    assert.match(
      result.combined,
      /PR_PROOF|NOT_MERGED|PROOF|Could not resolve|WP05_/i,
    );
  } else {
    assert.equal(body.failureReason, FailureReason.WP05_VERIFY_DONE_UNAVAILABLE);
  }
  assert.equal(readJson(receipt).EffectiveDone, false);
});

test('WP-05 VERIFY-DONE RED-2.5: catalog SHA mismatch must fail-closed (when path exists)', () => {
  const { receipt, init } = initTempReceipt();
  assert.equal(init.status, 0);
  const proofs = identityProofs(IMPLEMENTATION_PR, {
    catalogSha256: '0'.repeat(64),
    schemaSha256: sha256File(schemaPath),
  });
  const result = runVerifyDone(receipt, proofs);
  const body = parseRunnerJson(result);
  assertWp05FailureNamespace(body, result.combined);
  if (productionHasWp05VerifyDonePath()) {
    assert.match(
      result.combined,
      /catalogSha256|WP05_CATALOG_PROOF_INVALID|CATALOG/i,
    );
  } else {
    assert.equal(body.failureReason, FailureReason.WP05_VERIFY_DONE_UNAVAILABLE);
  }
  assert.equal(readJson(receipt).EffectiveDone, false);
});

test('WP-05 VERIFY-DONE RED-2.6: suite digest pass:false must fail-closed (when path exists)', () => {
  const { receipt, init } = initTempReceipt();
  assert.equal(init.status, 0);
  const proofs = identityProofs(IMPLEMENTATION_PR, {
    androidUnitTest: { pass: false, sha256: 'a'.repeat(64) },
    bridgeUnitTest: { pass: true, sha256: 'b'.repeat(64) },
    catalogSha256: sha256File(catalogPath),
    schemaSha256: sha256File(schemaPath),
  });
  const result = runVerifyDone(receipt, proofs);
  const body = parseRunnerJson(result);
  assertWp05FailureNamespace(body, result.combined);
  if (productionHasWp05VerifyDonePath()) {
    assert.match(
      result.combined,
      /pass must be true|WP05_SUITE_RECEIPT_INVALID/i,
    );
  } else {
    assert.equal(body.failureReason, FailureReason.WP05_VERIFY_DONE_UNAVAILABLE);
  }
  assert.equal(readJson(receipt).EffectiveDone, false);
});

test('WP-05 VERIFY-DONE RED-2.7: repository/base/head mismatch fail-closed (when path exists)', () => {
  const { receipt, init } = initTempReceipt();
  assert.equal(init.status, 0);
  // Wrong PR identity — WP-04 verify-done PR #13, not WP-05 implementation.
  const proofs = identityProofs(13, {
    catalogSha256: sha256File(catalogPath),
    schemaSha256: sha256File(schemaPath),
  });
  const result = runVerifyDone(receipt, proofs);
  const body = parseRunnerJson(result);
  assertWp05FailureNamespace(body, result.combined);
  if (productionHasWp05VerifyDonePath()) {
    assert.match(
      result.combined,
      /PR_PROOF|headRef|baseRef|PROOF|WP05_|mismatch|identity|surface/i,
    );
  } else {
    assert.equal(body.failureReason, FailureReason.WP05_VERIFY_DONE_UNAVAILABLE);
  }
  assert.equal(readJson(receipt).EffectiveDone, false);
});

// ---------------------------------------------------------------------------
// Progress guards
// ---------------------------------------------------------------------------

test('WP-05 VERIFY-DONE RED-3.1: Core progress tracks live WP-05 EffectiveDone (36% pre / 44% post)', () => {
  const live = liveWp05OperationalProgress();
  const without = computeCoreProgress(defaultDoneReceiptsThroughWp04());
  assert.equal(without.status, 0, without.combined);
  assert.equal(parseRunnerJson(without).coreProgressPercent, EXPECTED_PROGRESS_PRE_DONE);

  const progress = computeCoreProgress(defaultDoneReceipts());
  assert.equal(progress.status, 0, progress.combined);
  const body = parseRunnerJson(progress);
  assert.equal(body.coreProgressPercent, live.expectedCoreProgressPercent);
  const wp05 = (body.breakdown || []).find((r) => r.taskId === TASK_ID);
  if (wp05) {
    assert.equal(wp05.weight, EXPECTED_WEIGHT);
    assert.equal(wp05.EffectiveDone, live.EffectiveDone);
  }
  assert.equal(readJson(wp05TxnReceipt).EffectiveDone, live.EffectiveDone);
});

test('WP-05 VERIFY-DONE RED-3.2: GREEN success target is progress 44% from catalog weights', () => {
  const loaded = loadWp05CatalogTask();
  assert.equal(loaded.task.weight, 8);
  assert.equal(
    EXPECTED_PROGRESS_PRE_DONE + loaded.task.weight,
    EXPECTED_PROGRESS_WHEN_DONE,
  );

  const { receipt, init } = initTempReceipt();
  assert.equal(init.status, 0);
  const done = runVerifyDone(receipt, validProofs(IMPLEMENTATION_PR));
  if (!productionHasWp05VerifyDonePath()) {
    assert.equal(
      parseRunnerJson(done).failureReason,
      FailureReason.WP05_VERIFY_DONE_UNAVAILABLE,
    );
    assert.equal(readJson(receipt).EffectiveDone, false);
    assert.equal(EXPECTED_PROGRESS_WHEN_DONE, 44);
    return;
  }
  assert.equal(done.status, 0, done.combined);
  const progress = computeCoreProgress({
    'WP-00': wp00MergeReceipt,
    'WP-01': wp01TxnReceipt,
    'WP-02': wp02TxnReceipt,
    'WP-03': wp03TxnReceipt,
    'WP-04': wp04TxnReceipt,
    'WP-05': receipt,
  });
  assert.equal(progress.status, 0, progress.combined);
  assert.equal(parseRunnerJson(progress).coreProgressPercent, 44);
});

test('WP-05 VERIFY-DONE RED-3.3: runner source must not require mergeSha == live tip', () => {
  const src = fs.readFileSync(runnerPath, 'utf8');
  // WP-02/03/04 document ancestry-only; GREEN WP-05 must keep the same rule.
  assert.match(
    src,
    /never require mergeSha == live tip|Ancestry only|merge-base --is-ancestor/i,
  );
});

test('WP-05 VERIFY-DONE RED-3.4: WP-06 not started; WP-05 EffectiveDone not elevated without verify-done', () => {
  const catalog = readJson(catalogPath);
  assert.ok(Array.isArray(catalog.tasks));
  const live = liveWp05OperationalProgress();
  const wp06 = (catalog.tasks || []).find((t) => t && t.taskId === 'WP-06');
  if (wp06) {
    assert.equal(wp06.EffectiveDone, undefined);
    assert.equal(wp06.state, undefined);
  }
  const wp06Txn = path.join(
    '/Users/anpple/Codex/Mineradio/android-car/verification/wallpaper-plugin/transactions',
    'wp-06.json',
  );
  // WP-06 may later DONE only via its own verify-done (not WP-05).
  if (pathExists(wp06Txn)) {
    const r = readJson(wp06Txn);
    if (r.EffectiveDone === true) {
      assert.ok(r.verifyDone, 'WP-06 DONE requires own verifyDone proof');
    }
  }
  assert.equal(readJson(wp05TxnReceipt).EffectiveDone, live.EffectiveDone);
  if (live.EffectiveDone) {
    assert.ok(live.receipt.verifyDone, 'WP-05 DONE requires verifyDone proof');
  } else {
    assert.equal(readJson(wp05TxnReceipt).EffectiveDone, false);
  }
  // Baseline without WP-05 weight stays 36%.
  const progress = computeCoreProgress(defaultDoneReceiptsThroughWp04());
  assert.equal(parseRunnerJson(progress).coreProgressPercent, 36);
});

test('WP-05 VERIFY-DONE RED-3.5: phase ledger present on operational receipt (structure)', () => {
  assert.equal(pathExists(wp05TxnReceipt), true);
  const receipt = readJson(wp05TxnReceipt);
  assert.equal(receipt.schema, 'wallpaper-task-receipt/v1');
  assert.ok(Array.isArray(receipt.phaseEvents));
  if (receipt.EffectiveDone !== true) {
    assert.ok(
      !receipt.phaseEvents.some((e) => e && e.phase === 'DONE' && e.status === 'PASS'),
    );
  }
});
