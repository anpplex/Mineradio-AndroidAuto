'use strict';

/**
 * Helpers for WP-00 baseline / worktree / WP-INFRA gate contracts.
 * Uses real git, real paths, real final receipt — and unified task context.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const contractPath = path.join(repoRoot, 'android-car', 'scripts', 'wp00-baseline-contract.js');
const contextProviderPath = path.join(
  repoRoot,
  'android-car',
  'scripts',
  'wallpaper-task-context.js',
);
const runnerPath = path.join(repoRoot, 'android-car', 'scripts', 'wallpaper-task.py');
const catalogPath = path.join(repoRoot, 'android-car', 'scripts', 'wallpaper-plugin-tasks.json');
const schemaPath = path.join(repoRoot, 'android-car', 'scripts', 'wallpaper-task.schema.json');

const verificationRoot = path.join(
  '/Users/anpple/Codex/Mineradio',
  'android-car',
  'verification',
  'wallpaper-plugin',
);
const finalInfraReceipt = path.join(
  verificationRoot,
  'bootstrap',
  'WP-INFRA-FINAL-RECEIPT-17.json',
);
const wp00TxnRoot = path.join(verificationRoot, 'transactions');
const wp00TxnFile = path.join(wp00TxnRoot, 'wp-00.json');

const {
  resolveTaskContext,
  FORBIDDEN_TASK_BRANCHES,
  FORBIDDEN_PSEUDO_BASE_TIPS,
  AUTHORITATIVE_BASE_REF,
} = require(contextProviderPath);

/** Forbidden as WP-00 task branch (includes integration base). */
const FORBIDDEN_BRANCHES = Object.freeze([...FORBIDDEN_TASK_BRANCHES]);

const WALLPAPER_ENGINE_MAIN = '/Users/anpple/Codex/WallpaperEngine';
const PLUGIN_SANDBOX_WT = path.join(
  WALLPAPER_ENGINE_MAIN,
  '.worktrees',
  'mineradio-plugin-sandbox',
);

function git(args, cwd = repoRoot) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
  });
  return {
    status: result.status === null ? 1 : result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
    combined: `${result.stdout || ''}\n${result.stderr || ''}`,
  };
}

function runPython(args, options = {}) {
  const result = spawnSync('python3', [runnerPath, ...args], {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...(options.env || {}) },
  });
  return {
    status: result.status === null ? 1 : result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    combined: `${result.stdout || ''}\n${result.stderr || ''}`,
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadBaselineContract() {
  if (!fs.existsSync(contractPath)) {
    return null;
  }
  delete require.cache[require.resolve(contractPath)];
  return require(contractPath);
}

function requireBaselineContract() {
  const surface = loadBaselineContract();
  if (!surface) {
    throw new Error(`WP-00 baseline contract missing: ${contractPath}`);
  }
  return surface;
}

/**
 * Live task context for this worktree (branch, HEAD, authoritative base).
 * Does not hardcode wp00 branch or frozen base SHAs.
 */
function getWp00TaskContext(cwd = repoRoot) {
  const ctx = resolveTaskContext({ cwd, taskId: 'WP-00' });
  if (!ctx.ok) {
    throw new Error(
      `resolveTaskContext failed: ${ctx.failureReason || ''} ${ctx.message || ''}`,
    );
  }
  return ctx;
}

function fieldFromContext(field, cwd = repoRoot) {
  return getWp00TaskContext(cwd)[field];
}

/** Live authoritative base SHA from origin (never caller-forged). */
function liveAuthoritativeBaseSha(cwd = repoRoot) {
  return fieldFromContext('authoritativeBaseSha', cwd);
}

/** Current allowed task branch from git. */
function liveTaskBranch(cwd = repoRoot) {
  return fieldFromContext('taskBranch', cwd);
}

/** Current HEAD from git. */
function liveHeadSha(cwd = repoRoot) {
  return fieldFromContext('headSha', cwd);
}

module.exports = {
  repoRoot,
  contractPath,
  contextProviderPath,
  runnerPath,
  catalogPath,
  schemaPath,
  finalInfraReceipt,
  wp00TxnFile,
  FORBIDDEN_BRANCHES,
  FORBIDDEN_PSEUDO_BASE_TIPS,
  AUTHORITATIVE_BASE_REF,
  WALLPAPER_ENGINE_MAIN,
  PLUGIN_SANDBOX_WT,
  git,
  runPython,
  readJson,
  requireBaselineContract,
  loadBaselineContract,
  resolveTaskContext,
  getWp00TaskContext,
  liveAuthoritativeBaseSha,
  liveTaskBranch,
  liveHeadSha,
  getAuthoritativeBaseSha: liveAuthoritativeBaseSha,
  getApprovedTaskBranch: liveTaskBranch,
  getHeadSha: liveHeadSha,
};

Object.defineProperty(module.exports, 'AUTHORITATIVE_BASE_SHA', {
  enumerable: true,
  get: liveAuthoritativeBaseSha,
});
Object.defineProperty(module.exports, 'APPROVED_WP00_BRANCH', {
  enumerable: true,
  get: liveTaskBranch,
});
