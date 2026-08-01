'use strict';

/**
 * Helpers for WP-INFRA exact push + origin ls-remote contracts (RED-06 / RED-07).
 * Uses production wallpaper-task.py only. Temp receipts only — does not
 * mutate the live verification/bootstrap/WP-INFRA.json from VERIFY-05.
 *
 * Approved push branch/ref resolve from unified task context (live git),
 * not a frozen codex/wallpaper-plugin-infra constant.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const base = require('./wallpaper-task-bootstrap-ledger-helpers');
const contextProvider = require(path.join(
  base.repoRoot,
  'android-car',
  'scripts',
  'wallpaper-task-context.js',
));

const APPROVED_PUSH_REMOTE = 'origin';

/**
 * Live approved push target = current wallpaper task branch (from git context).
 * Single entry for exact-push / exact-sync tests.
 */
function resolveApprovedPushTarget(cwd = base.repoRoot) {
  const ctx = contextProvider.resolveTaskContext({ cwd, taskId: 'WP-INFRA' });
  if (!ctx.ok) {
    throw new Error(
      `resolveTaskContext failed: ${ctx.failureReason || ''} ${ctx.message || ''}`,
    );
  }
  return {
    branch: ctx.taskBranch,
    ref: ctx.targetRef,
    headSha: ctx.headSha,
    remote: ctx.remote || contextProvider.APPROVED_REMOTE,
  };
}

function approvedInfraBranch(cwd = base.repoRoot) {
  return resolveApprovedPushTarget(cwd).branch;
}

function approvedInfraRef(cwd = base.repoRoot) {
  return resolveApprovedPushTarget(cwd).ref;
}

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

function seedPreExactSyncReceipt(file) {
  const infra = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const ref = approvedInfraRef();
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
        ref,
        expectedSha: infra,
        observedSha: infra,
      },
      state: 'INFRA_REMOTE_VERIFIED',
    }),
  );
  return infra;
}

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

const RED07 = Object.freeze({
  remoteReject: /REMOTE_NOT_ALLOWED|remote not allowed|unknown remote|not origin|ORIGIN_REMOTE|INVALID_REMOTE|upstream/i,
  branchReject: /BRANCH_NOT_ALLOWED|REF_NOT_ALLOWED|branch not allowed|ref not allowed|forbidden ref|not approved|APPROVED_INFRA/i,
  headMismatch: /LOCAL_HEAD_MISMATCH|EXPECTED_SHA_NOT_HEAD|HEAD_MISMATCH|local HEAD|expectedSha.*HEAD|HEAD.*expected/i,
  shaFormat: /INVALID_SHA|ORIGIN_SHA_MISMATCH|40-char|not a .*sha|sha format/i,
  callerOnlyRemote: /CALLER_INJECTED|CALLER_ONLY|LS_REMOTE_REQUIRED|FAKE_REMOTE|without.*ls-remote|independent.*ls-remote/i,
  originMismatch: /ORIGIN_SHA_MISMATCH|LS_REMOTE_MISMATCH/i,
});

const exportsObject = {
  ...base,
  ExactSyncFailureReason,
  APPROVED_PUSH_REMOTE,
  FORBIDDEN_PUSH_REMOTES,
  FORBIDDEN_PUSH_REFS,
  RED07,
  runExact,
  localHeadSha,
  localBranchName,
  seedPreExactSyncReceipt,
  seedUnverifiedBootstrapReceipt,
  resolveApprovedPushTarget,
  resolveTaskContext: contextProvider.resolveTaskContext,
  approvedInfraBranch,
  approvedInfraRef,
  getAuthoritativePushBranch: approvedInfraBranch,
  getAuthoritativePushRef: approvedInfraRef,
};

// Live getters for destructured APPROVED_INFRA_BRANCH / APPROVED_INFRA_REF
Object.defineProperty(exportsObject, 'APPROVED_INFRA_BRANCH', {
  enumerable: true,
  configurable: true,
  get: () => approvedInfraBranch(),
});
Object.defineProperty(exportsObject, 'APPROVED_INFRA_REF', {
  enumerable: true,
  configurable: true,
  get: () => approvedInfraRef(),
});

module.exports = exportsObject;
