'use strict';

/**
 * Helpers for WP-02 / RED-01 contracts.
 *
 * Reads the authoritative catalog dynamically (never invents a task definition).
 * Production surfaces live under monorepo wallpaper-plugin/ only.
 * WallpaperEngine main / sandbox are never write targets.
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
const contextProviderPath = path.join(
  repoRoot,
  'android-car',
  'scripts',
  'wallpaper-task-context.js',
);

/** Production contract surface GREEN must add (Node facade over runtime gates). */
const runtimeContractPath = path.join(
  repoRoot,
  'android-car',
  'scripts',
  'wp02-runtime-contract.js',
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

const TASK_ID = 'WP-02';
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
 * Production path names — unified with wp02-runtime-contract.js (single source).
 * Fall back to frozen lists only if the production contract surface is absent.
 */
function loadContractConstants() {
  try {
    if (fs.existsSync(runtimeContractPath)) {
      // eslint-disable-next-line import/no-dynamic-require, global-require
      const contract = require(runtimeContractPath);
      return {
        production: Object.freeze([...(contract.REQUIRED_RUNTIME || [])]),
        unitTests: Object.freeze([...(contract.REQUIRED_UNIT_TESTS || [])]),
        manifestMarkers: Object.freeze([...(contract.MANIFEST_MARKERS || [])]),
      };
    }
  } catch {
    // fall through to frozen defaults
  }
  return {
    production: Object.freeze([
      'PluginControlProvider.kt',
      'CallerPolicy.kt',
      'RequestLedger.kt',
      'PluginOperationRepository.kt',
      'PluginRuntimeService.kt',
      'PluginActionActivity.kt',
    ]),
    unitTests: Object.freeze([
      'CallerPolicyTest.kt',
      'RequestLedgerTest.kt',
      'PluginOperationRepositoryTest.kt',
      'PluginControlProviderTest.kt',
    ]),
    manifestMarkers: Object.freeze([
      'com.motif.wallpaperengine.control',
      ':we_runtime',
      'PluginControlProvider',
      'PluginRuntimeService',
      'PluginActionActivity',
    ]),
  };
}

const _contractConstants = loadContractConstants();
const WP02_PRODUCTION_SOURCES = _contractConstants.production;
const WP02_UNIT_TEST_SOURCES = _contractConstants.unitTests;
const WP02_MANIFEST_MARKERS = _contractConstants.manifestMarkers;

/** WP-01 protocol surfaces that WP-02 consumes (must already exist post WP-01). */
const WP02_REQUIRED_INPUTS = Object.freeze([
  'PluginContract.kt',
  'PluginResult.kt',
]);

const FailureReason = Object.freeze({
  WP02_CATALOG_ENTRY_MISSING: 'WP02_CATALOG_ENTRY_MISSING',
  WP02_CATALOG_FIELD_MISSING: 'WP02_CATALOG_FIELD_MISSING',
  WP02_PRODUCTION_SURFACE_MISSING: 'WP02_PRODUCTION_SURFACE_MISSING',
  WP02_UNIT_TEST_MISSING: 'WP02_UNIT_TEST_MISSING',
  WP02_MANIFEST_RUNTIME_MISSING: 'WP02_MANIFEST_RUNTIME_MISSING',
  WP02_INPUT_MISSING: 'WP02_INPUT_MISSING',
  WP02_CONTRACT_SURFACE_MISSING: 'WP02_CONTRACT_SURFACE_MISSING',
  WP02_PREREQUISITE_NOT_DONE: 'WP02_PREREQUISITE_NOT_DONE',
  WP02_EFFECTIVE_DONE_FORGED: 'WP02_EFFECTIVE_DONE_FORGED',
  WP02_PROGRESS_FORGED: 'WP02_PROGRESS_FORGED',
  WP02_GATE_SKIPPED: 'WP02_GATE_SKIPPED',
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

function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

function sha256File(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
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

function androidManifestPath(cwd = repoRoot) {
  return path.join(pluginRoot(cwd), 'app', 'src', 'main', 'AndroidManifest.xml');
}

/**
 * Dynamically load WP-02 from authoritative catalog.
 * Never invents fields — missing entry is a production capacity gap.
 */
function loadWp02CatalogEntry(catalogFile = catalogPath) {
  if (!pathExists(catalogFile)) {
    return {
      ok: false,
      failureReason: FailureReason.WP02_CATALOG_ENTRY_MISSING,
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
      failureReason: FailureReason.WP02_CATALOG_ENTRY_MISSING,
      message: `catalog must contain exactly one ${TASK_ID} entry (found ${matches.length})`,
      task: null,
      taskCount: tasks.length,
      taskIds: tasks.map((t) => t && t.taskId).filter(Boolean),
    };
  }
  return { ok: true, task: matches[0], catalog };
}

/**
 * Extract structural fields only when catalog entry exists.
 * Returns fail-closed result if any required structural key is absent.
 */
function parseWp02CatalogIdentity(catalogFile = catalogPath) {
  const loaded = loadWp02CatalogEntry(catalogFile);
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
      failureReason: FailureReason.WP02_CATALOG_FIELD_MISSING,
      message: `WP-02 catalog missing fields: ${missing.join(',')}`,
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

/** Prerequisite EffectiveDone from real receipts (not caller claims). */
function readPrerequisiteDone() {
  const infra = readJson(finalInfraReceipt);
  const wp00 = readJson(wp00MergeReceipt);
  const wp01 = readJson(wp01TxnReceipt);
  const ok =
    infra.EffectiveGate === true &&
    infra.EffectiveDone === true &&
    infra.state === 'DONE' &&
    wp00.EffectiveDone === true &&
    wp01.EffectiveDone === true &&
    wp01.state === 'DONE' &&
    wp01.taskId === 'WP-01';
  return {
    ok,
    failureReason: ok ? null : FailureReason.WP02_PREREQUISITE_NOT_DONE,
    WP_INFRA: {
      EffectiveGate: infra.EffectiveGate,
      EffectiveDone: infra.EffectiveDone,
      state: infra.state,
    },
    'WP-00': { EffectiveDone: wp00.EffectiveDone, state: wp00.state },
    'WP-01': {
      EffectiveDone: wp01.EffectiveDone,
      state: wp01.state,
      taskId: wp01.taskId,
    },
  };
}

function listMissingProductionSources(cwd = repoRoot) {
  return WP02_PRODUCTION_SOURCES.filter(
    (name) => !pathExists(productionSourcePath(name, cwd)),
  );
}

function listMissingUnitTests(cwd = repoRoot) {
  return WP02_UNIT_TEST_SOURCES.filter(
    (name) => !pathExists(unitTestSourcePath(name, cwd)),
  );
}

function listMissingInputs(cwd = repoRoot) {
  return WP02_REQUIRED_INPUTS.filter(
    (name) => !pathExists(productionSourcePath(name, cwd)),
  );
}

function assertWp02ProductionSurfacesPresent(cwd = repoRoot) {
  const missing = listMissingProductionSources(cwd);
  if (missing.length) {
    return {
      ok: false,
      failureReason: FailureReason.WP02_PRODUCTION_SURFACE_MISSING,
      message: `WP-02 production sources not implemented: ${missing.join(', ')}`,
      missing,
      EffectiveDone: false,
    };
  }
  return { ok: true, missing: [], EffectiveDone: false };
}

function assertWp02UnitTestsPresent(cwd = repoRoot) {
  const missing = listMissingUnitTests(cwd);
  if (missing.length) {
    return {
      ok: false,
      failureReason: FailureReason.WP02_UNIT_TEST_MISSING,
      message: `WP-02 unit tests not present: ${missing.join(', ')}`,
      missing,
      EffectiveDone: false,
    };
  }
  return { ok: true, missing: [], EffectiveDone: false };
}

function assertWp02ManifestRuntime(cwd = repoRoot) {
  const manifest = androidManifestPath(cwd);
  if (!pathExists(manifest)) {
    return {
      ok: false,
      failureReason: FailureReason.WP02_MANIFEST_RUNTIME_MISSING,
      message: `AndroidManifest missing: ${manifest}`,
      missingMarkers: [...WP02_MANIFEST_MARKERS],
      EffectiveDone: false,
    };
  }
  const text = readText(manifest);
  const missingMarkers = WP02_MANIFEST_MARKERS.filter((m) => !text.includes(m));
  if (missingMarkers.length) {
    return {
      ok: false,
      failureReason: FailureReason.WP02_MANIFEST_RUNTIME_MISSING,
      message: `WP-02 :we_runtime manifest wiring missing: ${missingMarkers.join(', ')}`,
      missingMarkers,
      EffectiveDone: false,
    };
  }
  return { ok: true, missingMarkers: [], EffectiveDone: false };
}

function assertWp02RequiredInputs(cwd = repoRoot) {
  const missing = listMissingInputs(cwd);
  if (missing.length) {
    return {
      ok: false,
      failureReason: FailureReason.WP02_INPUT_MISSING,
      message: `WP-02 required inputs missing: ${missing.join(', ')}`,
      missing,
    };
  }
  return { ok: true, missing: [] };
}

function loadRuntimeContract() {
  if (!pathExists(runtimeContractPath)) {
    return null;
  }
  delete require.cache[require.resolve(runtimeContractPath)];
  return require(runtimeContractPath);
}

function requireRuntimeContract() {
  const surface = loadRuntimeContract();
  if (!surface) {
    const err = new Error(
      `${FailureReason.WP02_CONTRACT_SURFACE_MISSING}: ${runtimeContractPath}`,
    );
    err.failureReason = FailureReason.WP02_CONTRACT_SURFACE_MISSING;
    throw err;
  }
  return surface;
}

/**
 * Attempt to treat WP-02 as ready-to-done with caller-forged fields.
 * Must fail-closed via runner; never elevates EffectiveDone.
 */
function attemptCallerForgeEffectiveDone(receiptPath = wp02TxnReceipt) {
  const cas = runRunner([
    'receipt-cas',
    '--receipt',
    receiptPath,
    '--expected-revision',
    '1',
    '--expected-state',
    'INIT',
    '--state',
    'DONE',
    '--set-json',
    JSON.stringify({ EffectiveDone: true, coreProgressPercent: 18 }),
  ]);
  const verify = runRunner([
    'verify-done',
    '--task',
    TASK_ID,
    '--receipt',
    receiptPath,
  ]);
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
  };
}

function defaultDoneReceiptsWithForgedWp02() {
  return {
    ...defaultDoneReceipts(),
    // Caller may point at WP-02 receipt, but EffectiveDone must remain false.
    'WP-02': wp02TxnReceipt,
  };
}

function parseRunnerJson(result) {
  const text = (result.stdout || result.stderr || '').trim();
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

function makeTempReceiptDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wp02-red-'));
}

let resolveTaskContext = null;
try {
  ({ resolveTaskContext } = require(contextProviderPath));
} catch {
  resolveTaskContext = null;
}

module.exports = {
  repoRoot,
  runnerPath,
  catalogPath,
  schemaPath,
  catalogToolPath,
  contextProviderPath,
  runtimeContractPath,
  verificationRoot,
  bootstrapRoot,
  transactionsRoot,
  finalInfraReceipt,
  wp00MergeReceipt,
  wp01TxnReceipt,
  wp02TxnReceipt,
  TASK_ID,
  PLUGIN_ROOT_REL,
  WP02_PRODUCTION_SOURCES,
  WP02_UNIT_TEST_SOURCES,
  WP02_MANIFEST_MARKERS,
  WP02_REQUIRED_INPUTS,
  FailureReason,
  git,
  runPython,
  runRunner,
  readJson,
  pathExists,
  readText,
  sha256File,
  pluginRoot,
  productionSourcePath,
  unitTestSourcePath,
  androidManifestPath,
  loadWp02CatalogEntry,
  parseWp02CatalogIdentity,
  readPrerequisiteDone,
  listMissingProductionSources,
  listMissingUnitTests,
  listMissingInputs,
  assertWp02ProductionSurfacesPresent,
  assertWp02UnitTestsPresent,
  assertWp02ManifestRuntime,
  assertWp02RequiredInputs,
  loadRuntimeContract,
  requireRuntimeContract,
  attemptCallerForgeEffectiveDone,
  attemptSkipInfraGate,
  computeCoreProgress,
  defaultDoneReceipts,
  defaultDoneReceiptsWithForgedWp02,
  parseRunnerJson,
  makeTempReceiptDir,
  resolveTaskContext,
};
