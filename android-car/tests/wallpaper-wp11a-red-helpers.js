'use strict';

/** Helpers for WP-11A / RED — recovery fault matrix capacity (weight 3, stay E5). */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const runnerPath = path.join(repoRoot, 'android-car', 'scripts', 'wallpaper-task.py');
const catalogPath = path.join(repoRoot, 'android-car', 'scripts', 'wallpaper-plugin-tasks.json');
const verifyJsPath = path.join(repoRoot, 'android-car', 'scripts', 'verify-wallpaper-plugin.js');
const transactionsRoot = path.join(
  '/Users/anpple/Codex/Mineradio',
  'android-car',
  'verification',
  'wallpaper-plugin',
  'transactions',
);
const wp10cTxnReceipt = path.join(transactionsRoot, 'wp-10c.json');
const wp11aTxnReceipt = path.join(transactionsRoot, 'wp-11a.json');

const TASK_ID = 'WP-11A';
const EXPECTED_CURRENT_CORE_PROGRESS = 90;
const EXPECTED_WEIGHT_FROM_PROGRESS_TABLE = 3;
const EXPECTED_PROGRESS_WHEN_DONE = 93;

function pathExists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function loadWp11aCatalogEntry() {
  const catalog = readJson(catalogPath);
  const matches = (catalog.tasks || []).filter((t) => t && t.taskId === TASK_ID);
  if (matches.length !== 1) {
    return { ok: false, count: matches.length };
  }
  return { ok: true, entry: matches[0] };
}

function assertRecoveryVerifierSurface() {
  const text = fs.readFileSync(verifyJsPath, 'utf8');
  const need = [
    'verifyRecoveryEvidence',
    'buildRecoveryFixture',
    'assertRecoveryFixtures',
    'RECOVERY_FIXTURE_NAMES',
    'RECOVERY_MAX_MS',
    'package_presence',
    'auto_recoverable',
    'expected_error',
    'PLUGIN_NOT_INSTALLED',
    'ENGINE_NOT_INSTALLED',
    'ACTIVE_TARGET',
  ];
  const missing = need.filter((t) => !text.includes(t));
  return missing.length ? { ok: false, missing } : { ok: true };
}

function assertRecoveryFixturesPresent() {
  const r = spawnSync('node', [verifyJsPath, '--recovery-fixtures'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (r.status !== 0) return { ok: false, out: r.stdout + r.stderr };
  try {
    const data = JSON.parse((r.stdout || '').trim().split('\n').filter(Boolean).pop());
    return { ok: !!data.ok, data };
  } catch (e) {
    return { ok: false, message: String(e) };
  }
}

function assertEvaluateSurface() {
  const runner = fs.readFileSync(runnerPath, 'utf8');
  const need = [
    'evaluate_wp11a_verify_done',
    'WP11A',
    'recoveryEvidence',
    'WP11A_RECOVERY_MAX_MS',
    'autoRecoverablePass',
  ];
  const hits = need.filter((m) => runner.includes(m));
  return hits.length === need.length ? { ok: true } : { ok: false, hits };
}

function assertWp11aFullProductionCapacity() {
  const checks = [
    loadWp11aCatalogEntry(),
    assertRecoveryVerifierSurface(),
    assertRecoveryFixturesPresent(),
    assertEvaluateSurface(),
  ];
  if (checks.some((c) => !c.ok)) return { ok: false, checks };
  const entry = checks[0].entry;
  if (entry.weight !== 3 || entry.evidenceLevel !== 'E5') {
    return { ok: false, weight: entry.weight, evidenceLevel: entry.evidenceLevel };
  }
  if (!(entry.requiredEffectiveDone || []).includes('WP-10C')) {
    return { ok: false, message: 'must require WP-10C' };
  }
  return { ok: true, entry };
}

function readWp10cDone() {
  if (!pathExists(wp10cTxnReceipt)) return { ok: false };
  const r = readJson(wp10cTxnReceipt);
  return { ok: r.EffectiveDone === true && r.state === 'DONE' };
}

module.exports = {
  runnerPath,
  catalogPath,
  verifyJsPath,
  wp10cTxnReceipt,
  wp11aTxnReceipt,
  TASK_ID,
  EXPECTED_CURRENT_CORE_PROGRESS,
  EXPECTED_WEIGHT_FROM_PROGRESS_TABLE,
  EXPECTED_PROGRESS_WHEN_DONE,
  pathExists,
  readJson,
  loadWp11aCatalogEntry,
  assertRecoveryVerifierSurface,
  assertRecoveryFixturesPresent,
  assertEvaluateSurface,
  assertWp11aFullProductionCapacity,
  readWp10cDone,
};
