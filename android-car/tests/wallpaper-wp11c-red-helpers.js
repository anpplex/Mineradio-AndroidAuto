'use strict';

/** Helpers for WP-11C / RED — E7 reboot/ACC/2h capacity (weight 4). */

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
const wp11bTxnReceipt = path.join(transactionsRoot, 'wp-11b.json');
const wp11cTxnReceipt = path.join(transactionsRoot, 'wp-11c.json');

const TASK_ID = 'WP-11C';
const EXPECTED_CURRENT_CORE_PROGRESS = 96;
const EXPECTED_WEIGHT_FROM_PROGRESS_TABLE = 4;
const EXPECTED_PROGRESS_WHEN_DONE = 100;

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

function loadWp11cCatalogEntry() {
  const catalog = readJson(catalogPath);
  const matches = (catalog.tasks || []).filter((t) => t && t.taskId === TASK_ID);
  if (matches.length !== 1) return { ok: false, count: matches.length };
  return { ok: true, entry: matches[0] };
}

function assertE7VerifierSurface() {
  const text = fs.readFileSync(verifyJsPath, 'utf8');
  const need = [
    'verifyE7Evidence',
    'buildE7Fixture',
    'assertE7Fixtures',
    'E7_FIXTURE_NAMES',
    'E7_DURATION_MS',
    'E7_SAMPLE_COUNT',
    'operator_attested_physical_acc',
    'bootIdBefore',
    'bootIdAfter',
  ];
  const missing = need.filter((t) => !text.includes(t));
  return missing.length ? { ok: false, missing } : { ok: true };
}

function assertE7FixturesPresent() {
  const r = spawnSync('node', [verifyJsPath, '--e7-fixtures'], {
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
    'evaluate_wp11c_verify_done',
    'WP11C',
    'e7Evidence',
    'WP11C_E7_DURATION_MS',
    'rebootPass',
    'accPass',
  ];
  const hits = need.filter((m) => runner.includes(m));
  return hits.length === need.length ? { ok: true } : { ok: false, hits };
}

function assertWp11cFullProductionCapacity() {
  const checks = [
    loadWp11cCatalogEntry(),
    assertE7VerifierSurface(),
    assertE7FixturesPresent(),
    assertEvaluateSurface(),
  ];
  if (checks.some((c) => !c.ok)) return { ok: false, checks };
  const entry = checks[0].entry;
  if (entry.weight !== 4 || entry.evidenceLevel !== 'E7') {
    return { ok: false, weight: entry.weight, evidenceLevel: entry.evidenceLevel };
  }
  if (!(entry.requiredEffectiveDone || []).includes('WP-11B')) {
    return { ok: false, message: 'must require WP-11B' };
  }
  return { ok: true, entry };
}

function readWp11bDone() {
  if (!pathExists(wp11bTxnReceipt)) return { ok: false };
  const r = readJson(wp11bTxnReceipt);
  return { ok: r.EffectiveDone === true && r.state === 'DONE' };
}

module.exports = {
  runnerPath,
  catalogPath,
  verifyJsPath,
  wp11bTxnReceipt,
  wp11cTxnReceipt,
  TASK_ID,
  EXPECTED_CURRENT_CORE_PROGRESS,
  EXPECTED_WEIGHT_FROM_PROGRESS_TABLE,
  EXPECTED_PROGRESS_WHEN_DONE,
  pathExists,
  readJson,
  loadWp11cCatalogEntry,
  assertE7VerifierSurface,
  assertE7FixturesPresent,
  assertEvaluateSurface,
  assertWp11cFullProductionCapacity,
  readWp11bDone,
};
