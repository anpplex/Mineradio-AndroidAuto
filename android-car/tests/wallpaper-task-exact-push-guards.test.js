'use strict';

/**
 * WP-INFRA / RED-07 — exact-push allowlists + HEAD binding + no caller-only
 * REMOTE_VERIFIED.
 *
 * Production wallpaper-task.py only. Temp receipts only. No real git push,
 * no GitHub API, no origin network mutation.
 *
 * These tests encode VERIFY-06 BLOCKED gaps. Under HEAD 1dfcc1d they must
 * FAIL (production does not yet enforce the guards). GREEN-07 will make them pass.
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
  seedUnverifiedBootstrapReceipt,
  localHeadSha,
  localBranchName,
  assertProductionFailed,
  assertEffectiveGate,
  ExactSyncFailureReason,
  APPROVED_INFRA_BRANCH,
  APPROVED_INFRA_REF,
  APPROVED_PUSH_REMOTE,
  FORBIDDEN_PUSH_REMOTES,
  FORBIDDEN_PUSH_REFS,
  RED07,
  CANONICAL_BOOTSTRAP_RECEIPT,
  repoRoot,
} = require('./wallpaper-task-exact-sync-helpers');

const FAKE_SHA = 'ffffffffffffffffffffffffffffffffffffffff';
const SHORT_SHA = 'deadbeef';
const NOT_SHA = 'not-a-git-sha';

function sandboxReceipt() {
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  seedPreExactSyncReceipt(file);
  return file;
}

function assertGuardFailed(result, label, reasonPattern) {
  assertProductionFailed(
    result,
    label,
    'GREEN-07 must fail-closed this exact-push / origin guard',
  );
  assert.match(
    result.combined,
    reasonPattern,
    `${label}: failureReason/message must identify the guard\n${result.combined}`,
  );
}

// ---------------------------------------------------------------------------
// Framework
// ---------------------------------------------------------------------------

test('WP-INFRA RED-07: production runner invokable (framework path)', () => {
  ensureRunnerPresent();
  const result = runExact(['bootstrap-exact-push', '--help-or-probe']);
  assert.equal(typeof result.status, 'number');
});

test('RED-07.0 temp isolation only (never touch live bootstrap receipt)', () => {
  const file = sandboxReceipt();
  assert.equal(fs.existsSync(file), true);
  assert.notEqual(path.resolve(file), path.resolve(CANONICAL_BOOTSTRAP_RECEIPT));
  assert.equal(localBranchName(), APPROVED_INFRA_BRANCH);
  assert.match(localHeadSha(), /^[0-9a-f]{40}$/);
});

// ---------------------------------------------------------------------------
// 1. Remote allowlist — only origin
// ---------------------------------------------------------------------------

test('RED-07.1 exact-push dry-run must reject remote=upstream', () => {
  const file = sandboxReceipt();
  const head = localHeadSha();
  const result = runExact([
    'bootstrap-exact-push',
    '--receipt',
    file,
    '--ref',
    APPROVED_INFRA_REF,
    '--expected-sha',
    head,
    '--remote',
    'upstream',
    '--dry-run',
  ]);
  assertGuardFailed(result, 'RED-07.1 upstream', RED07.remoteReject);
});

test('RED-07.2 exact-push dry-run must reject non-origin remotes', () => {
  const file = sandboxReceipt();
  const head = localHeadSha();
  for (const remote of FORBIDDEN_PUSH_REMOTES) {
    if (remote === '') {
      // empty remote: pass flag with empty string if argparse accepts it
      const result = runExact([
        'bootstrap-exact-push',
        '--receipt',
        file,
        '--ref',
        APPROVED_INFRA_REF,
        '--expected-sha',
        head,
        '--remote',
        '',
        '--dry-run',
      ]);
      // Empty may be treated as missing → still must not silently accept a
      // non-origin push plan. GREEN must refuse empty remote when flag present.
      if (result.status === 0) {
        // If argparse drops empty, production may ignore --remote; still require
        // explicit origin-only policy once remote is evaluated. Force fail.
        assert.fail(
          `RED-07.2 empty remote: dry-run must not succeed without origin allowlist\n${result.combined}`,
        );
      } else {
        assert.match(result.combined, RED07.remoteReject);
      }
      continue;
    }
    const result = runExact([
      'bootstrap-exact-push',
      '--receipt',
      file,
      '--ref',
      APPROVED_INFRA_REF,
      '--expected-sha',
      head,
      '--remote',
      remote,
      '--dry-run',
    ]);
    assertGuardFailed(result, `RED-07.2 remote=${remote}`, RED07.remoteReject);
  }
});

test('RED-07.3 origin-ls-remote must reject remote=upstream', () => {
  const file = sandboxReceipt();
  const result = runExact([
    'bootstrap-origin-ls-remote',
    '--receipt',
    file,
    '--ref',
    APPROVED_INFRA_REF,
    '--remote',
    'upstream',
    '--dry-run',
  ]);
  // Even dry-run planning must not accept upstream as the readback remote.
  assertGuardFailed(result, 'RED-07.3 ls-remote upstream', RED07.remoteReject);
});

// ---------------------------------------------------------------------------
// 2. Branch / ref allowlist — only codex/wallpaper-plugin-infra
// ---------------------------------------------------------------------------

test('RED-07.4 exact-push dry-run must reject main/master/huawei and plan branch', () => {
  const file = sandboxReceipt();
  const head = localHeadSha();
  for (const ref of FORBIDDEN_PUSH_REFS) {
    const result = runExact([
      'bootstrap-exact-push',
      '--receipt',
      file,
      '--ref',
      ref,
      '--expected-sha',
      head,
      '--remote',
      APPROVED_PUSH_REMOTE,
      '--dry-run',
    ]);
    assertGuardFailed(result, `RED-07.4 ref=${ref}`, RED07.branchReject);
  }
});

test('RED-07.5 exact-push dry-run must reject unapproved codex branch', () => {
  const file = sandboxReceipt();
  const head = localHeadSha();
  const result = runExact([
    'bootstrap-exact-push',
    '--receipt',
    file,
    '--ref',
    'refs/heads/codex/wallpaper-plugin-control',
    '--expected-sha',
    head,
    '--remote',
    APPROVED_PUSH_REMOTE,
    '--dry-run',
  ]);
  assertGuardFailed(result, 'RED-07.5 control branch', RED07.branchReject);
});

// ---------------------------------------------------------------------------
// 3. HEAD binding — expectedSha is assertion on real local HEAD only
// ---------------------------------------------------------------------------

test('RED-07.6 exact-push dry-run must reject expectedSha != local HEAD', () => {
  const file = sandboxReceipt();
  const head = localHeadSha();
  assert.notEqual(FAKE_SHA, head);
  const result = runExact([
    'bootstrap-exact-push',
    '--receipt',
    file,
    '--ref',
    APPROVED_INFRA_REF,
    '--expected-sha',
    FAKE_SHA,
    '--remote',
    APPROVED_PUSH_REMOTE,
    '--dry-run',
  ]);
  assertGuardFailed(result, 'RED-07.6 HEAD mismatch', RED07.headMismatch);
});

test('RED-07.7 exact-push dry-run must reject non-40-char expectedSha', () => {
  const file = sandboxReceipt();
  for (const bad of [SHORT_SHA, NOT_SHA, 'abc', '1'.repeat(39), '1'.repeat(41)]) {
    const result = runExact([
      'bootstrap-exact-push',
      '--receipt',
      file,
      '--ref',
      APPROVED_INFRA_REF,
      '--expected-sha',
      bad,
      '--remote',
      APPROVED_PUSH_REMOTE,
      '--dry-run',
    ]);
    assertGuardFailed(result, `RED-07.7 sha=${bad}`, RED07.shaFormat);
  }
});

test('RED-07.8 exact-push must not treat expectedSha as override of local HEAD', () => {
  const file = sandboxReceipt();
  // Caller invents a "target" that is not HEAD — must fail, not plan push of fake SHA.
  const result = runExact([
    'bootstrap-exact-push',
    '--receipt',
    file,
    '--ref',
    APPROVED_INFRA_REF,
    '--expected-sha',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    '--remote',
    APPROVED_PUSH_REMOTE,
    '--dry-run',
  ]);
  assertGuardFailed(result, 'RED-07.8 no override', RED07.headMismatch);
  // Receipt must not record forged INFRA_SHA from the attempt.
  const data = readJson(file);
  assert.notEqual(data.INFRA_SHA, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
});

test('RED-07.9 exact-push dry-run must reject target ref when current branch mismatches', () => {
  // Current branch is approved infra; request a different approved-looking ref
  // that is not the current branch name binding.
  // When HEAD is on codex/wallpaper-plugin-infra, requesting another branch fails
  // via branch allowlist. This test freezes branch-name == target-ref binding.
  const file = sandboxReceipt();
  const head = localHeadSha();
  assert.equal(localBranchName(), APPROVED_INFRA_BRANCH);
  const result = runExact([
    'bootstrap-exact-push',
    '--receipt',
    file,
    '--ref',
    'refs/heads/codex/wallpaper-plugin-development-plan',
    '--expected-sha',
    head,
    '--remote',
    APPROVED_PUSH_REMOTE,
    '--dry-run',
  ]);
  assertGuardFailed(result, 'RED-07.9 branch/ref binding', RED07.branchReject);
});

// ---------------------------------------------------------------------------
// 4. No caller-only REMOTE_VERIFIED
// ---------------------------------------------------------------------------

test('RED-07.10 origin-readback must not promote REMOTE_VERIFIED from caller-only SHAs', () => {
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  const head = seedUnverifiedBootstrapReceipt(file);
  assert.equal(readJson(file).state, 'INIT');
  assert.equal(readJson(file).originReadback, null);

  // Caller supplies matching expected/observed without any ls-remote.
  const result = runExact([
    'bootstrap-origin-readback',
    '--receipt',
    file,
    '--ref',
    APPROVED_INFRA_REF,
    '--expected-sha',
    head,
    '--observed-sha',
    head,
  ]);
  assertGuardFailed(result, 'RED-07.10 caller-only origin-readback', RED07.callerOnlyRemote);

  const data = readJson(file);
  assert.notEqual(
    data.state,
    'INFRA_REMOTE_VERIFIED',
    'caller-only pair must not write INFRA_REMOTE_VERIFIED',
  );
  // originReadback must remain absent or not claim observed-from-ls-remote
  if (data.originReadback != null) {
    assert.notEqual(
      data.originReadback.source,
      undefined,
      'if originReadback written, source must be present for audit',
    );
    assert.notEqual(data.originReadback.source, 'caller');
    assert.match(
      String(data.originReadback.source || ''),
      /ls-remote|git-ls-remote/i,
    );
  }
});

test('RED-07.11 bootstrap-readback must not promote REMOTE_VERIFIED from caller remote-sha', () => {
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  const head = seedUnverifiedBootstrapReceipt(file);

  const result = runExact([
    'bootstrap-readback',
    '--receipt',
    file,
    '--ref',
    APPROVED_INFRA_REF,
    '--infra-sha',
    head,
    '--remote-sha',
    head,
  ]);
  assertGuardFailed(result, 'RED-07.11 caller bootstrap-readback', RED07.callerOnlyRemote);

  const data = readJson(file);
  assert.notEqual(data.state, 'INFRA_REMOTE_VERIFIED');
});

test('RED-07.12 seal-exact-sync must reject fake remote readback without durable ls-remote', () => {
  const file = sandboxReceipt();
  const head = localHeadSha();
  // No lastOriginLsRemote on receipt; caller forges both sides.
  const result = runExact([
    'bootstrap-seal-exact-sync',
    '--receipt',
    file,
    '--ref',
    APPROVED_INFRA_REF,
    '--expected-sha',
    head,
    '--observed-sha',
    head,
  ]);
  assertGuardFailed(result, 'RED-07.12 fake seal', RED07.callerOnlyRemote);
  assert.equal(readJson(file).exactSync, null);
});

test('RED-07.13 CLI success alone must not write REMOTE_VERIFIED (local-only transaction)', () => {
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  seedUnverifiedBootstrapReceipt(file);

  // Local-only dry-run "success" path — must not promote state.
  const dry = runExact([
    'bootstrap-exact-push',
    '--receipt',
    file,
    '--ref',
    APPROVED_INFRA_REF,
    '--expected-sha',
    localHeadSha(),
    '--remote',
    APPROVED_PUSH_REMOTE,
    '--dry-run',
  ]);
  // Dry-run may still fail on HEAD/allowlist until GREEN; either way state stays INIT.
  const afterDry = readJson(file);
  assert.equal(afterDry.state, 'INIT');
  assert.equal(afterDry.EffectiveGate, false);

  // Fake "CLI success" injection into receipt must not satisfy gate.
  writeJson(file, {
    ...afterDry,
    state: 'INFRA_REMOTE_VERIFIED',
    originReadback: {
      ref: APPROVED_INFRA_REF,
      expectedSha: localHeadSha(),
      observedSha: localHeadSha(),
      source: 'caller-forged-cli-success',
    },
  });
  const gate = assertEffectiveGate(file, true);
  assertProductionFailed(
    gate,
    'RED-07.13 forged CLI success gate',
    'local-only / caller-forged origin must not unlock EffectiveGate',
  );
  assert.equal(readJson(file).EffectiveGate, false);
  // Silence unused if dry failed
  assert.equal(typeof dry.status, 'number');
});

test('RED-07.14 origin-readback mismatch must stay ORIGIN_SHA_MISMATCH (no REMOTE_VERIFIED)', () => {
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  const head = seedUnverifiedBootstrapReceipt(file);
  const result = runExact([
    'bootstrap-origin-readback',
    '--receipt',
    file,
    '--ref',
    APPROVED_INFRA_REF,
    '--expected-sha',
    head,
    '--observed-sha',
    FAKE_SHA,
  ]);
  assertProductionFailed(result, 'RED-07.14 mismatch', 'must fail-closed');
  assert.match(result.combined, RED07.originMismatch);
  assert.notEqual(readJson(file).state, 'INFRA_REMOTE_VERIFIED');
});

test('RED-07.15 REMOTE_VERIFIED requires actual ls-remote before seal (missing lastOriginLsRemote)', () => {
  const file = sandboxReceipt();
  // Receipt may already claim originReadback from seed, but exactSync seal
  // still requires durable ls-remote evidence — not seed fiction.
  const result = runExact([
    'bootstrap-seal-exact-sync',
    '--receipt',
    file,
    '--ref',
    APPROVED_INFRA_REF,
    '--expected-sha',
    localHeadSha(),
    '--from-ls-remote',
  ]);
  assertProductionFailed(result, 'RED-07.15 missing ls-remote', 'no durable ls-remote');
  assert.match(
    result.combined,
    /LS_REMOTE_REQUIRED|lastOriginLsRemote|ls-remote/i,
  );
  assert.equal(readJson(file).exactSync, null);
});

// ---------------------------------------------------------------------------
// 5. EffectiveGate / no DONE from local-only guard attempts
// ---------------------------------------------------------------------------

test('RED-07.16 EffectiveGate stays false after guard-probe sequence (local-only)', () => {
  const file = sandboxReceipt();
  const head = localHeadSha();
  runExact([
    'bootstrap-exact-push',
    '--receipt',
    file,
    '--ref',
    'refs/heads/main',
    '--expected-sha',
    head,
    '--remote',
    'upstream',
    '--dry-run',
  ]);
  runExact([
    'bootstrap-origin-readback',
    '--receipt',
    file,
    '--ref',
    APPROVED_INFRA_REF,
    '--expected-sha',
    head,
    '--observed-sha',
    head,
  ]);
  const data = readJson(file);
  assert.equal(data.EffectiveGate, false);
  assert.equal(data.EffectiveDone, false);
  assert.notEqual(data.state, 'DONE');
  const gate = assertEffectiveGate(file, true);
  assertProductionFailed(gate, 'RED-07.16 gate', 'must stay false');
});

test('RED-07.17 worktree is Mineradio repo root for HEAD binding (cwd sanity)', () => {
  assert.equal(path.basename(repoRoot) === 'Mineradio' || fs.existsSync(path.join(repoRoot, 'android-car')), true);
  assert.equal(localBranchName(), APPROVED_INFRA_BRANCH);
  // Frozen commit at RED-07 time may advance only via future authorized commits;
  // HEAD must still be a real 40-char object on the approved branch.
  assert.match(localHeadSha(), /^[0-9a-f]{40}$/);
});
