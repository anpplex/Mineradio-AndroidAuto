'use strict';

/**
 * WP-04 / VERIFY-DONE RED-01 — production verify-done path contracts.
 *
 * RED only: pins WP04_VERIFY_DONE_UNAVAILABLE until GREEN implements
 * evaluate_wp04_verify_done. Does not modify production CLI.
 * Does not elevate operational WP-04 EffectiveDone / Core progress (26%).
 *
 * Implementation proof (dynamic readback target):
 *   PR #12 · head a203169… · merge/live tip eb1b6dc…
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
  TASK_ID,
  EXPECTED_WEIGHT,
  EXPECTED_PROGRESS_WHEN_DONE,
  EXPECTED_PROGRESS_PRE_DONE,
  IMPLEMENTATION_PR,
  IMPLEMENTATION_HEAD,
  IMPLEMENTATION_MERGE,
  IMPLEMENTATION_HEAD_REF,
  FailureReason,
  git,
  runRunner,
  parseRunnerJson,
  readJson,
  pathExists,
  sha256File,
  liveAuthoritativeBaseSha,
  isAncestor,
  readTaskWorktreeIdentity,
  loadWp04CatalogTask,
  readPrerequisiteDone,
  assertWp04ProductionSurfacesPresent,
  initTempReceipt,
  discoverImplementationIdentity,
  identityProofs,
  runVerifyDone,
  computeCoreProgress,
  defaultDoneReceipts,
  defaultDoneReceiptsThroughWp03,
  liveWp04OperationalProgress,
  productionHasWp04VerifyDonePath,
} = require('./wallpaper-wp04-verify-done-helpers');

function validProofs(prNumber = IMPLEMENTATION_PR) {
  return identityProofs(prNumber, {
    catalogSha256: sha256File(catalogPath),
    schemaSha256: sha256File(schemaPath),
  });
}

// ---------------------------------------------------------------------------
// Environment / dynamic facts (may PASS in RED)
// ---------------------------------------------------------------------------

test('WP-04 VERIFY-DONE RED-0: worktree identity and live base from ls-remote', () => {
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

test('WP-04 VERIFY-DONE RED-0.1: prerequisites WP-INFRA/00/01/02/03 DONE from real receipts', () => {
  const prereq = readPrerequisiteDone();
  assert.equal(prereq.ok, true, JSON.stringify(prereq));
  assert.equal(prereq.WP_INFRA.EffectiveDone, true);
  assert.equal(prereq['WP-00'].EffectiveDone, true);
  assert.equal(prereq['WP-01'].EffectiveDone, true);
  assert.equal(prereq['WP-02'].EffectiveDone, true);
  assert.equal(prereq['WP-03'].EffectiveDone, true);
  assert.equal(pathExists(finalInfraReceipt), true);
  assert.equal(pathExists(wp00MergeReceipt), true);
  assert.equal(pathExists(wp01TxnReceipt), true);
  assert.equal(pathExists(wp02TxnReceipt), true);
  assert.equal(pathExists(wp03TxnReceipt), true);
});

test('WP-04 VERIFY-DONE RED-0.2: catalog WP-04 unique weight=10 evidence E1', () => {
  const loaded = loadWp04CatalogTask();
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  assert.equal(loaded.task.weight, EXPECTED_WEIGHT);
  assert.equal(loaded.task.evidenceLevel, 'E1');
  assert.ok(Array.isArray(loaded.task.requiredEffectiveDone));
  for (const dep of ['WP-INFRA', 'WP-00', 'WP-01', 'WP-02', 'WP-03']) {
    assert.ok(
      loaded.task.requiredEffectiveDone.includes(dep),
      `missing requiredEffectiveDone ${dep}`,
    );
  }
  // Exactly one WP-04
  assert.equal(
    (loaded.catalog.tasks || []).filter((t) => t && t.taskId === TASK_ID).length,
    1,
  );
  const surfaces = assertWp04ProductionSurfacesPresent();
  assert.equal(surfaces.ok, true, JSON.stringify(surfaces));
  assert.equal(pathExists(contractPath), true);
});

test('WP-04 VERIFY-DONE RED-0.3: PR #12 identity + ancestry (dynamic gh API)', () => {
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
});

// ---------------------------------------------------------------------------
// RED: production path missing — stable WP04_VERIFY_DONE_UNAVAILABLE
// ---------------------------------------------------------------------------

test('WP-04 VERIFY-DONE RED-1: production evaluate_wp04_verify_done path present (GREEN)', () => {
  // GREEN: evaluate_wp04_verify_done + WP-04 dispatch + WP04_* namespace.
  assert.equal(
    productionHasWp04VerifyDonePath(),
    true,
    FailureReason.WP04_VERIFY_DONE_UNAVAILABLE,
  );
  const src = fs.readFileSync(runnerPath, 'utf8');
  assert.match(src, /evaluate_wp04_verify_done/, FailureReason.WP04_VERIFY_DONE_UNAVAILABLE);
  assert.match(src, /WP04_VERIFY_DONE_UNAVAILABLE/, FailureReason.WP04_VERIFY_DONE_UNAVAILABLE);
  assert.match(
    src,
    /WP04_VERIFY_DONE_CALLER_FORGERY/,
    FailureReason.WP04_VERIFY_DONE_UNAVAILABLE,
  );
  assert.match(
    src,
    /WP04_VERIFY_DONE_PROOF_MISSING/,
    FailureReason.WP04_VERIFY_DONE_UNAVAILABLE,
  );
  // Must never route WP-04 through WP03_* unavailable.
  assert.doesNotMatch(
    src,
    /elif task_id == ["']WP-04["'][\s\S]{0,200}WP03_VERIFY_DONE_UNAVAILABLE/,
  );
});

test('WP-04 VERIFY-DONE RED-1.0: WP-04 failures use WP04_* never WP03_* mis-tag', () => {
  const { receipt, init } = initTempReceipt();
  assert.equal(init.status, 0, init.combined);
  const result = runVerifyDone(receipt, null);
  const body = parseRunnerJson(result);
  assert.ok(body, result.combined);
  assert.equal(body.ok, false, result.combined);
  // Never WP03_VERIFY_DONE_UNAVAILABLE for WP-04.
  assert.notEqual(
    body.failureReason,
    FailureReason.WP03_VERIFY_DONE_UNAVAILABLE,
    'WP-04 must not mis-tag as WP03_VERIFY_DONE_UNAVAILABLE',
  );
  assert.match(String(body.failureReason), /^WP04_/, body.failureReason);
  if (productionHasWp04VerifyDonePath()) {
    // GREEN: bare call is proof-missing, not path-unavailable.
    assert.equal(
      body.failureReason,
      FailureReason.WP04_VERIFY_DONE_PROOF_MISSING,
      body.failureReason,
    );
  } else {
    assert.equal(
      body.failureReason,
      FailureReason.WP04_VERIFY_DONE_UNAVAILABLE,
      body.failureReason,
    );
  }
  assert.equal(readJson(receipt).EffectiveDone, false);
});

test('WP-04 VERIFY-DONE RED-1.1: bare verify-done fails closed without proofs', () => {
  const { receipt, init } = initTempReceipt();
  assert.equal(init.status, 0, init.combined);
  assert.equal(readJson(receipt).EffectiveDone, false);

  const result = runVerifyDone(receipt, null);
  const body = parseRunnerJson(result);
  assert.ok(body, result.combined);
  assert.equal(body.ok, false, result.combined);
  // Before GREEN: WP04_VERIFY_DONE_UNAVAILABLE. After GREEN: proof missing (WP04_*).
  if (productionHasWp04VerifyDonePath()) {
    assert.match(String(body.failureReason), /^WP04_/, body.failureReason);
    assert.match(
      result.combined,
      /PROOF_MISSING|missing WP-04 proofs|WP04_VERIFY_DONE_PROOF_MISSING/i,
    );
  } else {
    assert.equal(
      body.failureReason,
      FailureReason.WP04_VERIFY_DONE_UNAVAILABLE,
      body.failureReason,
    );
  }
  assert.equal(readJson(receipt).EffectiveDone, false);
  assert.notEqual(readJson(receipt).state, 'DONE');
});

test('WP-04 VERIFY-DONE RED-1.2: GREEN success target fails until path exists', () => {
  const { receipt, init } = initTempReceipt();
  assert.equal(init.status, 0, init.combined);

  const result = runVerifyDone(receipt, validProofs(IMPLEMENTATION_PR));
  const body = parseRunnerJson(result);
  // Until GREEN: not ok; signature must be WP04_VERIFY_DONE_UNAVAILABLE.
  assert.equal(
    body && body.ok,
    true,
    `${FailureReason.WP04_VERIFY_DONE_UNAVAILABLE}: success path not implemented: ${result.combined}`,
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

test('WP-04 VERIFY-DONE RED-1.3: operational wp-04 txn tracks live verify-done (non-DONE or DONE with proof)', () => {
  assert.equal(pathExists(wp04TxnReceipt), true);
  const before = readJson(wp04TxnReceipt);
  assert.equal(before.taskId, TASK_ID);
  const live = liveWp04OperationalProgress();
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

test('WP-04 VERIFY-DONE RED-2.1: rejects caller-forged EffectiveDone / progress on receipt-cas', () => {
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
    JSON.stringify({ EffectiveDone: true, coreProgressPercent: 36 }),
  ]);
  assert.notEqual(cas.status, 0);
  assert.match(
    cas.combined,
    /ONLY_VERIFY_DONE_MAY_ENABLE_EFFECTIVE_DONE|CALLER|EffectiveDone/i,
  );
  assert.equal(readJson(receipt).EffectiveDone, false);
});

test('WP-04 VERIFY-DONE RED-2.2: rejects caller-forged merged / REMOTE_VERIFIED / mergeSha / digests', () => {
  const { receipt, init } = initTempReceipt();
  assert.equal(init.status, 0);

  const forged = identityProofs(IMPLEMENTATION_PR, {
    merged: true,
    REMOTE_VERIFIED: true,
    EffectiveDone: true,
    mergeSha: 'a'.repeat(40),
    coreProgressPercent: 36,
    catalogSha256: '0'.repeat(64),
    schemaSha256: '1'.repeat(64),
    androidUnitTest: { pass: true, sha256: 'f'.repeat(64) },
    fullNodeTest: { pass: true, sha256: 'e'.repeat(64) },
    bridgeUnitTest: { pass: true, sha256: 'd'.repeat(64) },
  });
  const result = runVerifyDone(receipt, forged);
  const body = parseRunnerJson(result);
  assert.equal(body && body.ok, false, result.combined);
  assert.match(String(body.failureReason || ''), /^WP04_/);
  assert.match(result.combined, /FORGERY|PROOF|UNAVAILABLE|CALLER|WP04_/i);
  if (productionHasWp04VerifyDonePath()) {
    assert.equal(
      body.failureReason,
      FailureReason.WP04_VERIFY_DONE_CALLER_FORGERY,
      body.failureReason,
    );
  } else {
    assert.equal(
      body.failureReason,
      FailureReason.WP04_VERIFY_DONE_UNAVAILABLE,
      body.failureReason,
    );
  }
  assert.equal(readJson(receipt).EffectiveDone, false);
  assert.notEqual(readJson(receipt).state, 'DONE');
});

test('WP-04 VERIFY-DONE RED-2.3: rejects missing proofs / empty proofs fail-closed', () => {
  const { receipt, init } = initTempReceipt();
  assert.equal(init.status, 0);

  const noProofs = runVerifyDone(receipt, null);
  const empty = runVerifyDone(receipt, {});
  for (const result of [noProofs, empty]) {
    const body = parseRunnerJson(result);
    assert.equal(body && body.ok, false, result.combined);
    assert.match(String(body.failureReason || ''), /^WP04_/);
    if (productionHasWp04VerifyDonePath()) {
      assert.match(
        result.combined,
        /PROOF_MISSING|missing WP-04 proofs|WP04_VERIFY_DONE_PROOF_MISSING/i,
      );
    } else {
      assert.equal(
        body.failureReason,
        FailureReason.WP04_VERIFY_DONE_UNAVAILABLE,
        body.failureReason,
      );
    }
  }
  assert.equal(readJson(receipt).EffectiveDone, false);
});

test('WP-04 VERIFY-DONE RED-2.4: rejects unmerged / nonexistent PR identity (when path exists)', () => {
  const { receipt, init } = initTempReceipt();
  assert.equal(init.status, 0);
  const result = runVerifyDone(receipt, validProofs(999999999));
  const body = parseRunnerJson(result);
  assert.equal(body && body.ok, false, result.combined);
  if (productionHasWp04VerifyDonePath()) {
    assert.match(String(body.failureReason || ''), /^WP04_/);
    assert.match(
      result.combined,
      /PR_PROOF|NOT_MERGED|PROOF|Could not resolve|WP04_/i,
    );
  } else {
    assert.equal(body.failureReason, FailureReason.WP04_VERIFY_DONE_UNAVAILABLE);
  }
  assert.equal(readJson(receipt).EffectiveDone, false);
});

test('WP-04 VERIFY-DONE RED-2.5: catalog SHA mismatch must fail-closed (when path exists)', () => {
  const { receipt, init } = initTempReceipt();
  assert.equal(init.status, 0);
  const proofs = identityProofs(IMPLEMENTATION_PR, {
    catalogSha256: '0'.repeat(64),
    schemaSha256: sha256File(schemaPath),
  });
  const result = runVerifyDone(receipt, proofs);
  const body = parseRunnerJson(result);
  assert.equal(body && body.ok, false);
  if (productionHasWp04VerifyDonePath()) {
    assert.match(String(body.failureReason || ''), /^WP04_/);
    assert.match(
      result.combined,
      /catalogSha256|WP04_CATALOG_PROOF_INVALID|CATALOG/i,
    );
  } else {
    assert.equal(body.failureReason, FailureReason.WP04_VERIFY_DONE_UNAVAILABLE);
  }
  assert.equal(readJson(receipt).EffectiveDone, false);
});

test('WP-04 VERIFY-DONE RED-2.6: suite digest pass:false must fail-closed (when path exists)', () => {
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
  assert.equal(body && body.ok, false);
  if (productionHasWp04VerifyDonePath()) {
    assert.match(String(body.failureReason || ''), /^WP04_/);
    assert.match(
      result.combined,
      /pass must be true|WP04_SUITE_RECEIPT_INVALID/i,
    );
  } else {
    assert.equal(body.failureReason, FailureReason.WP04_VERIFY_DONE_UNAVAILABLE);
  }
  assert.equal(readJson(receipt).EffectiveDone, false);
});

test('WP-04 VERIFY-DONE RED-2.7: repository/base/head mismatch fail-closed (when path exists)', () => {
  const { receipt, init } = initTempReceipt();
  assert.equal(init.status, 0);
  // Wrong PR identity — wrong base/head for WP-04 implementation.
  const proofs = identityProofs(11, {
    catalogSha256: sha256File(catalogPath),
    schemaSha256: sha256File(schemaPath),
  });
  const result = runVerifyDone(receipt, proofs);
  const body = parseRunnerJson(result);
  assert.equal(body && body.ok, false);
  if (productionHasWp04VerifyDonePath()) {
    assert.match(String(body.failureReason || ''), /^WP04_/);
    assert.match(
      result.combined,
      /PR_PROOF|headRef|baseRef|PROOF|WP04_|mismatch|identity/i,
    );
  } else {
    assert.equal(body.failureReason, FailureReason.WP04_VERIFY_DONE_UNAVAILABLE);
  }
  assert.equal(readJson(receipt).EffectiveDone, false);
});

// ---------------------------------------------------------------------------
// Progress guards
// ---------------------------------------------------------------------------

test('WP-04 VERIFY-DONE RED-3.1: Core progress tracks live WP-04 EffectiveDone (26% pre / 36% post)', () => {
  const live = liveWp04OperationalProgress();
  // Without WP-04 weight always 26%.
  const without = computeCoreProgress(defaultDoneReceiptsThroughWp03());
  assert.equal(without.status, 0, without.combined);
  assert.equal(parseRunnerJson(without).coreProgressPercent, EXPECTED_PROGRESS_PRE_DONE);

  const progress = computeCoreProgress(defaultDoneReceipts());
  assert.equal(progress.status, 0, progress.combined);
  const body = parseRunnerJson(progress);
  assert.equal(body.coreProgressPercent, live.expectedCoreProgressPercent);
  const wp04 = (body.breakdown || []).find((r) => r.taskId === TASK_ID);
  assert.ok(wp04);
  assert.equal(wp04.weight, EXPECTED_WEIGHT);
  assert.equal(wp04.EffectiveDone, live.EffectiveDone);
  assert.equal(readJson(wp04TxnReceipt).EffectiveDone, live.EffectiveDone);
});

test('WP-04 VERIFY-DONE RED-3.2: GREEN success target is progress 36% from catalog weights', () => {
  const loaded = loadWp04CatalogTask();
  assert.equal(loaded.task.weight, 10);
  assert.equal(
    EXPECTED_PROGRESS_PRE_DONE + loaded.task.weight,
    EXPECTED_PROGRESS_WHEN_DONE,
  );

  const { receipt, init } = initTempReceipt();
  assert.equal(init.status, 0);
  const done = runVerifyDone(receipt, validProofs(IMPLEMENTATION_PR));
  if (!productionHasWp04VerifyDonePath()) {
    assert.equal(
      parseRunnerJson(done).failureReason,
      FailureReason.WP04_VERIFY_DONE_UNAVAILABLE,
    );
    assert.equal(readJson(receipt).EffectiveDone, false);
    assert.equal(EXPECTED_PROGRESS_WHEN_DONE, 36);
    return;
  }
  assert.equal(done.status, 0, done.combined);
  const progress = computeCoreProgress({
    'WP-00': wp00MergeReceipt,
    'WP-01': wp01TxnReceipt,
    'WP-02': wp02TxnReceipt,
    'WP-03': wp03TxnReceipt,
    'WP-04': receipt,
  });
  assert.equal(progress.status, 0, progress.combined);
  assert.equal(parseRunnerJson(progress).coreProgressPercent, 36);
});

test('WP-04 VERIFY-DONE RED-3.3: runner source must not require mergeSha == live tip', () => {
  const src = fs.readFileSync(runnerPath, 'utf8');
  // Existing WP-02/03 document ancestry-only; GREEN WP-04 must keep the same rule.
  assert.match(
    src,
    /never require mergeSha == live tip|Ancestry only|merge-base --is-ancestor/i,
  );
});

test('WP-04 VERIFY-DONE RED-3.4: WP-05 not started; WP-04 EffectiveDone not elevated without verify-done', () => {
  const catalog = readJson(catalogPath);
  assert.ok(Array.isArray(catalog.tasks));
  const live = liveWp04OperationalProgress();
  const wp05 = (catalog.tasks || []).find((t) => t && t.taskId === 'WP-05');
  // Catalog may or may not list WP-05 yet; if present, no runtime fields.
  if (wp05) {
    assert.equal(wp05.EffectiveDone, undefined);
    assert.equal(wp05.state, undefined);
  }
  assert.equal(readJson(wp04TxnReceipt).EffectiveDone, live.EffectiveDone);
  if (live.EffectiveDone) {
    assert.ok(live.receipt.verifyDone, 'WP-04 DONE requires verifyDone proof');
  } else {
    assert.equal(readJson(wp04TxnReceipt).EffectiveDone, false);
  }
  // Progress stays 26% without WP-04 EffectiveDone.
  const progress = computeCoreProgress(defaultDoneReceiptsThroughWp03());
  assert.equal(parseRunnerJson(progress).coreProgressPercent, 26);
});

test('WP-04 VERIFY-DONE RED-3.5: phase ledger present on operational receipt (structure)', () => {
  assert.equal(pathExists(wp04TxnReceipt), true);
  const receipt = readJson(wp04TxnReceipt);
  assert.equal(receipt.schema, 'wallpaper-task-receipt/v1');
  assert.ok(Array.isArray(receipt.phaseEvents));
  // RED/GREEN/VERIFY events may exist; DONE phase only via verify-done.
  if (receipt.EffectiveDone !== true) {
    assert.ok(
      !receipt.phaseEvents.some((e) => e && e.phase === 'DONE' && e.status === 'PASS'),
    );
  }
});
