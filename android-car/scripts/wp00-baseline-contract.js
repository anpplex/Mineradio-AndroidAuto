'use strict';

/**
 * WP-00 baseline contract surface (GREEN-01 / REFACTOR-01).
 *
 * Fail-closed checks for Mineradio worktree identity, authoritative base,
 * WallpaperEngine main read-only posture, Plugin sandbox isolation, unique
 * WP-00 transaction binding, and WP-INFRA final-receipt EffectiveGate.
 *
 * Facts come only from real git / filesystem / receipt paths. Caller claims
 * for base SHA, EffectiveDone, coreProgress, or WP-INFRA DONE are never
 * treated as sources of truth.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Historical tips kept only as forbidden pseudo-base markers (never sole facts).
const FORBIDDEN_INFRA_TIP =
  '57cbe4ac1481a6bd79f6c3eca4f6ae91d37bcd08';
/** @deprecated Never use as sole authoritative base — always resolve live origin. */
const DEFAULT_AUTHORITATIVE_BASE = null;
const DEFAULT_FORBIDDEN_BRANCHES = Object.freeze([
  'main',
  'master',
  'huawei-android12-car',
]);
const DEFAULT_PLUGIN_SANDBOX = path.join(
  '/Users/anpple/Codex/WallpaperEngine',
  '.worktrees',
  'mineradio-plugin-sandbox',
);
const DEFAULT_PLUGIN_BRANCH = 'codex/mineradio-plugin-sandbox';
const DEFAULT_PLUGIN_HEAD = 'f16fee74c15c58307656548bc6082891790de5d0';
const DEFAULT_WP00_TXN = path.join(
  '/Users/anpple/Codex/Mineradio',
  'android-car',
  'verification',
  'wallpaper-plugin',
  'transactions',
  'wp-00.json',
);
const BLOB_SHA_FIELDS = Object.freeze([
  'runnerSha256',
  'catalogSha256',
  'schemaSha256',
]);

// ---------------------------------------------------------------------------
// Result + git helpers
// ---------------------------------------------------------------------------

function fail(reason, message, extra = {}) {
  return {
    ok: false,
    failureReason: reason,
    message: message || reason,
    EffectiveDone: false,
    coreProgress: 0,
    ...extra,
  };
}

function ok(extra = {}) {
  return { ok: true, ...extra };
}

/** Propagate a failed layer result with an optional layer tag. */
function layerFail(result, layer) {
  return fail(result.failureReason, result.message, {
    EffectiveDone: false,
    layer,
  });
}

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return {
    status: result.status === null ? 1 : result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };
}

function isGitSha40(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
}

function isSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

function normalizeSha(value) {
  return isGitSha40(value) ? value.toLowerCase() : null;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return { __error: err };
  }
}

function readHeadSha(cwd) {
  const res = git(['rev-parse', 'HEAD'], cwd);
  if (res.status !== 0) return null;
  return normalizeSha(res.stdout);
}

function readCurrentBranch(cwd) {
  const res = git(['branch', '--show-current'], cwd);
  if (res.status !== 0) return { branch: null, detached: true };
  const branch = res.stdout;
  const abbrev = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const detached = !branch || abbrev.stdout === 'HEAD';
  return { branch: branch || null, detached };
}

// ---------------------------------------------------------------------------
// Contract checks
// ---------------------------------------------------------------------------

/**
 * Assert Mineradio task worktree identity against live git state.
 * expectedBranch / expectedHead are assertions only — facts come from git.
 */
function assertMineradioWorktreeIdentity(options = {}) {
  const cwd = options.cwd;
  if (!cwd || !fs.existsSync(cwd)) {
    return fail('IDENTITY_PATH_MISSING', `cwd missing: ${cwd}`);
  }

  const top = git(['rev-parse', '--show-toplevel'], cwd);
  if (top.status !== 0) {
    return fail('IDENTITY_NOT_GIT', top.stderr || 'not a git worktree');
  }
  const root = path.resolve(top.stdout);
  if (path.resolve(cwd) !== root) {
    return fail(
      'IDENTITY_ROOT_MISMATCH',
      `cwd ${path.resolve(cwd)} is not git toplevel ${root}`,
    );
  }

  const { branch, detached } = readCurrentBranch(cwd);
  if (detached) {
    return fail('IDENTITY_DETACHED_HEAD', 'detached HEAD is not allowed for WP-00', {
      detached: true,
      branch,
    });
  }

  const forbidden = Array.isArray(options.forbiddenBranches)
    ? options.forbiddenBranches
    : DEFAULT_FORBIDDEN_BRANCHES;

  if (forbidden.includes(branch)) {
    return fail(
      'BRANCH_FORBIDDEN',
      `branch ${branch} is forbidden for WP-00 task worktree`,
      { branch, detached: false },
    );
  }
  if (!branch.startsWith('codex/')) {
    return fail(
      'BRANCH_NOT_CODEX',
      `branch ${branch} is outside approved codex/* range`,
      { branch, detached: false },
    );
  }

  if (options.expectedBranch != null) {
    if (forbidden.includes(options.expectedBranch)) {
      return fail(
        'BRANCH_FORBIDDEN',
        `expectedBranch ${options.expectedBranch} is in forbiddenBranches`,
        { branch, detached: false },
      );
    }
    if (options.expectedBranch !== branch) {
      return fail(
        'BRANCH_IDENTITY_MISMATCH',
        `actual branch ${branch} != expectedBranch ${options.expectedBranch}`,
        { branch, detached: false },
      );
    }
  }

  const head = readHeadSha(cwd);
  if (!head) {
    return fail('HEAD_UNREADABLE', 'cannot read HEAD as 40-char SHA', {
      branch,
      detached: false,
    });
  }

  if (options.expectedHead != null) {
    const expectedHead = normalizeSha(options.expectedHead);
    if (!expectedHead) {
      return fail('HEAD_SHA_INVALID', 'expectedHead is not a 40-char git SHA', {
        branch,
        head,
        detached: false,
      });
    }
    if (expectedHead !== head) {
      return fail(
        'HEAD_BASE_MISMATCH',
        `HEAD ${head} != expectedHead ${expectedHead}`,
        { branch, head, detached: false },
      );
    }
  }

  return ok({ branch, head, detached: false, root });
}

/**
 * WallpaperEngine main must remain a non-target for WP-00 writes.
 * This function never mutates mainPath.
 */
function assertWallpaperEngineMainReadonly(options = {}) {
  const mainPath = options.mainPath;
  if (!mainPath || !fs.existsSync(mainPath)) {
    return fail('WE_MAIN_MISSING', `WallpaperEngine main missing: ${mainPath}`);
  }
  if (!fs.existsSync(path.join(mainPath, '.git'))) {
    return fail('WE_MAIN_NOT_GIT', `not a git worktree: ${mainPath}`);
  }
  const probe = git(['rev-parse', '--is-inside-work-tree'], mainPath);
  if (probe.status !== 0) {
    return fail('WE_MAIN_NOT_WORKTREE', probe.stderr || 'not inside work tree');
  }
  return ok({ mainPath: path.resolve(mainPath), readonly: true });
}

/**
 * Plugin sandbox must be an independent worktree at the approved path/branch/HEAD.
 * Until established, fail-closed with SANDBOX_NOT_ESTABLISHED.
 */
function assertPluginSandboxIdentity(options = {}) {
  const sandboxPath = options.sandboxPath;
  if (!sandboxPath || !fs.existsSync(sandboxPath)) {
    return fail(
      'SANDBOX_NOT_ESTABLISHED',
      `plugin sandbox worktree not found: ${sandboxPath}`,
      { EffectiveDone: false },
    );
  }

  const { branch, detached } = readCurrentBranch(sandboxPath);
  const head = readHeadSha(sandboxPath);
  if (detached || !branch || !head) {
    return fail('SANDBOX_NOT_GIT', 'sandbox path is not a usable git worktree', {
      EffectiveDone: false,
    });
  }

  if (options.expectedBranch && branch !== options.expectedBranch) {
    return fail(
      'SANDBOX_BRANCH_MISMATCH',
      `sandbox branch ${branch} != ${options.expectedBranch}`,
      { EffectiveDone: false, branch, head },
    );
  }

  const expectedHead = normalizeSha(options.expectedHead);
  if (expectedHead && head !== expectedHead) {
    return fail(
      'SANDBOX_HEAD_MISMATCH',
      `sandbox HEAD ${head} != ${expectedHead}`,
      { EffectiveDone: false, branch, head },
    );
  }

  return ok({
    sandboxPath: path.resolve(sandboxPath),
    branch,
    head,
    EffectiveDone: false,
  });
}

/** Unique WP-00 transaction file must exist and bind taskId WP-00. */
function assertWp00TransactionIdentity(options = {}) {
  const file = options.transactionFile;
  const taskId = options.taskId || 'WP-00';
  if (!file) {
    return fail('TRANSACTION_PATH_MISSING', 'missing transactionFile');
  }
  if (!fs.existsSync(file)) {
    return fail(
      'TRANSACTION_NOT_FOUND',
      `WP-00 transaction missing: ${file}`,
      { taskId },
    );
  }
  const data = readJsonFile(file);
  if (data.__error) {
    return fail('TRANSACTION_CORRUPT', `unreadable transaction: ${file}`);
  }
  if (data.taskId !== taskId) {
    return fail(
      'TRANSACTION_TASK_MISMATCH',
      `transaction taskId ${data.taskId} != ${taskId}`,
    );
  }
  return ok({
    transactionFile: path.resolve(file),
    taskId: data.taskId,
    state: data.state || null,
  });
}

/** Read WP-INFRA final receipt; require EffectiveGate/Done, SHAs, test receipts. */
function assertWpInfraGateFromFinalReceipt(options = {}) {
  const receiptPath = options.receiptPath;
  if (!receiptPath || !fs.existsSync(receiptPath)) {
    return fail(
      'RECEIPT_NOT_FOUND',
      `WP-INFRA final receipt missing: ${receiptPath}`,
    );
  }
  const data = readJsonFile(receiptPath);
  if (data.__error) {
    return fail('RECEIPT_CORRUPT', `cannot parse receipt: ${receiptPath}`);
  }
  if (data.EffectiveGate !== true) {
    return fail(
      'EFFECTIVE_GATE_FALSE',
      `WP-INFRA EffectiveGate is ${data.EffectiveGate}, require true`,
    );
  }
  if (data.EffectiveDone !== true) {
    return fail(
      'EFFECTIVE_DONE_FALSE',
      `WP-INFRA EffectiveDone is ${data.EffectiveDone}, require true`,
    );
  }
  if (data.state !== 'DONE') {
    return fail('INFRA_STATE_NOT_DONE', `WP-INFRA state is ${data.state}`);
  }
  for (const field of BLOB_SHA_FIELDS) {
    if (!isSha256(data[field])) {
      return fail('MISSING_BLOB_SHA', `receipt field ${field} missing or invalid`);
    }
  }
  if (!data.catalogTestReceipt || data.catalogTestReceipt.pass !== true) {
    return fail('MISSING_TEST_RECEIPT', 'catalogTestReceipt.pass != true');
  }
  if (!data.schemaTestReceipt || data.schemaTestReceipt.pass !== true) {
    return fail('MISSING_TEST_RECEIPT', 'schemaTestReceipt.pass != true');
  }
  return ok({
    EffectiveGate: true,
    EffectiveDone: true,
    state: data.state,
    runnerSha256: data.runnerSha256,
    catalogSha256: data.catalogSha256,
    schemaSha256: data.schemaSha256,
    receiptPath: path.resolve(receiptPath),
  });
}

/**
 * Authoritative base from live origin/huawei-android12-car only.
 * Caller expectedBaseSha is an assertion against live remote — never a fact override.
 * HEAD may differ from base (task work on top of base is allowed).
 */
function assertAuthoritativeBase(options = {}) {
  const cwd = options.cwd;
  if (!cwd || !fs.existsSync(cwd)) {
    return fail('BASE_PATH_MISSING', `cwd missing: ${cwd}`);
  }

  const head = readHeadSha(cwd);
  if (!head) {
    return fail('HEAD_UNREADABLE', 'cannot read HEAD');
  }

  const remoteRes = git(['rev-parse', 'origin/huawei-android12-car'], cwd);
  if (remoteRes.status !== 0) {
    return fail(
      'REMOTE_BASE_UNREADABLE',
      'cannot read origin/huawei-android12-car; fetch authoritative base first',
      { head },
    );
  }
  const remoteBase = normalizeSha(remoteRes.stdout);
  if (!remoteBase) {
    return fail(
      'REMOTE_BASE_INVALID',
      'origin/huawei-android12-car is not a 40-char SHA',
    );
  }

  const forbidden = Array.isArray(options.forbiddenHeads)
    ? options.forbiddenHeads.map((s) => String(s).toLowerCase())
    : [FORBIDDEN_INFRA_TIP];

  // Caller claim must match live remote base if provided.
  if (options.expectedBaseSha != null) {
    const claimed = normalizeSha(options.expectedBaseSha);
    if (!claimed) {
      return fail('BASE_SHA_INVALID', 'expectedBaseSha is not a 40-char git SHA');
    }
    if (forbidden.includes(claimed)) {
      return fail(
        'FORBIDDEN_HEAD_AS_BASE',
        `expectedBaseSha ${claimed} is a forbidden pseudo-base (unmerged infra tip)`,
        { head, baseSha: remoteBase },
      );
    }
    if (claimed !== remoteBase) {
      return fail(
        'CALLER_FORGED_BASE',
        `expectedBaseSha ${claimed} != live origin base ${remoteBase}`,
        { head, baseSha: remoteBase },
      );
    }
  }

  if (forbidden.includes(remoteBase)) {
    return fail(
      'FORBIDDEN_HEAD_AS_BASE',
      `live base ${remoteBase} is a forbidden pseudo-base (unmerged infra tip)`,
      { head, baseSha: remoteBase },
    );
  }
  if (forbidden.includes(head) && head === remoteBase) {
    return fail(
      'FORBIDDEN_HEAD_AS_BASE',
      `HEAD ${head} is a forbidden pseudo-base (unmerged infra tip)`,
      { head, baseSha: remoteBase },
    );
  }

  return ok({ head, baseSha: remoteBase });
}

/** Refuse caller-injected WP-00 EffectiveDone / coreProgress claims. */
function assertWp00NotDone(options = {}) {
  const claimedDone = options.claimedEffectiveDone === true;
  const claimedProgress = Number(options.claimedCoreProgress);

  let realDone = false;
  const file = options.transactionFile;
  if (file && fs.existsSync(file)) {
    const data = readJsonFile(file);
    if (!data.__error) {
      realDone =
        data.EffectiveDone === true ||
        data.state === 'DONE' ||
        data.effectiveDone === true;
    }
  }

  if (claimedDone || claimedProgress > 0) {
    return fail(
      'FORGED_DONE_OR_PROGRESS',
      'caller cannot inject WP-00 EffectiveDone=true or coreProgress>0 during RED/GREEN baseline',
      { EffectiveDone: false, coreProgress: 0, realDone },
    );
  }
  if (realDone) {
    return fail(
      'UNEXPECTED_DONE',
      'WP-00 transaction already DONE while baseline RED contract forbids it',
      { EffectiveDone: false, coreProgress: 0 },
    );
  }
  return ok({ EffectiveDone: false, coreProgress: 0 });
}

/**
 * Orchestrate WP-00 ready-to-start: infra gate + identity + base + sandbox + txn.
 * Fail-closed when plugin sandbox or transaction is not established.
 */
function assertWp00ReadyToStart(options = {}) {
  const infra = assertWpInfraGateFromFinalReceipt({
    receiptPath: options.finalInfraReceipt,
  });
  if (!infra.ok) return layerFail(infra, 'wp-infra');

  const identity = assertMineradioWorktreeIdentity({
    cwd: options.cwd,
    expectedBranch: options.expectedBranch,
    expectedHead: options.expectedHead,
    forbiddenBranches: DEFAULT_FORBIDDEN_BRANCHES,
  });
  if (!identity.ok) return layerFail(identity, 'identity');

  const base = assertAuthoritativeBase({
    cwd: options.cwd,
    // expectedBaseSha only when caller asserts; never default to frozen tip
    expectedBaseSha: options.expectedBaseSha,
    forbiddenHeads: [FORBIDDEN_INFRA_TIP],
  });
  if (!base.ok) return layerFail(base, 'base');

  // Bare runner --infra-effective-gate true is never enough without sandbox + txn.
  const sandbox = assertPluginSandboxIdentity({
    sandboxPath: options.pluginSandboxPath || DEFAULT_PLUGIN_SANDBOX,
    expectedBranch: options.pluginExpectedBranch || DEFAULT_PLUGIN_BRANCH,
    expectedHead: options.pluginExpectedHead || DEFAULT_PLUGIN_HEAD,
  });
  if (!sandbox.ok) return layerFail(sandbox, 'plugin-sandbox');

  const txn = assertWp00TransactionIdentity({
    transactionFile: options.transactionFile || DEFAULT_WP00_TXN,
    taskId: 'WP-00',
  });
  if (!txn.ok) return layerFail(txn, 'transaction');

  return ok({
    EffectiveDone: false,
    ready: true,
    infra,
    identity,
    base,
  });
}

/**
 * Core progress: WP-INFRA is unweighted; WP-00 adds 4% only when EffectiveDone.
 * Caller-supplied progress numbers are ignored.
 */
function computeCoreProgress(options = {}) {
  const wp00Done = options.wp00EffectiveDone === true;
  return ok({
    coreProgress: wp00Done ? 4 : 0,
    highestEvidence: 'E0',
    wpInfraWeighted: false,
  });
}

module.exports = {
  assertMineradioWorktreeIdentity,
  assertWallpaperEngineMainReadonly,
  assertPluginSandboxIdentity,
  assertWp00TransactionIdentity,
  assertWpInfraGateFromFinalReceipt,
  assertAuthoritativeBase,
  assertWp00NotDone,
  assertWp00ReadyToStart,
  computeCoreProgress,
  // Exported constants for tests / future GREEN slices (read-only facts).
  DEFAULT_AUTHORITATIVE_BASE,
  DEFAULT_FORBIDDEN_BRANCHES,
};
