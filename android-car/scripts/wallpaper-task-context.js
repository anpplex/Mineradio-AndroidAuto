'use strict';

/**
 * Unified task context provider for wallpaper-plugin tests and helpers.
 *
 * Two context kinds only:
 *   - live-git          facts from real git in a worktree
 *   - fixture/test-only isolated sandboxes; never production receipts
 *
 * Caller claims for base SHA, HEAD, REMOTE_VERIFIED, EffectiveDone, or progress
 * are never sources of truth.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUTHORITATIVE_BASE_REF = 'refs/heads/huawei-android12-car';
const AUTHORITATIVE_BASE_BRANCH = 'huawei-android12-car';
const APPROVED_REMOTE = 'origin';
const TASK_BRANCH_PREFIX = 'codex/wallpaper-plugin-';

const FORBIDDEN_TASK_BRANCHES = Object.freeze([
  'main',
  'master',
  'huawei-android12-car',
]);

/** Historical unmerged infra tip — never authoritative base. */
const FORBIDDEN_PSEUDO_BASE_TIPS = Object.freeze([
  '57cbe4ac1481a6bd79f6c3eca4f6ae91d37bcd08',
]);

const CONTEXT_KIND = Object.freeze({
  LIVE: 'live-git',
  FIXTURE: 'fixture/test-only',
});

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return {
    status: result.status === null ? 1 : result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };
}

function gitOrThrow(args, cwd, label) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if ((r.status === null ? 1 : r.status) !== 0) {
    throw new Error(`${label}: ${r.stderr || r.stdout || 'git failed'}`);
  }
  return (r.stdout || '').trim();
}

function isGitSha40(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
}

function normalizeSha(value) {
  return isGitSha40(value) ? value.toLowerCase() : null;
}

function fail(reason, message, extra = {}) {
  return {
    ok: false,
    failureReason: reason,
    message: message || reason,
    remoteVerifiedFromEnv: false,
    ...extra,
  };
}

function ok(extra = {}) {
  return { ok: true, remoteVerifiedFromEnv: false, ...extra };
}

function targetRefForBranch(branch) {
  return branch ? `refs/heads/${branch}` : null;
}

/**
 * Shared fields every context frame carries so callers can treat live and
 * fixture results uniformly. Fixture frames always set writesProductionReceipt=false.
 */
function contextFrame(kind, fields) {
  return {
    kind,
    writesProductionReceipt: false,
    remoteVerifiedFromEnv: false,
    remote: APPROVED_REMOTE,
    authoritativeBaseRef: AUTHORITATIVE_BASE_REF,
    ...fields,
  };
}

// ---------------------------------------------------------------------------
// Allowlists / security gates
// ---------------------------------------------------------------------------

/**
 * Approved wallpaper task branches: codex/wallpaper-plugin-* except base/main/master.
 * Includes infra, wp00, monorepo, and future codex/wallpaper-plugin-* legs.
 */
function isApprovedTaskBranch(branch) {
  if (!branch || typeof branch !== 'string') return false;
  if (FORBIDDEN_TASK_BRANCHES.includes(branch)) return false;
  if (branch === 'HEAD') return false;
  return branch.startsWith(TASK_BRANCH_PREFIX);
}

function assertTaskBranchAllowed(branch) {
  if (!isApprovedTaskBranch(branch)) {
    return fail(
      'BRANCH_NOT_ALLOWED',
      `task branch not allowed: ${branch}; must be ${TASK_BRANCH_PREFIX}* ` +
        `(not main/master/huawei-android12-car)`,
      { branch },
    );
  }
  return ok({ branch });
}

function assertRemoteAllowed(remote) {
  const token = remote == null ? APPROVED_REMOTE : String(remote).trim();
  if (token === '' || token !== APPROVED_REMOTE) {
    return fail(
      'REMOTE_NOT_ALLOWED',
      `remote not allowed: ${JSON.stringify(token)}; only origin is approved`,
      { remote: token },
    );
  }
  return ok({ remote: token });
}

/**
 * Caller may pass claimedBaseSha as an assertion, never as a fact override.
 * Live base always comes from origin/huawei-android12-car (passed in as liveBaseSha).
 */
function assertAuthoritativeBaseNotCallerForged(options = {}) {
  const liveBaseSha = normalizeSha(options.liveBaseSha);
  const claimed = normalizeSha(options.claimedBaseSha);
  if (!liveBaseSha) {
    return fail(
      'BASE_UNREADABLE',
      'live authoritative base SHA missing (origin/huawei-android12-car)',
    );
  }
  if (FORBIDDEN_PSEUDO_BASE_TIPS.includes(liveBaseSha)) {
    return fail(
      'FORBIDDEN_HEAD_AS_BASE',
      `live base ${liveBaseSha} is a forbidden pseudo-base tip`,
      { liveBaseSha },
    );
  }
  if (claimed && FORBIDDEN_PSEUDO_BASE_TIPS.includes(claimed)) {
    return fail(
      'FORBIDDEN_HEAD_AS_BASE',
      `caller claimed forbidden infra tip as base: ${claimed}`,
      { claimedBaseSha: claimed, liveBaseSha },
    );
  }
  if (claimed && claimed !== liveBaseSha) {
    return fail(
      'CALLER_FORGED_BASE',
      `caller claimedBaseSha ${claimed} != live base ${liveBaseSha}`,
      { claimedBaseSha: claimed, liveBaseSha },
    );
  }
  return ok({ liveBaseSha, authoritativeBaseSha: liveBaseSha });
}

// ---------------------------------------------------------------------------
// Context resolution
// ---------------------------------------------------------------------------

function resolveFixtureContext(options, cwd) {
  const f = options.fixture;
  return contextFrame(CONTEXT_KIND.FIXTURE, {
    ok: true,
    repoRoot: f.repoRoot || cwd,
    worktree: f.worktree || cwd,
    taskBranch: f.taskBranch,
    headSha: f.headSha,
    authoritativeBaseSha: f.authoritativeBaseSha,
    targetRef: f.targetRef || targetRefForBranch(f.taskBranch),
    taskId: options.taskId || f.taskId || null,
    transactionIdentity: f.transactionIdentity || null,
  });
}

function readLiveBaseSha(cwd) {
  const baseRes = git(['rev-parse', AUTHORITATIVE_BASE_BRANCH], cwd);
  // Prefer fully-qualified origin ref
  const originRes = git(['rev-parse', `origin/${AUTHORITATIVE_BASE_BRANCH}`], cwd);
  if (originRes.status === 0) {
    return normalizeSha(originRes.stdout);
  }
  if (baseRes.status === 0) {
    return normalizeSha(baseRes.stdout);
  }
  return null;
}

/**
 * Resolve task context.
 *
 * @param {object} options
 * @param {string} [options.cwd]
 * @param {string} [options.taskId]
 * @param {object} [options.env] inspected only so REMOTE_VERIFIED is never trusted
 * @param {string} [options.claimedBaseSha] assertion only
 * @param {string} [options.claimedHeadSha] assertion only
 * @param {object} [options.fixture] must set kind: 'fixture/test-only'
 */
function resolveTaskContext(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  // env forgeries are intentionally ignored as facts (REMOTE_VERIFIED, etc.)
  void (options.env || process.env);

  if (options.fixture && options.fixture.kind === CONTEXT_KIND.FIXTURE) {
    return resolveFixtureContext(options, cwd);
  }

  const top = git(['rev-parse', '--show-toplevel'], cwd);
  if (top.status !== 0) {
    return fail('NOT_GIT', top.stderr || 'not a git worktree');
  }
  const repoRoot = path.resolve(top.stdout);

  const taskBranch = git(['branch', '--show-current'], cwd).stdout || null;
  const branchGate = assertTaskBranchAllowed(taskBranch);
  if (!branchGate.ok) {
    return fail(branchGate.failureReason, branchGate.message, {
      branch: taskBranch,
      repoRoot,
      worktree: repoRoot,
    });
  }

  const headSha = normalizeSha(git(['rev-parse', 'HEAD'], cwd).stdout);
  if (!headSha) {
    return fail('HEAD_UNREADABLE', 'HEAD is not a 40-char SHA', {
      repoRoot,
      worktree: repoRoot,
      taskBranch,
    });
  }

  if (options.claimedHeadSha) {
    const claimedHead = normalizeSha(options.claimedHeadSha);
    if (claimedHead && claimedHead !== headSha) {
      return fail(
        'CALLER_FORGED_HEAD',
        `caller claimedHeadSha ${claimedHead} != live HEAD ${headSha}`,
        { repoRoot, worktree: repoRoot, taskBranch, headSha },
      );
    }
  }

  const liveBaseSha = readLiveBaseSha(cwd);
  const baseGate = assertAuthoritativeBaseNotCallerForged({
    liveBaseSha,
    claimedBaseSha: options.claimedBaseSha,
  });
  if (!baseGate.ok) {
    return fail(baseGate.failureReason, baseGate.message, {
      repoRoot,
      worktree: repoRoot,
      taskBranch,
      headSha,
      claimedBaseSha: options.claimedBaseSha || null,
    });
  }

  return contextFrame(CONTEXT_KIND.LIVE, {
    ok: true,
    repoRoot,
    worktree: repoRoot,
    taskBranch,
    headSha,
    authoritativeBaseBranch: AUTHORITATIVE_BASE_BRANCH,
    authoritativeBaseSha: liveBaseSha,
    targetRef: targetRefForBranch(taskBranch),
    taskId: options.taskId || null,
    transactionIdentity: options.transactionIdentity || null,
  });
}

// ---------------------------------------------------------------------------
// Test-only fixture factory
// ---------------------------------------------------------------------------

/**
 * Isolated bare repo for exact-push dry-run tests.
 * Always kind fixture/test-only; never writes production receipts.
 */
function createIsolatedBareFixture(options = {}) {
  const branch = options.branch || `${TASK_BRANCH_PREFIX}fixture`;
  const branchGate = assertTaskBranchAllowed(branch);
  if (!branchGate.ok) {
    throw new Error(branchGate.message || branchGate.failureReason);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-ctx-bare-'));
  const bare = path.join(tmp, 'remote.git');
  const work = path.join(tmp, 'work');

  gitOrThrow(['init', '--bare', bare], tmp, 'git init --bare');
  gitOrThrow(['clone', bare, work], tmp, 'git clone');
  fs.writeFileSync(path.join(work, 'README'), 'fixture\n');
  gitOrThrow(['add', 'README'], work, 'git add');
  gitOrThrow(
    [
      '-c',
      'user.email=fixture@test',
      '-c',
      'user.name=fixture',
      'commit',
      '-m',
      'fixture',
    ],
    work,
    'git commit',
  );
  gitOrThrow(['branch', '-M', branch], work, 'git branch -M');
  gitOrThrow(['push', '-u', 'origin', branch], work, 'git push');
  const headSha = normalizeSha(gitOrThrow(['rev-parse', 'HEAD'], work, 'git rev-parse'));

  return {
    kind: CONTEXT_KIND.FIXTURE,
    writesProductionReceipt: false,
    remoteUrl: bare,
    worktree: work,
    branch,
    headSha,
    targetRef: targetRefForBranch(branch),
    remote: APPROVED_REMOTE,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  AUTHORITATIVE_BASE_REF,
  AUTHORITATIVE_BASE_BRANCH,
  APPROVED_REMOTE,
  TASK_BRANCH_PREFIX,
  FORBIDDEN_TASK_BRANCHES,
  FORBIDDEN_PSEUDO_BASE_TIPS,
  CONTEXT_KIND,
  isApprovedTaskBranch,
  assertTaskBranchAllowed,
  assertRemoteAllowed,
  assertAuthoritativeBaseNotCallerForged,
  resolveTaskContext,
  createIsolatedBareFixture,
};
