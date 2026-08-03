'use strict';

/**
 * Helpers for WP-10B / RED-01 — Scene/Video E4 dual-frame capacity.
 *
 * RED only: catalog + E4 fixtures + parent chain surfaces.
 * Does not claim EffectiveDone or raise Core above 76%.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const runnerPath = path.join(repoRoot, 'android-car', 'scripts', 'wallpaper-task.py');
const catalogPath = path.join(
  repoRoot,
  'android-car',
  'scripts',
  'wallpaper-plugin-tasks.json',
);
const schemaPath = path.join(repoRoot, 'android-car', 'scripts', 'wallpaper-task.schema.json');
const verifyJsPath = path.join(
  repoRoot,
  'android-car',
  'scripts',
  'verify-wallpaper-plugin.js',
);

const TARGET_SERIAL = 'LD249H019625';
const TARGET_USER = '12';

const WP10B_E4_FAIL_FIXTURES = Object.freeze([
  'blackScreen',
  'solidColorOnly',
  'activityLogOnly',
  'missingWindowSurface',
  'missingFramePair',
  'dynamicFramesIdentical',
  'stateOnlyStaged',
  'forgedPreviewReady',
  'sceneOnlyMissingVideo',
  'videoOnlyMissingScene',
]);

const verificationRoot = path.join(
  '/Users/anpple/Codex/Mineradio',
  'android-car',
  'verification',
  'wallpaper-plugin',
);
const transactionsRoot = path.join(verificationRoot, 'transactions');
const wp10aTxnReceipt = path.join(transactionsRoot, 'wp-10a.json');
const wp10bTxnReceipt = path.join(transactionsRoot, 'wp-10b.json');

const TASK_ID = 'WP-10B';
/** WP-00…WP-10A = 76; +WP-10B(8)=84 when DONE. */
const EXPECTED_CURRENT_CORE_PROGRESS = 76;
const EXPECTED_WEIGHT_FROM_PROGRESS_TABLE = 8;
const EXPECTED_PROGRESS_WHEN_DONE = 84;

const FailureReason = Object.freeze({
  WP10B_CATALOG_ENTRY_MISSING: 'WP10B_CATALOG_ENTRY_MISSING',
  WP10B_CATALOG_FIELD_MISSING: 'WP10B_CATALOG_FIELD_MISSING',
  WP10B_E4_FIXTURES_MISSING: 'WP10B_E4_FIXTURES_MISSING',
  WP10B_E4_VERIFIER_MISSING: 'WP10B_E4_VERIFIER_MISSING',
  WP10B_PARENT_CHAIN_MISSING: 'WP10B_PARENT_CHAIN_MISSING',
  WP10B_REQUIRED_DONE_MISSING: 'WP10B_REQUIRED_DONE_MISSING',
  WP10B_EFFECTIVE_DONE_FORGED: 'WP10B_EFFECTIVE_DONE_FORGED',
});

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

function runRunner(argv) {
  const r = spawnSync('python3', [runnerPath, ...argv], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    status: r.status === null ? 1 : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    combined: `${r.stdout || ''}${r.stderr || ''}`,
  };
}

function loadWp10bCatalogEntry() {
  if (!pathExists(catalogPath)) {
    return { ok: false, reason: FailureReason.WP10B_CATALOG_ENTRY_MISSING };
  }
  const catalog = readJson(catalogPath);
  const matches = (catalog.tasks || []).filter((t) => t && t.taskId === TASK_ID);
  if (matches.length !== 1) {
    return {
      ok: false,
      reason: FailureReason.WP10B_CATALOG_ENTRY_MISSING,
      count: matches.length,
    };
  }
  return { ok: true, entry: matches[0], catalog };
}

function assertE4VerifierSurface() {
  if (!pathExists(verifyJsPath)) {
    return { ok: false, reason: FailureReason.WP10B_E4_VERIFIER_MISSING };
  }
  const text = fs.readFileSync(verifyJsPath, 'utf8');
  const need = [
    'verifyE4Evidence',
    'buildE4Fixture',
    'assertE4Fixtures',
    'E4_FIXTURE_NAMES',
    'blackScreen',
    'forgedPreviewReady',
  ];
  const missing = need.filter((t) => !text.includes(t));
  if (missing.length) {
    return {
      ok: false,
      reason: FailureReason.WP10B_E4_VERIFIER_MISSING,
      missing,
    };
  }
  return { ok: true };
}

function assertE4FixturesPresent() {
  const r = spawnSync('node', [verifyJsPath, '--e4-fixtures'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (r.status !== 0) {
    return {
      ok: false,
      reason: FailureReason.WP10B_E4_FIXTURES_MISSING,
      combined: `${r.stdout || ''}${r.stderr || ''}`,
    };
  }
  try {
    const data = JSON.parse((r.stdout || '').trim().split('\n').filter(Boolean).pop());
    if (!data.ok) {
      return { ok: false, reason: FailureReason.WP10B_E4_FIXTURES_MISSING, data };
    }
    return { ok: true, data };
  } catch (e) {
    return {
      ok: false,
      reason: FailureReason.WP10B_E4_FIXTURES_MISSING,
      message: String(e),
    };
  }
}

function assertParentChainSurfaces() {
  const runner = fs.readFileSync(runnerPath, 'utf8');
  // Soft capacity: evaluate path or documented parent fields for WP-10B.
  const markers = ['WP-10B', 'WP10B', 'evaluate_wp10b', 'e4Evidence', 'parentManifestSha256'];
  const hits = markers.filter((m) => runner.includes(m));
  if (hits.length < 3) {
    return {
      ok: false,
      reason: FailureReason.WP10B_PARENT_CHAIN_MISSING,
      hits,
    };
  }
  return { ok: true, hits };
}

function assertWp10bFullProductionCapacity() {
  const checks = [
    loadWp10bCatalogEntry(),
    assertE4VerifierSurface(),
    assertE4FixturesPresent(),
    assertParentChainSurfaces(),
  ];
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) {
    return { ok: false, failed, checks };
  }
  const entry = checks[0].entry;
  if (entry.weight !== 8 || entry.evidenceLevel !== 'E4') {
    return {
      ok: false,
      reason: FailureReason.WP10B_CATALOG_FIELD_MISSING,
      weight: entry.weight,
      evidenceLevel: entry.evidenceLevel,
    };
  }
  if (!(entry.requiredEffectiveDone || []).includes('WP-10A')) {
    return {
      ok: false,
      reason: FailureReason.WP10B_REQUIRED_DONE_MISSING,
      message: 'WP-10B must require WP-10A EffectiveDone',
    };
  }
  return { ok: true, entry };
}

function readWp10aDone() {
  if (!pathExists(wp10aTxnReceipt)) {
    return { ok: false, reason: FailureReason.WP10B_REQUIRED_DONE_MISSING };
  }
  const r = readJson(wp10aTxnReceipt);
  return {
    ok: r.EffectiveDone === true && r.state === 'DONE',
    EffectiveDone: r.EffectiveDone === true,
    state: r.state,
  };
}

module.exports = {
  repoRoot,
  runnerPath,
  catalogPath,
  schemaPath,
  verifyJsPath,
  TARGET_SERIAL,
  TARGET_USER,
  WP10B_E4_FAIL_FIXTURES,
  wp10aTxnReceipt,
  wp10bTxnReceipt,
  TASK_ID,
  EXPECTED_CURRENT_CORE_PROGRESS,
  EXPECTED_WEIGHT_FROM_PROGRESS_TABLE,
  EXPECTED_PROGRESS_WHEN_DONE,
  FailureReason,
  pathExists,
  readJson,
  runRunner,
  loadWp10bCatalogEntry,
  assertE4VerifierSurface,
  assertE4FixturesPresent,
  assertParentChainSurfaces,
  assertWp10bFullProductionCapacity,
  readWp10aDone,
};
