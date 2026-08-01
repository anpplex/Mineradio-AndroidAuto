'use strict';

/**
 * Helpers for WP-03 / RED-01 contracts.
 *
 * Catalog fields are read dynamically (never invent a task definition).
 * Production surfaces live under monorepo wallpaper-plugin/ only.
 * Spec sources (read-only, not authored here):
 *   - WALLPAPER-PLUGIN-PROGRESS: weight 8%, E1, staging/配额/URI
 *   - WALLPAPER-PLUGIN-DEVELOPMENT Task 3: EngineAdapter/MpkgStager/StagingPolicy
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
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
const catalogToolPath = path.join(
  repoRoot,
  'android-car',
  'scripts',
  'generate-wallpaper-task-catalog.py',
);

/** GREEN must add Node facade for staging/adapter gates. */
const stagingContractPath = path.join(
  repoRoot,
  'android-car',
  'scripts',
  'wp03-staging-contract.js',
);

const verificationRoot = path.join(
  '/Users/anpple/Codex/Mineradio',
  'android-car',
  'verification',
  'wallpaper-plugin',
);
const bootstrapRoot = path.join(verificationRoot, 'bootstrap');
const transactionsRoot = path.join(verificationRoot, 'transactions');

const finalInfraReceipt = path.join(bootstrapRoot, 'WP-INFRA-FINAL-RECEIPT-17.json');
const wp00MergeReceipt = path.join(bootstrapRoot, 'WP-00-PR-MERGE-19.json');
const wp01TxnReceipt = path.join(transactionsRoot, 'wp-01.json');
const wp02TxnReceipt = path.join(transactionsRoot, 'wp-02.json');
const wp03TxnReceipt = path.join(transactionsRoot, 'wp-03.json');

const TASK_ID = 'WP-03';
const PLUGIN_ROOT_REL = 'wallpaper-plugin';
const PLUGIN_PKG_SEGMENTS = [
  'app',
  'src',
  'main',
  'java',
  'com',
  'motif',
  'wallpaperengine',
  'plugin',
];
const PLUGIN_TEST_SEGMENTS = [
  'app',
  'src',
  'test',
  'java',
  'com',
  'motif',
  'wallpaperengine',
  'plugin',
];

/**
 * Production outputs from DEVELOPMENT Task 3, remapped to monorepo wallpaper-plugin/.
 * Paths only — not invented catalog fields.
 */
const WP03_PRODUCTION_SOURCES = Object.freeze([
  'EngineAdapter.kt',
  'MpkgStager.kt',
  'StagingPolicy.kt',
]);

const WP03_UNIT_TEST_SOURCES = Object.freeze([
  'MpkgStagerTest.kt',
  'EngineAdapterTest.kt',
]);

/** WP-02 surfaces WP-03 consumes (must exist post WP-02). */
const WP03_REQUIRED_INPUTS = Object.freeze([
  'PluginContract.kt',
  'PluginResult.kt',
  'PluginRuntimeService.kt',
  'PluginActionActivity.kt',
  'PluginOperationRepository.kt',
]);

const FailureReason = Object.freeze({
  WP03_CATALOG_ENTRY_MISSING: 'WP03_CATALOG_ENTRY_MISSING',
  WP03_CATALOG_FIELD_MISSING: 'WP03_CATALOG_FIELD_MISSING',
  WP03_PRODUCTION_SURFACE_MISSING: 'WP03_PRODUCTION_SURFACE_MISSING',
  WP03_UNIT_TEST_MISSING: 'WP03_UNIT_TEST_MISSING',
  WP03_CONTRACT_SURFACE_MISSING: 'WP03_CONTRACT_SURFACE_MISSING',
  WP03_FILE_PATHS_MISSING: 'WP03_FILE_PATHS_MISSING',
  WP03_INPUT_MISSING: 'WP03_INPUT_MISSING',
  WP03_PREREQUISITE_NOT_DONE: 'WP03_PREREQUISITE_NOT_DONE',
  WP03_EFFECTIVE_DONE_FORGED: 'WP03_EFFECTIVE_DONE_FORGED',
  WP03_PROGRESS_FORGED: 'WP03_PROGRESS_FORGED',
  WP03_GATE_SKIPPED: 'WP03_GATE_SKIPPED',
  CALLER_DECLARED_DONE: 'CALLER_DECLARED_DONE',
  FAIL_CLOSED: 'FAIL_CLOSED',
});

function git(args, cwd = repoRoot) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return {
    status: result.status === null ? 1 : result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
    combined: `${result.stdout || ''}\n${result.stderr || ''}`,
  };
}

function runPython(scriptPath, args, options = {}) {
  const result = spawnSync('python3', [scriptPath, ...args], {
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

function runRunner(args, options = {}) {
  return runPython(runnerPath, args, options);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function pathExists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function liveAuthoritativeBaseSha(cwd = repoRoot) {
  const r = git(['ls-remote', '--refs', 'origin', 'refs/heads/huawei-android12-car'], cwd);
  if (r.status !== 0) throw new Error(`ls-remote failed: ${r.stderr || r.stdout}`);
  const sha = (r.stdout.split(/\s+/)[0] || '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`invalid ls-remote base: ${r.stdout}`);
  return sha;
}

function pluginRoot(cwd = repoRoot) {
  return path.join(cwd, PLUGIN_ROOT_REL);
}

function productionSourcePath(fileName, cwd = repoRoot) {
  return path.join(pluginRoot(cwd), ...PLUGIN_PKG_SEGMENTS, fileName);
}

function unitTestSourcePath(fileName, cwd = repoRoot) {
  return path.join(pluginRoot(cwd), ...PLUGIN_TEST_SEGMENTS, fileName);
}

function filePathsXml(cwd = repoRoot) {
  return path.join(pluginRoot(cwd), 'app', 'src', 'main', 'res', 'xml', 'file_paths.xml');
}

function loadWp03CatalogEntry(catalogFile = catalogPath) {
  if (!pathExists(catalogFile)) {
    return {
      ok: false,
      failureReason: FailureReason.WP03_CATALOG_ENTRY_MISSING,
      message: `catalog file missing: ${catalogFile}`,
      task: null,
    };
  }
  const catalog = readJson(catalogFile);
  const tasks = Array.isArray(catalog.tasks) ? catalog.tasks : [];
  const matches = tasks.filter((t) => t && t.taskId === TASK_ID);
  if (matches.length !== 1) {
    return {
      ok: false,
      failureReason: FailureReason.WP03_CATALOG_ENTRY_MISSING,
      message: `catalog must contain exactly one ${TASK_ID} entry (found ${matches.length})`,
      task: null,
      taskCount: tasks.length,
      taskIds: tasks.map((t) => t && t.taskId).filter(Boolean),
    };
  }
  return { ok: true, task: matches[0], catalog };
}

function parseWp03CatalogIdentity(catalogFile = catalogPath) {
  const loaded = loadWp03CatalogEntry(catalogFile);
  if (!loaded.ok) return loaded;
  const task = loaded.task;
  const required = [
    'taskId',
    'weight',
    'scopeCheck',
    'dependsOn',
    'requiredEffectiveDone',
    'evidenceLevel',
    'phaseCommands',
    'expectedExit',
    'failureSignaturePolicy',
  ];
  const missing = required.filter((k) => task[k] === undefined || task[k] === null);
  if (missing.length) {
    return {
      ok: false,
      failureReason: FailureReason.WP03_CATALOG_FIELD_MISSING,
      message: `WP-03 catalog missing fields: ${missing.join(',')}`,
      task,
      missing,
    };
  }
  return {
    ok: true,
    taskId: task.taskId,
    weight: task.weight,
    scopeCheck: task.scopeCheck,
    dependsOn: task.dependsOn,
    requiredEffectiveDone: task.requiredEffectiveDone,
    evidenceLevel: task.evidenceLevel,
    phaseCommands: task.phaseCommands,
    expectedExit: task.expectedExit,
    failureSignaturePolicy: task.failureSignaturePolicy,
    product: task.product,
    path: task.path,
    task,
  };
}

function readPrerequisiteDone() {
  const infra = readJson(finalInfraReceipt);
  const wp00 = readJson(wp00MergeReceipt);
  const wp01 = readJson(wp01TxnReceipt);
  const wp02 = readJson(wp02TxnReceipt);
  const ok =
    infra.EffectiveGate === true &&
    infra.EffectiveDone === true &&
    infra.state === 'DONE' &&
    wp00.EffectiveDone === true &&
    wp01.EffectiveDone === true &&
    wp01.state === 'DONE' &&
    wp02.EffectiveDone === true &&
    wp02.state === 'DONE' &&
    wp02.taskId === 'WP-02';
  return {
    ok,
    failureReason: ok ? null : FailureReason.WP03_PREREQUISITE_NOT_DONE,
    WP_INFRA: {
      EffectiveGate: infra.EffectiveGate,
      EffectiveDone: infra.EffectiveDone,
      state: infra.state,
    },
    'WP-00': { EffectiveDone: wp00.EffectiveDone },
    'WP-01': { EffectiveDone: wp01.EffectiveDone, state: wp01.state },
    'WP-02': { EffectiveDone: wp02.EffectiveDone, state: wp02.state },
  };
}

function listMissingProductionSources(cwd = repoRoot) {
  return WP03_PRODUCTION_SOURCES.filter((n) => !pathExists(productionSourcePath(n, cwd)));
}

function listMissingUnitTests(cwd = repoRoot) {
  return WP03_UNIT_TEST_SOURCES.filter((n) => !pathExists(unitTestSourcePath(n, cwd)));
}

function listMissingInputs(cwd = repoRoot) {
  return WP03_REQUIRED_INPUTS.filter((n) => !pathExists(productionSourcePath(n, cwd)));
}

function assertWp03ProductionSurfacesPresent(cwd = repoRoot) {
  const missing = listMissingProductionSources(cwd);
  if (missing.length) {
    return {
      ok: false,
      failureReason: FailureReason.WP03_PRODUCTION_SURFACE_MISSING,
      message: `WP-03 production sources not implemented: ${missing.join(', ')}`,
      missing,
      EffectiveDone: false,
    };
  }
  return { ok: true, missing: [], EffectiveDone: false };
}

function assertWp03UnitTestsPresent(cwd = repoRoot) {
  const missing = listMissingUnitTests(cwd);
  if (missing.length) {
    return {
      ok: false,
      failureReason: FailureReason.WP03_UNIT_TEST_MISSING,
      message: `WP-03 unit tests not present: ${missing.join(', ')}`,
      missing,
      EffectiveDone: false,
    };
  }
  return { ok: true, missing: [], EffectiveDone: false };
}

function assertWp03FilePathsPresent(cwd = repoRoot) {
  const p = filePathsXml(cwd);
  if (!pathExists(p)) {
    return {
      ok: false,
      failureReason: FailureReason.WP03_FILE_PATHS_MISSING,
      message: `FileProvider paths missing: ${p}`,
      EffectiveDone: false,
    };
  }
  return { ok: true, EffectiveDone: false };
}

function assertWp03RequiredInputs(cwd = repoRoot) {
  const missing = listMissingInputs(cwd);
  if (missing.length) {
    return {
      ok: false,
      failureReason: FailureReason.WP03_INPUT_MISSING,
      message: `WP-03 required inputs missing: ${missing.join(', ')}`,
      missing,
    };
  }
  return { ok: true, missing: [] };
}

function loadStagingContract() {
  if (!pathExists(stagingContractPath)) return null;
  delete require.cache[require.resolve(stagingContractPath)];
  return require(stagingContractPath);
}

function attemptCallerForgeEffectiveDone(receiptPath = wp03TxnReceipt) {
  const current = pathExists(receiptPath) ? readJson(receiptPath) : { revision: 1, state: 'INIT' };
  const cas = runRunner([
    'receipt-cas',
    '--receipt',
    receiptPath,
    '--expected-revision',
    String(current.revision || 1),
    '--expected-state',
    String(current.state || 'INIT'),
    '--state',
    'DONE',
    '--set-json',
    JSON.stringify({ EffectiveDone: true, coreProgressPercent: 26 }),
  ]);
  const verify = runRunner(['verify-done', '--task', TASK_ID, '--receipt', receiptPath]);
  const declare = runRunner([
    'assert-state',
    '--task',
    TASK_ID,
    '--declare-done',
    '--transactions',
    transactionsRoot,
  ]);
  const casState = runRunner([
    'cas-state',
    '--task',
    TASK_ID,
    '--to',
    'DONE',
    '--transactions',
    transactionsRoot,
  ]);
  return { cas, verify, declare, casState };
}

function attemptSkipInfraGate() {
  return runRunner([
    'assert-ready',
    '--task',
    TASK_ID,
    '--infra-effective-gate',
    'false',
  ]);
}

function computeCoreProgress(doneMap) {
  return runRunner([
    'compute-core-progress',
    '--done-receipts-json',
    JSON.stringify(doneMap),
  ]);
}

function defaultDoneReceipts() {
  return {
    'WP-00': wp00MergeReceipt,
    'WP-01': wp01TxnReceipt,
    'WP-02': wp02TxnReceipt,
  };
}

function defaultDoneReceiptsWithForgedWp03() {
  return {
    ...defaultDoneReceipts(),
    'WP-03': wp03TxnReceipt,
  };
}

function parseRunnerJson(result) {
  const text = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  const lines = text.split(/\n+/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // continue
    }
  }
  return null;
}

/**
 * Spec-derived acceptance tokens for GREEN (not catalog fields).
 * Progress table: 8% E1; Task 3: staging quota, sourceConsumed, WE adapter.
 */
const WP03_SPEC_ACCEPTANCE = Object.freeze({
  weightPercentFromProgressTable: 8,
  evidenceLevelFromProgressTable: 'E1',
  milestone:
    '.mpkg 配额 staging、sourceConsumed 撤权闭环和官方 WE adapter',
  productionTypes: WP03_PRODUCTION_SOURCES,
  unitTests: WP03_UNIT_TEST_SOURCES,
  stagingRootHint: 'files/plugin_stage/',
  maxEntries: 8,
  totalQuotaGiB: 4,
  enginePackage: 'io.wallpaperengine.weclient',
  engineBrowseActivity: 'io.wallpaperengine.weclient.BrowseActivity',
});

module.exports = {
  repoRoot,
  runnerPath,
  catalogPath,
  schemaPath,
  catalogToolPath,
  stagingContractPath,
  verificationRoot,
  bootstrapRoot,
  transactionsRoot,
  finalInfraReceipt,
  wp00MergeReceipt,
  wp01TxnReceipt,
  wp02TxnReceipt,
  wp03TxnReceipt,
  TASK_ID,
  PLUGIN_ROOT_REL,
  WP03_PRODUCTION_SOURCES,
  WP03_UNIT_TEST_SOURCES,
  WP03_REQUIRED_INPUTS,
  WP03_SPEC_ACCEPTANCE,
  FailureReason,
  git,
  runPython,
  runRunner,
  readJson,
  pathExists,
  sha256File,
  liveAuthoritativeBaseSha,
  pluginRoot,
  productionSourcePath,
  unitTestSourcePath,
  filePathsXml,
  loadWp03CatalogEntry,
  parseWp03CatalogIdentity,
  readPrerequisiteDone,
  listMissingProductionSources,
  listMissingUnitTests,
  listMissingInputs,
  assertWp03ProductionSurfacesPresent,
  assertWp03UnitTestsPresent,
  assertWp03FilePathsPresent,
  assertWp03RequiredInputs,
  loadStagingContract,
  attemptCallerForgeEffectiveDone,
  attemptSkipInfraGate,
  computeCoreProgress,
  defaultDoneReceipts,
  defaultDoneReceiptsWithForgedWp03,
  parseRunnerJson,
};
