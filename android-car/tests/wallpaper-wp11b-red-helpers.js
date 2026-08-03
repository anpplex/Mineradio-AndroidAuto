'use strict';

/** Helpers for WP-11B / RED — E6 30-min soak capacity (weight 3). */

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
const wp11aTxnReceipt = path.join(transactionsRoot, 'wp-11a.json');
const wp11bTxnReceipt = path.join(transactionsRoot, 'wp-11b.json');

const TASK_ID = 'WP-11B';
const EXPECTED_CURRENT_CORE_PROGRESS = 93;
const EXPECTED_WEIGHT_FROM_PROGRESS_TABLE = 3;
const EXPECTED_PROGRESS_WHEN_DONE = 96;

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

function loadWp11bCatalogEntry() {
  const catalog = readJson(catalogPath);
  const matches = (catalog.tasks || []).filter((t) => t && t.taskId === TASK_ID);
  if (matches.length !== 1) {
    return { ok: false, count: matches.length };
  }
  return { ok: true, entry: matches[0] };
}

function assertE6VerifierSurface() {
  const text = fs.readFileSync(verifyJsPath, 'utf8');
  const need = [
    'verifyE6Evidence',
    'buildE6Fixture',
    'assertE6Fixtures',
    'E6_FIXTURE_NAMES',
    'E6_DURATION_MS',
    'E6_SAMPLE_COUNT',
    'E6_PSS_GROWTH_MIB',
    'play',
    'pause_resume',
    'return_main',
  ];
  const missing = need.filter((t) => !text.includes(t));
  return missing.length ? { ok: false, missing } : { ok: true };
}

function assertE6FixturesPresent() {
  const r = spawnSync('node', [verifyJsPath, '--e6-fixtures'], {
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
    'evaluate_wp11b_verify_done',
    'WP11B',
    'e6Evidence',
    'WP11B_E6_DURATION_MS',
    'sampleCount',
  ];
  const hits = need.filter((m) => runner.includes(m));
  return hits.length === need.length ? { ok: true } : { ok: false, hits };
}

function assertWp11bFullProductionCapacity() {
  const checks = [
    loadWp11bCatalogEntry(),
    assertE6VerifierSurface(),
    assertE6FixturesPresent(),
    assertEvaluateSurface(),
  ];
  if (checks.some((c) => !c.ok)) return { ok: false, checks };
  const entry = checks[0].entry;
  if (entry.weight !== 3 || entry.evidenceLevel !== 'E6') {
    return { ok: false, weight: entry.weight, evidenceLevel: entry.evidenceLevel };
  }
  if (!(entry.requiredEffectiveDone || []).includes('WP-11A')) {
    return { ok: false, message: 'must require WP-11A' };
  }
  return { ok: true, entry };
}

function readWp11aDone() {
  if (!pathExists(wp11aTxnReceipt)) return { ok: false };
  const r = readJson(wp11aTxnReceipt);
  return { ok: r.EffectiveDone === true && r.state === 'DONE' };
}

module.exports = {
  runnerPath,
  catalogPath,
  verifyJsPath,
  wp11aTxnReceipt,
  wp11bTxnReceipt,
  TASK_ID,
  EXPECTED_CURRENT_CORE_PROGRESS,
  EXPECTED_WEIGHT_FROM_PROGRESS_TABLE,
  EXPECTED_PROGRESS_WHEN_DONE,
  pathExists,
  readJson,
  loadWp11bCatalogEntry,
  assertE6VerifierSurface,
  assertE6FixturesPresent,
  assertEvaluateSurface,
  assertWp11bFullProductionCapacity,
  readWp11aDone,
};
