'use strict';

/**
 * Helpers for WP-00 RED-01 baseline / worktree / WP-INFRA gate contracts.
 * Uses real git, real paths, real final receipt — no forged SHAs.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const contractPath = path.join(repoRoot, 'android-car', 'scripts', 'wp00-baseline-contract.js');
const runnerPath = path.join(repoRoot, 'android-car', 'scripts', 'wallpaper-task.py');
const catalogPath = path.join(repoRoot, 'android-car', 'scripts', 'wallpaper-plugin-tasks.json');
const schemaPath = path.join(repoRoot, 'android-car', 'scripts', 'wallpaper-task.schema.json');

// Shared verification tree (gitignored) lives with the primary clone.
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

const AUTHORITATIVE_BASE_SHA = '87d5675b135c5f0e94ec94007667e81866a76984';
const APPROVED_WP00_BRANCH = 'codex/wallpaper-plugin-wp00';
const FORBIDDEN_BRANCHES = Object.freeze([
  'main',
  'master',
  'huawei-android12-car',
  'codex/wallpaper-plugin-infra',
]);
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
  // Clear require cache so GREEN iterations reload.
  delete require.cache[require.resolve(contractPath)];
  return require(contractPath);
}

function requireBaselineContract() {
  const c = loadBaselineContract();
  if (!c) {
    const err = new Error(
      'WP-00 baseline contract surface not implemented: ' + contractPath,
    );
    err.code = 'WP00_BASELINE_NOT_IMPLEMENTED';
    throw err;
  }
  return c;
}

module.exports = {
  repoRoot,
  contractPath,
  runnerPath,
  catalogPath,
  schemaPath,
  verificationRoot,
  finalInfraReceipt,
  wp00TxnRoot,
  wp00TxnFile,
  AUTHORITATIVE_BASE_SHA,
  APPROVED_WP00_BRANCH,
  FORBIDDEN_BRANCHES,
  WALLPAPER_ENGINE_MAIN,
  PLUGIN_SANDBOX_WT,
  git,
  runPython,
  readJson,
  loadBaselineContract,
  requireBaselineContract,
};
