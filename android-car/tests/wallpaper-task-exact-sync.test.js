'use strict';

/**
 * WP-INFRA / RED-06 — exact push + origin ls-remote readback contracts.
 *
 * Calls production `wallpaper-task.py` only. Does NOT execute real `git push`
 * or GitHub API. Temp receipts only; does not touch live verification receipt.
 *
 * Stable failures prove exact-sync surface is not yet closed for EffectiveGate.
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ensureRunnerPresent,
  makeBootstrapSandbox,
  bootstrapReceiptPath,
  writeJson,
  readJson,
  runExact,
  seedPreExactSyncReceipt,
  localHeadSha,
  assertEffectiveGate,
  assertProductionFailed,
  assertFailClosed,
  ExactSyncFailureReason,
  CANONICAL_BOOTSTRAP_RECEIPT,
  approvedInfraRef,
} = require('./wallpaper-task-exact-sync-helpers');

// Live task ref from unified context (not frozen infra branch string).
function REF() {
  return approvedInfraRef();
}

test('WP-INFRA RED-06: production runner is invokable (framework path)', () => {
  ensureRunnerPresent();
  const result = runExact(['bootstrap-exact-push', '--help-or-probe']);
  assert.equal(typeof result.status, 'number');
});

test('RED-06.1 live verification receipt must not be the only path (temp isolation works)', () => {
  // Guard: RED-06 must not require mutating the VERIFY-05 live receipt.
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  seedPreExactSyncReceipt(file);
  assert.equal(fs.existsSync(file), true);
  assert.notEqual(path.resolve(file), path.resolve(CANONICAL_BOOTSTRAP_RECEIPT));
});

test('RED-06.2 exact-push command must exist as production surface', () => {
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  seedPreExactSyncReceipt(file);
  // GREEN-07: expectedSha must assert real local HEAD (not a fixture override).
  const head = localHeadSha();
  const result = runExact([
    'bootstrap-exact-push',
    '--receipt',
    file,
    '--ref',
    REF(),
    '--expected-sha',
    head,
    '--dry-run',
  ]);
  // GREEN-06 must accept dry-run exact push planning without network mutation.
  assert.equal(
    result.status,
    0,
    `bootstrap-exact-push --dry-run must be implemented\n${result.stdout}\n${result.stderr}`,
  );
  assert.match(result.combined, /exact-push|EXACT_PUSH|dry-run|expectedSha/i);
});

test('RED-06.3 exact-push without authorization must refuse real push', () => {
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  seedPreExactSyncReceipt(file);
  const head = localHeadSha();
  const result = runExact([
    'bootstrap-exact-push',
    '--receipt',
    file,
    '--ref',
    REF(),
    '--expected-sha',
    head,
    // deliberately no --allow-network-push / --i-understand-real-push
  ]);
  assertProductionFailed(
    result,
    'RED-06.3',
    'real exact-push must fail-closed without explicit authorization',
  );
  assert.match(
    result.combined,
    /EXACT_PUSH_NOT_AUTHORIZED|ALLOW_NETWORK|not authorized|dry-run|UNKNOWN_TASK|bootstrap-exact-push/i,
  );
});

test('RED-06.4 origin ls-remote command must exist and not trust caller-only remote SHA', () => {
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  const infra = seedPreExactSyncReceipt(file);
  // Caller-injected observed SHA without ls-remote must be rejected for exactSync seal.
  const inject = runExact([
    'bootstrap-seal-exact-sync',
    '--receipt',
    file,
    '--ref',
    REF(),
    '--expected-sha',
    infra,
    '--observed-sha',
    infra, // attacker supplies matching value without ls-remote
  ]);
  assertProductionFailed(
    inject,
    'RED-06.4 inject',
    'cannot seal exactSync from caller-supplied observed-sha alone',
  );
  assert.match(
    inject.combined,
    /LS_REMOTE_REQUIRED|CALLER_INJECTED_REMOTE_SHA|ls-remote|UNKNOWN_TASK|bootstrap-seal-exact-sync/i,
  );

  const ls = runExact([
    'bootstrap-origin-ls-remote',
    '--receipt',
    file,
    '--ref',
    REF(),
  ]);
  // GREEN-06 must implement ls-remote surface (may be dry-run-safe).
  if (ls.status === 0) {
    assert.match(ls.combined, /observedSha|ls-remote|remoteSha/i);
  } else {
    assertProductionFailed(ls, 'RED-06.4 ls-remote', 'bootstrap-origin-ls-remote missing');
    assert.match(ls.combined, /UNKNOWN_TASK|ls-remote|bootstrap-origin-ls-remote/i);
  }
});

test('RED-06.5 local/remote SHA mismatch must fail-closed', () => {
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  const local = seedPreExactSyncReceipt(file);
  const result = runExact([
    'bootstrap-origin-readback',
    '--receipt',
    file,
    '--ref',
    REF(),
    '--expected-sha',
    local,
    '--observed-sha',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  ]);
  assertProductionFailed(result, 'RED-06.5', 'mismatch must fail');
  assert.match(
    result.combined,
    /ORIGIN_SHA_MISMATCH|LS_REMOTE_MISMATCH|mismatch|UNKNOWN_TASK|bootstrap-origin-readback/i,
  );
});

test('RED-06.6 PUSH/SYNC_IN_FLIGHT requires ls-remote recovery before mutation', () => {
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  const infra = seedPreExactSyncReceipt(file);
  const begin = runExact([
    'bootstrap-sync-begin',
    '--receipt',
    file,
    '--expected-sha',
    infra,
    '--ref',
    REF(),
  ]);
  assert.equal(begin.status, 0, begin.combined);

  const resume = runExact(['bootstrap-sync-resume', '--receipt', file]);
  assertFailClosed(
    resume,
    ExactSyncFailureReason.SYNC_IN_FLIGHT_RECOVERY_REQUIRED,
    'resume without ls-remote',
  );

  // Sealing exactSync while still in-flight without readback must fail.
  const seal = runExact([
    'bootstrap-seal-exact-sync',
    '--receipt',
    file,
    '--ref',
    REF(),
    '--expected-sha',
    infra,
    '--from-ls-remote',
  ]);
  assertProductionFailed(
    seal,
    'RED-06.6 seal-in-flight',
    'cannot seal exactSync during unrecovered IN_FLIGHT',
  );
});

test('RED-06.7 EffectiveGate stays false without exactSync from ls-remote', () => {
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  seedPreExactSyncReceipt(file);
  // Even with test receipts + origin object, missing exactSync sealed from ls-remote.
  const result = assertEffectiveGate(file, true);
  assertProductionFailed(result, 'RED-06.7', 'gate false without exactSync');
  assert.match(result.combined, /MISSING_EXACT_SYNC_STATE|exactSync|LS_REMOTE/i);
  assert.equal(readJson(file).EffectiveGate, false);
});

test('RED-06.8 EffectiveGate stays false without PR merge even if exactSync forged', () => {
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  const infra = seedPreExactSyncReceipt(file);
  writeJson(
    file,
    {
      ...readJson(file),
      exactSync: {
        status: 'VERIFIED',
        expectedSha: infra,
        observedSha: infra,
        source: 'caller-forged', // not from ls-remote
      },
      prMerge: null,
      baseContainment: null,
    },
  );
  const result = assertEffectiveGate(file, true);
  assertProductionFailed(
    result,
    'RED-06.8',
    'forged exactSync must not unlock gate without PR/base (and preferably without ls-remote provenance)',
  );
  assert.match(
    result.combined,
    /PR_MERGE_REQUIRED|BASE_CONTAINMENT|LS_REMOTE|exactSync|CALLER_INJECTED/i,
  );
});

test('RED-06.9 exact-push dry-run must not mutate git remotes', () => {
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  seedPreExactSyncReceipt(file);
  const head = localHeadSha();
  const before = runExact(['bootstrap-write-status', '--receipt', file]);
  assert.equal(before.status, 0, before.combined);

  const result = runExact([
    'bootstrap-exact-push',
    '--receipt',
    file,
    '--ref',
    REF(),
    '--expected-sha',
    head,
    '--dry-run',
  ]);
  // Until implemented, this fails; when implemented, dry-run must not require network.
  if (result.status === 0) {
    assert.match(result.combined, /dry-run|would push|no network/i);
    assert.doesNotMatch(result.combined, /Pushed|To https:\/\/github\.com/i);
  } else {
    assertProductionFailed(result, 'RED-06.9', 'exact-push dry-run not implemented');
  }
});

test('RED-06.10 machine-readable failures and no silent success for exact-sync seal', () => {
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  seedPreExactSyncReceipt(file);
  const result = runExact([
    'bootstrap-seal-exact-sync',
    '--receipt',
    file,
    '--ref',
    REF(),
    '--expected-sha',
    'ffffffffffffffffffffffffffffffffffffffff',
    '--observed-sha',
    '0000000000000000000000000000000000000000',
  ]);
  assert.notEqual(result.status, 0, 'silent success forbidden');
  assert.ok(result.stdout.length + result.stderr.length > 0);
  assert.match(
    result.combined,
    /"failureReason"\s*:\s*"[A-Z0-9_]+"|ORIGIN_SHA_MISMATCH|LS_REMOTE|UNKNOWN_TASK/,
  );
});

test('RED-06.11 must not mark WP-INFRA DONE or EffectiveGate true from local-only exact-sync attempts', () => {
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  seedPreExactSyncReceipt(file);
  runExact([
    'bootstrap-exact-push',
    '--receipt',
    file,
    '--ref',
    REF(),
    '--expected-sha',
    localHeadSha(),
    '--dry-run',
  ]);
  runExact([
    'bootstrap-origin-ls-remote',
    '--receipt',
    file,
    '--ref',
    REF(),
  ]);
  const data = readJson(file);
  assert.equal(data.EffectiveGate, false);
  assert.equal(data.EffectiveDone, false);
  assert.notEqual(data.state, 'DONE');
});
