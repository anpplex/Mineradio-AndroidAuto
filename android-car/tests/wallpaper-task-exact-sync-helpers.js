'use strict';

/**
 * Helpers for WP-INFRA exact push + origin ls-remote contracts (RED-06 / RED-07).
 * Uses production wallpaper-task.py only. Temp receipts only — does not
 * mutate the live verification/bootstrap/WP-INFRA.json from VERIFY-05.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const base = require('./wallpaper-task-bootstrap-ledger-helpers');

const APPROVED_INFRA_BRANCH = 'codex/wallpaper-plugin-infra';
const APPROVED_INFRA_REF = `refs/heads/${APPROVED_INFRA_BRANCH}`;
const APPROVED_PUSH_REMOTE = 'origin';

/** Forbidden push remotes (must never be accepted for WP-INFRA exact-push). */
const FORBIDDEN_PUSH_REMOTES = Object.freeze([
  'upstream',
  '',
  'origin-evil',
  'github',
  'not-a-remote',
]);

/** Forbidden branch / ref targets for WP-INFRA exact-push. */
const FORBIDDEN_PUSH_REFS = Object.freeze([
  'main',
  'master',
  'huawei-android12-car',
  'refs/heads/main',
  'refs/heads/master',
  'refs/heads/huawei-android12-car',
  'codex/wallpaper-plugin-development-plan',
  'refs/heads/codex/wallpaper-plugin-development-plan',
  'codex/wallpaper-plugin-control',
  'refs/heads/codex/other-feature',
]);

const ExactSyncFailureReason = Object.freeze({
  ...base.LedgerFailureReason,
  EXACT_PUSH_REQUIRED: 'EXACT_PUSH_REQUIRED',
  EXACT_PUSH_NOT_AUTHORIZED: 'EXACT_PUSH_NOT_AUTHORIZED',
  LS_REMOTE_REQUIRED: 'LS_REMOTE_REQUIRED',
  LS_REMOTE_MISMATCH: 'LS_REMOTE_MISMATCH',
  CALLER_INJECTED_REMOTE_SHA: 'CALLER_INJECTED_REMOTE_SHA',
  PUSH_IN_FLIGHT_RECOVERY_REQUIRED: 'PUSH_IN_FLIGHT_RECOVERY_REQUIRED',
  UNKNOWN_TASK: 'UNKNOWN_TASK',
  // RED-07 guard reasons (GREEN-07 must emit one of these or equivalent)
  REMOTE_NOT_ALLOWED: 'REMOTE_NOT_ALLOWED',
  BRANCH_NOT_ALLOWED: 'BRANCH_NOT_ALLOWED',
  REF_NOT_ALLOWED: 'REF_NOT_ALLOWED',
  LOCAL_HEAD_MISMATCH: 'LOCAL_HEAD_MISMATCH',
  EXPECTED_SHA_NOT_HEAD: 'EXPECTED_SHA_NOT_HEAD',
  INVALID_SHA_FORMAT: 'INVALID_SHA_FORMAT',
  CALLER_ONLY_REMOTE_VERIFIED: 'CALLER_ONLY_REMOTE_VERIFIED',
  FAKE_REMOTE_READBACK: 'FAKE_REMOTE_READBACK',
});

function runExact(args, options = {}) {
  return base.runRunner(args, options);
}

/**
 * Real local HEAD of the Mineradio worktree (40-char). Used only as an
 * assertion target for RED-07 HEAD-binding tests — never as a push input.
 */
function localHeadSha(cwd = base.repoRoot) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`git rev-parse HEAD failed: ${result.stderr || result.stdout}`);
  }
  const sha = String(result.stdout || '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`local HEAD is not a 40-char sha: ${JSON.stringify(sha)}`);
  }
  return sha;
}

function localBranchName(cwd = base.repoRoot) {
  const result = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`git rev-parse --abbrev-ref HEAD failed: ${result.stderr}`);
  }
  return String(result.stdout || '').trim();
}

/**
 * Populate a temp receipt to the post-ledger, pre-exact-push layer so RED-06
 * can isolate exact-sync gaps without going through full RED-04/05 setup.
 */
function seedPreExactSyncReceipt(file) {
  const infra = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  base.writeJson(
    file,
    base.red04CompleteReceipt({
      catalogTestReceipt: { pass: true, command: 'node --test catalog' },
      schemaTestReceipt: { pass: true, command: 'node --test schema' },
      exactSync: null,
      syncState: null,
      prMerge: null,
      baseContainment: null,
      INFRA_SHA: infra,
      originReadback: {
        ref: APPROVED_INFRA_REF,
        expectedSha: infra,
        observedSha: infra,
      },
      state: 'INFRA_REMOTE_VERIFIED',
    }),
  );
  return infra;
}

/**
 * Seed a receipt that has never been origin-verified (INIT), for RED-07
 * caller-only REMOTE_VERIFIED promotion tests.
 */
function seedUnverifiedBootstrapReceipt(file, overrides = {}) {
  const head = localHeadSha();
  base.writeJson(
    file,
    base.red04CompleteReceipt({
      state: 'INIT',
      INFRA_SHA: head,
      originReadback: null,
      exactSync: null,
      syncState: null,
      prMerge: null,
      baseContainment: null,
      catalogTestReceipt: { pass: true, command: 'node --test catalog' },
      schemaTestReceipt: { pass: true, command: 'node --test schema' },
      EffectiveDone: false,
      EffectiveGate: false,
      ...overrides,
    }),
  );
  return head;
}

/** Matchers for RED-07 fail-closed reasons (broad until GREEN freezes tokens). */
const RED07 = Object.freeze({
  remoteReject: /REMOTE_NOT_ALLOWED|remote not allowed|unknown remote|not origin|ORIGIN_REMOTE|INVALID_REMOTE|upstream/i,
  branchReject: /BRANCH_NOT_ALLOWED|REF_NOT_ALLOWED|branch not allowed|ref not allowed|forbidden ref|not approved|APPROVED_INFRA/i,
  headMismatch: /LOCAL_HEAD_MISMATCH|EXPECTED_SHA_NOT_HEAD|HEAD_MISMATCH|local HEAD|expectedSha.*HEAD|HEAD.*expected/i,
  shaFormat: /INVALID_SHA|ORIGIN_SHA_MISMATCH|40-char|not a .*sha|sha format/i,
  callerOnlyRemote: /CALLER_INJECTED|CALLER_ONLY|LS_REMOTE_REQUIRED|FAKE_REMOTE|without.*ls-remote|independent.*ls-remote/i,
  originMismatch: /ORIGIN_SHA_MISMATCH|LS_REMOTE_MISMATCH/i,
});

module.exports = {
  ...base,
  ExactSyncFailureReason,
  APPROVED_INFRA_BRANCH,
  APPROVED_INFRA_REF,
  APPROVED_PUSH_REMOTE,
  FORBIDDEN_PUSH_REMOTES,
  FORBIDDEN_PUSH_REFS,
  RED07,
  runExact,
  localHeadSha,
  localBranchName,
  seedPreExactSyncReceipt,
  seedUnverifiedBootstrapReceipt,
};
