'use strict';

/** Helpers for WP-10C / RED — E5 system wallpaper binding capacity. */

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
const wp10bTxnReceipt = path.join(transactionsRoot, 'wp-10b.json');
const wp10cTxnReceipt = path.join(transactionsRoot, 'wp-10c.json');

const TASK_ID = 'WP-10C';
const EXPECTED_CURRENT_CORE_PROGRESS = 84;
const EXPECTED_WEIGHT_FROM_PROGRESS_TABLE = 6;
const EXPECTED_PROGRESS_WHEN_DONE = 90;

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

function loadWp10cCatalogEntry() {
  const catalog = readJson(catalogPath);
  const matches = (catalog.tasks || []).filter((t) => t && t.taskId === TASK_ID);
  if (matches.length !== 1) {
    return { ok: false, count: matches.length };
  }
  return { ok: true, entry: matches[0] };
}

function assertE5VerifierSurface() {
  const text = fs.readFileSync(verifyJsPath, 'utf8');
  const need = [
    'verifyE5Evidence',
    'buildE5Fixture',
    'assertE5Fixtures',
    'E5_FIXTURE_NAMES',
    'ACTIVE_TARGET',
    'WEWallpaperService',
  ];
  const missing = need.filter((t) => !text.includes(t));
  return missing.length ? { ok: false, missing } : { ok: true };
}

function assertE5FixturesPresent() {
  const r = spawnSync('node', [verifyJsPath, '--e5-fixtures'], {
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
  const need = ['evaluate_wp10c_verify_done', 'WP10C', 'e5Evidence', 'ACTIVE_TARGET'];
  const hits = need.filter((m) => runner.includes(m));
  return hits.length === need.length ? { ok: true } : { ok: false, hits };
}

function assertWp10cFullProductionCapacity() {
  const checks = [
    loadWp10cCatalogEntry(),
    assertE5VerifierSurface(),
    assertE5FixturesPresent(),
    assertEvaluateSurface(),
  ];
  if (checks.some((c) => !c.ok)) return { ok: false, checks };
  const entry = checks[0].entry;
  if (entry.weight !== 6 || entry.evidenceLevel !== 'E5') {
    return { ok: false, weight: entry.weight, evidenceLevel: entry.evidenceLevel };
  }
  if (!(entry.requiredEffectiveDone || []).includes('WP-10B')) {
    return { ok: false, message: 'must require WP-10B' };
  }
  return { ok: true, entry };
}

function readWp10bDone() {
  if (!pathExists(wp10bTxnReceipt)) return { ok: false };
  const r = readJson(wp10bTxnReceipt);
  return { ok: r.EffectiveDone === true && r.state === 'DONE' };
}

module.exports = {
  runnerPath,
  catalogPath,
  verifyJsPath,
  wp10bTxnReceipt,
  wp10cTxnReceipt,
  TASK_ID,
  EXPECTED_CURRENT_CORE_PROGRESS,
  EXPECTED_WEIGHT_FROM_PROGRESS_TABLE,
  EXPECTED_PROGRESS_WHEN_DONE,
  pathExists,
  readJson,
  loadWp10cCatalogEntry,
  assertE5VerifierSurface,
  assertE5FixturesPresent,
  assertEvaluateSurface,
  assertWp10cFullProductionCapacity,
  readWp10bDone,
};
