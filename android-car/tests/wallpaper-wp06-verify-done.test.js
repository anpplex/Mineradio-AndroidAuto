'use strict';

/**
 * WP-06 / VERIFY-DONE RED-01 — production verify-done path contracts.
 *
 * RED only: pins WP06_VERIFY_DONE_UNAVAILABLE until GREEN implements
 * evaluate_wp06_verify_done. Does not modify production CLI.
 * Does not elevate operational WP-06 EffectiveDone / Core progress (44%).
 *
 * Implementation proof (dynamic readback target):
 *   PR #16 · head 3996ec27… · merge/live tip 0461f423…
 */

const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
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
  wp06TxnReceipt,
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
  runRunner,
  parseRunnerJson,
  readJson,
  pathExists,
  sha256File,
  liveAuthoritativeBaseSha,
  isAncestor,
  readTaskWorktreeIdentity,
  loadWp06CatalogTask,
  readPrerequisiteDone,
  assertWp06ProductionSurfacesPresent,
  initTempReceipt,
  discoverImplementationIdentity,
  identityProofs,
  runVerifyDone,
  computeCoreProgress,
  defaultDoneReceiptsThroughWp05,
  defaultDoneReceipts,
  liveWp06OperationalProgress,
  productionHasWp06VerifyDonePath,
} = require('./wallpaper-wp06-verify-done-helpers');

function validProofs(prNumber = IMPLEMENTATION_PR) {
  return identityProofs(prNumber, {
    catalogSha256: sha256File(catalogPath),
    schemaSha256: sha256File(schemaPath),
  });
}

function assertWp06FailureNamespace(body, resultCombined) {
  assert.ok(body, resultCombined);
  assert.equal(body.ok, false, resultCombined);
  assert.notEqual(body.failureReason, FailureReason.WP05_VERIFY_DONE_UNAVAILABLE);
  assert.notEqual(body.failureReason, FailureReason.WP04_VERIFY_DONE_UNAVAILABLE);
  assert.notEqual(body.failureReason, FailureReason.WP03_VERIFY_DONE_UNAVAILABLE);
  assert.doesNotMatch(String(body.failureReason || ''), MISTAG_RE);
  assert.match(String(body.failureReason || ''), /^WP06_/, body.failureReason);
}

// ---------------------------------------------------------------------------
// Environment / dynamic facts (may PASS in RED)
// ---------------------------------------------------------------------------

test('WP-06 VERIFY-DONE RED-0: worktree identity and live base from ls-remote', () => {
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

test('WP-06 VERIFY-DONE RED-0.1: prerequisites WP-INFRA/00/01/02/03/04/05 DONE', () => {
  const prereq = readPrerequisiteDone();
  assert.equal(prereq.ok, true, JSON.stringify(prereq));
  assert.equal(prereq.WP_INFRA.EffectiveDone, true);
  assert.equal(prereq.WP_INFRA.EffectiveGate, true);
  assert.equal(prereq['WP-00'].EffectiveDone, true);
  assert.equal(prereq['WP-01'].EffectiveDone, true);
  assert.equal(prereq['WP-02'].EffectiveDone, true);
  assert.equal(prereq['WP-03'].EffectiveDone, true);
  assert.equal(prereq['WP-04'].EffectiveDone, true);
  assert.equal(prereq['WP-05'].EffectiveDone, true);
  assert.equal(prereq['WP-05'].state, 'DONE');
  assert.equal(pathExists(finalInfraReceipt), true);
  assert.equal(pathExists(wp00MergeReceipt), true);
  assert.equal(pathExists(wp01TxnReceipt), true);
  assert.equal(pathExists(wp02TxnReceipt), true);
  assert.equal(pathExists(wp03TxnReceipt), true);
  assert.equal(pathExists(wp04TxnReceipt), true);
  assert.equal(pathExists(wp05TxnReceipt), true);
});

test('WP-06 VERIFY-DONE RED-0.2: catalog WP-06 unique weight=6 evidence E1', () => {
  const loaded = loadWp06CatalogTask();
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  assert.equal(loaded.task.weight, EXPECTED_WEIGHT);
  assert.equal(loaded.task.evidenceLevel, 'E1');
  for (const dep of [
    'WP-INFRA',
    'WP-00',
    'WP-01',
    'WP-02',
    'WP-03',
    'WP-04',
    'WP-05',
  ]) {
    assert.ok(
      loaded.task.requiredEffectiveDone.includes(dep),
      `missing requiredEffectiveDone ${dep}`,
    );
  }
  assert.equal(
    (loaded.catalog.tasks || []).filter((t) => t && t.taskId === TASK_ID).length,
    1,
  );
  const surfaces = assertWp06ProductionSurfacesPresent();
  assert.equal(surfaces.ok, true, JSON.stringify(surfaces));
  assert.equal(pathExists(contractPath), true);
});

test('WP-06 VERIFY-DONE RED-0.3: PR #16 identity + ancestry (dynamic gh API)', () => {
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
  assert.equal(typeof id.mergeEqualsLiveTip, 'boolean');
  if (id.headRepo) {
    assert.equal(id.headRepo, 'anpplex/Mineradio-AndroidAuto');
  }
});

// ---------------------------------------------------------------------------
// RED: production path missing — stable WP06_VERIFY_DONE_UNAVAILABLE
// ---------------------------------------------------------------------------

test('WP-06 VERIFY-DONE RED-1: production evaluate_wp06_verify_done path status', () => {
  const src = fs.readFileSync(runnerPath, 'utf8');
  if (productionHasWp06VerifyDonePath()) {
    assert.match(src, /evaluate_wp06_verify_done/, FailureReason.WP06_VERIFY_DONE_UNAVAILABLE);
    assert.match(src, /WP06_VERIFY_DONE_UNAVAILABLE/);
    assert.match(src, /WP06_VERIFY_DONE_PROOF_MISSING/);
    assert.match(src, /WP06_VERIFY_DONE_CALLER_FORGERY/);
  } else {
    assert.equal(
      productionHasWp06VerifyDonePath(),
      false,
      'RED expects evaluate_wp06_verify_done absent until GREEN',
    );
    assert.doesNotMatch(src, /evaluate_wp06_verify_done/);
  }
  assert.doesNotMatch(
    src,
    /elif task_id == ["']WP-06["'][\s\S]{0,200}WP05_VERIFY_DONE_UNAVAILABLE/,
  );
  assert.doesNotMatch(
    src,
    /elif task_id == ["']WP-06["'][\s\S]{0,200}WP04_VERIFY_DONE_UNAVAILABLE/,
  );
});

test('WP-06 VERIFY-DONE RED-1.0: WP-06 failures use WP06_* never WP05/WP04/WP03 mis-tag', () => {
  const { receipt, init } = initTempReceipt();
  assert.equal(init.status, 0, init.combined);
  const result = runVerifyDone(receipt, null);
  const body = parseRunnerJson(result);
  assertWp06FailureNamespace(body, result.combined);
  if (productionHasWp06VerifyDonePath()) {
    assert.equal(
      body.failureReason,
      FailureReason.WP06_VERIFY_DONE_PROOF_MISSING,
      body.failureReason,
    );
  } else {
    assert.equal(
      body.failureReason,
      FailureReason.WP06_VERIFY_DONE_UNAVAILABLE,
      body.failureReason,
    );
  }
  assert.equal(readJson(receipt).EffectiveDone, false);
});

test('WP-06 VERIFY-DONE RED-1.1: bare verify-done fails closed without proofs', () => {
  const { receipt, init } = initTempReceipt();
  assert.equal(init.status, 0, init.combined);
  const result = runVerifyDone(receipt, null);
  const body = parseRunnerJson(result);
  assertWp06FailureNamespace(body, result.combined);
  if (!productionHasWp06VerifyDonePath()) {
    assert.equal(
      body.failureReason,
      FailureReason.WP06_VERIFY_DONE_UNAVAILABLE,
      body.failureReason,
    );
  }
  assert.equal(readJson(receipt).EffectiveDone, false);
  assert.notEqual(readJson(receipt).state, 'DONE');
});

test('WP-06 VERIFY-DONE RED-1.2: GREEN success target fails until path exists', () => {
  const { receipt, init } = initTempReceipt();
  assert.equal(init.status, 0, init.combined);
  const result = runVerifyDone(receipt, validProofs(IMPLEMENTATION_PR));
  const body = parseRunnerJson(result);
  if (!productionHasWp06VerifyDonePath()) {
    assert.equal(body && body.ok, false, result.combined);
    assert.equal(
      body.failureReason,
      FailureReason.WP06_VERIFY_DONE_UNAVAILABLE,
      `${FailureReason.WP06_VERIFY_DONE_UNAVAILABLE}: ${result.combined}`,
    );
    assert.equal(readJson(receipt).EffectiveDone, false);
    return;
  }
  assert.equal(body && body.ok, true, result.combined);
  assert.equal(body.EffectiveDone, true);
  assert.equal(body.taskId, TASK_ID);
  assert.equal(body.coreProgressWeight, EXPECTED_WEIGHT);
  const data = readJson(receipt);
  assert.equal(data.EffectiveDone, true);
  assert.equal(data.state, 'DONE');
  assert.equal(data.verifyDone.weight, EXPECTED_WEIGHT);
  assert.equal(data.verifyDone.liveBaseSha, liveAuthoritativeBaseSha());
});

test('WP-06 VERIFY-DONE RED-1.3: operational wp-06 txn tracks live verify-done', () => {
  assert.equal(pathExists(wp06TxnReceipt), true);
  const before = readJson(wp06TxnReceipt);
  assert.equal(before.taskId, TASK_ID);
  const live = liveWp06OperationalProgress();
  if (live.EffectiveDone) {
    assert.equal(before.EffectiveDone, true);
    assert.equal(before.state, 'DONE');
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

test('WP-06 VERIFY-DONE RED-2.1: rejects caller-forged EffectiveDone / progress', () => {
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
    JSON.stringify({ EffectiveDone: true, coreProgressPercent: 50 }),
  ]);
  assert.notEqual(cas.status, 0);
  assert.match(
    cas.combined,
    /ONLY_VERIFY_DONE_MAY_ENABLE_EFFECTIVE_DONE|CALLER|EffectiveDone/i,
  );
  assert.equal(readJson(receipt).EffectiveDone, false);
});

test('WP-06 VERIFY-DONE RED-2.2: rejects caller-forged merged / REMOTE_VERIFIED / digests', () => {
  const { receipt, init } = initTempReceipt();
  assert.equal(init.status, 0);
  const forged = identityProofs(IMPLEMENTATION_PR, {
    merged: true,
    REMOTE_VERIFIED: true,
    EffectiveDone: true,
    mergeSha: 'a'.repeat(40),
    coreProgressPercent: 50,
    catalogSha: '0'.repeat(64),
    schemaSha: '1'.repeat(64),
    suiteDigests: { forged: true },
  });
  const result = runVerifyDone(receipt, forged);
  const body = parseRunnerJson(result);
  assertWp06FailureNamespace(body, result.combined);
  assert.match(result.combined, /FORGERY|PROOF|UNAVAILABLE|CALLER|WP06_/i);
  if (productionHasWp06VerifyDonePath()) {
    assert.equal(
      body.failureReason,
      FailureReason.WP06_VERIFY_DONE_CALLER_FORGERY,
      body.failureReason,
    );
  } else {
    assert.equal(
      body.failureReason,
      FailureReason.WP06_VERIFY_DONE_UNAVAILABLE,
      body.failureReason,
    );
  }
  assert.equal(readJson(receipt).EffectiveDone, false);
});

test('WP-06 VERIFY-DONE RED-2.3: missing / empty proofs fail-closed', () => {
  const { receipt, init } = initTempReceipt();
  assert.equal(init.status, 0);
  for (const proofs of [null, {}]) {
    const result = runVerifyDone(receipt, proofs);
    const body = parseRunnerJson(result);
    assertWp06FailureNamespace(body, result.combined);
    if (!productionHasWp06VerifyDonePath()) {
      assert.equal(
        body.failureReason,
        FailureReason.WP06_VERIFY_DONE_UNAVAILABLE,
        body.failureReason,
      );
    }
  }
  assert.equal(readJson(receipt).EffectiveDone, false);
});

test('WP-06 VERIFY-DONE RED-2.4: unmerged / nonexistent PR fails (when path exists)', () => {
  const { receipt, init } = initTempReceipt();
  assert.equal(init.status, 0);
  const result = runVerifyDone(receipt, validProofs(999999999));
  const body = parseRunnerJson(result);
  assertWp06FailureNamespace(body, result.combined);
  if (productionHasWp06VerifyDonePath()) {
    assert.match(result.combined, /PR_PROOF|NOT_MERGED|PROOF|Could not resolve|WP06_/i);
  } else {
    assert.equal(body.failureReason, FailureReason.WP06_VERIFY_DONE_UNAVAILABLE);
  }
  assert.equal(readJson(receipt).EffectiveDone, false);
});

test('WP-06 VERIFY-DONE RED-2.5: catalog SHA mismatch fails (when path exists)', () => {
  const { receipt, init } = initTempReceipt();
  assert.equal(init.status, 0);
  const proofs = identityProofs(IMPLEMENTATION_PR, {
    catalogSha256: '0'.repeat(64),
    schemaSha256: sha256File(schemaPath),
  });
  const result = runVerifyDone(receipt, proofs);
  const body = parseRunnerJson(result);
  assertWp06FailureNamespace(body, result.combined);
  if (productionHasWp06VerifyDonePath()) {
    assert.match(result.combined, /CATALOG|PROOF|WP06_/i);
  } else {
    assert.equal(body.failureReason, FailureReason.WP06_VERIFY_DONE_UNAVAILABLE);
  }
});

test('WP-06 VERIFY-DONE RED-2.6: suite digest pass:false fails (when path exists)', () => {
  const { receipt, init } = initTempReceipt();
  assert.equal(init.status, 0);
  const proofs = identityProofs(IMPLEMENTATION_PR, {
    catalogSha256: sha256File(catalogPath),
    schemaSha256: sha256File(schemaPath),
    androidUnitTest: { pass: false, sha256: 'a'.repeat(64) },
  });
  const result = runVerifyDone(receipt, proofs);
  const body = parseRunnerJson(result);
  assertWp06FailureNamespace(body, result.combined);
  if (productionHasWp06VerifyDonePath()) {
    assert.match(result.combined, /SUITE|PROOF|WP06_/i);
  } else {
    assert.equal(body.failureReason, FailureReason.WP06_VERIFY_DONE_UNAVAILABLE);
  }
});

// ---------------------------------------------------------------------------
// Progress pins
// ---------------------------------------------------------------------------

test('WP-06 VERIFY-DONE RED-3.1: Core progress tracks live WP-06 EffectiveDone (44% pre / 50% post)', () => {
  const live = liveWp06OperationalProgress();
  assert.equal(live.EffectiveDone, false);
  assert.equal(live.expectedCoreProgressPercent, EXPECTED_PROGRESS_PRE_DONE);
  const prog = parseRunnerJson(computeCoreProgress(defaultDoneReceipts()));
  assert.equal(prog.coreProgressPercent, EXPECTED_PROGRESS_PRE_DONE);
});

test('WP-06 VERIFY-DONE RED-3.2: GREEN success target is progress 50% from catalog weights', () => {
  // Temp success path only when evaluate exists; still pin weight math via receipts through WP-05.
  const pre = parseRunnerJson(computeCoreProgress(defaultDoneReceiptsThroughWp05()));
  assert.equal(pre.coreProgressPercent, 44);
  if (!productionHasWp06VerifyDonePath()) {
    // Until GREEN, full target 50% only after real DONE — document expected.
    assert.equal(EXPECTED_PROGRESS_WHEN_DONE, 50);
    return;
  }
  // When path exists, GREEN success on temp receipt would yield weight 6 (tested in 1.2).
});

test('WP-06 VERIFY-DONE RED-3.3: runner source must not require mergeSha == live tip', () => {
  const src = fs.readFileSync(runnerPath, 'utf8');
  // Shared helpers use ancestry-only language; WP-06 GREEN must preserve.
  assert.doesNotMatch(
    src,
    /merge_sha\s*==\s*live_base|mergeSha\s*===\s*liveBase|require.*merge.*equal.*tip/i,
  );
});

test('WP-06 VERIFY-DONE RED-3.4: WP-07 not started; WP-06 not elevated without verify-done', () => {
  assert.equal(pathExists(wp06TxnReceipt), true);
  assert.equal(readJson(wp06TxnReceipt).EffectiveDone, false);
  const wp07 = require('node:path').join(
    '/Users/anpple/Codex/Mineradio',
    'android-car',
    'verification',
    'wallpaper-plugin',
    'transactions',
    'wp-07.json',
  );
  assert.equal(pathExists(wp07), false);
});
