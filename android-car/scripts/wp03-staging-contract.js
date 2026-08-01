'use strict';

/**
 * WP-03 staging / adapter contract surface (GREEN-03 / REFACTOR-03).
 *
 * Fail-closed Node facade over monorepo wallpaper-plugin staging surfaces,
 * catalog identity, FileProvider paths, and transaction receipts.
 * Caller claims for EffectiveDone / progress / REMOTE_VERIFIED / merged / proof
 * are never sources of truth.
 *
 * Public assert* APIs and failure signatures must remain stable across refactor.
 */

const fs = require('node:fs');
const path = require('node:path');

const SCRIPT_DIR = __dirname;
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const CATALOG = path.join(SCRIPT_DIR, 'wallpaper-plugin-tasks.json');

const VERIFICATION_ROOT = path.join(
  '/Users/anpple/Codex/Mineradio',
  'android-car',
  'verification',
  'wallpaper-plugin',
);
const TXN_ROOT = path.join(VERIFICATION_ROOT, 'transactions');
const BOOTSTRAP = path.join(VERIFICATION_ROOT, 'bootstrap');
const WP03_TXN = path.join(TXN_ROOT, 'wp-03.json');
const WP02_TXN = path.join(TXN_ROOT, 'wp-02.json');
const WP01_TXN = path.join(TXN_ROOT, 'wp-01.json');
const WP00_MERGE = path.join(BOOTSTRAP, 'WP-00-PR-MERGE-19.json');
const WP_INFRA_FINAL = path.join(BOOTSTRAP, 'WP-INFRA-FINAL-RECEIPT-17.json');

const REQUIRED_PRODUCTION = Object.freeze([
  'EngineAdapter.kt',
  'MpkgStager.kt',
  'StagingPolicy.kt',
]);

const REQUIRED_UNIT_TESTS = Object.freeze([
  'MpkgStagerTest.kt',
  'EngineAdapterTest.kt',
]);

const REQUIRED_TOKENS = Object.freeze({
  StagingPolicy: [
    'MAX_ENTRIES',
    'TOTAL_QUOTA_BYTES',
    'plugin_stage',
    'STAGING_QUOTA_EXCEEDED',
    'sanitizeDisplayName',
  ],
  MpkgStager: [
    'stage(',
    'sourceConsumed',
    '.part',
    'StagedMpkg',
    'SHA-256',
  ],
  EngineAdapter: [
    'createLaunchIntent',
    'FLAG_GRANT_READ_URI_PERMISSION',
    'BrowseActivity',
    'io.wallpaperengine.weclient',
    'resolveLaunch',
  ],
});

function fail(reason, message, extra = {}) {
  return {
    ok: false,
    failureReason: reason,
    message: message || reason,
    EffectiveDone: false,
    coreProgress: null,
    ...extra,
  };
}

function ok(extra = {}) {
  return { ok: true, EffectiveDone: false, ...extra };
}

function pathExists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

function pluginPkgDir(cwd, kind) {
  return path.join(
    cwd,
    'wallpaper-plugin',
    'app',
    'src',
    kind,
    'java',
    'com',
    'motif',
    'wallpaperengine',
    'plugin',
  );
}

function pluginMainSource(cwd, fileName) {
  return path.join(pluginPkgDir(cwd, 'main'), fileName);
}

function filePathsXml(cwd) {
  return path.join(
    cwd,
    'wallpaper-plugin',
    'app',
    'src',
    'main',
    'res',
    'xml',
    'file_paths.xml',
  );
}

function androidManifest(cwd) {
  return path.join(cwd, 'wallpaper-plugin', 'app', 'src', 'main', 'AndroidManifest.xml');
}

function missingNamedFiles(dir, names) {
  return names.filter((name) => !pathExists(path.join(dir, name)));
}

function loadWp03CatalogTask() {
  if (!pathExists(CATALOG)) {
    return fail('WP03_CATALOG_ENTRY_MISSING', `catalog missing: ${CATALOG}`);
  }
  const catalog = readJson(CATALOG);
  const tasks = (catalog.tasks || []).filter((t) => t && t.taskId === 'WP-03');
  if (tasks.length !== 1) {
    return fail(
      'WP03_CATALOG_ENTRY_MISSING',
      `expected exactly one WP-03, found ${tasks.length}`,
    );
  }
  return ok({ task: tasks[0], catalog });
}

function assertWp03StagingReady(options = {}) {
  const cwd = options.cwd || REPO_ROOT;
  const pluginPkg = pluginPkgDir(cwd, 'main');

  const missing = missingNamedFiles(pluginPkg, REQUIRED_PRODUCTION);
  if (missing.length) {
    return fail(
      'WP03_PRODUCTION_SURFACE_MISSING',
      `missing staging sources: ${missing.join(', ')}`,
      { missing },
    );
  }

  const pathsXml = filePathsXml(cwd);
  if (!pathExists(pathsXml)) {
    return fail('WP03_FILE_PATHS_MISSING', `file_paths.xml missing: ${pathsXml}`);
  }
  const pathsText = readText(pathsXml);
  if (!pathsText.includes('plugin_stage')) {
    return fail('WP03_FILE_PATHS_MISSING', 'file_paths.xml must expose plugin_stage');
  }

  const manifest = androidManifest(cwd);
  if (!pathExists(manifest)) {
    return fail('WP03_CONTRACT_SURFACE_MISSING', `manifest missing: ${manifest}`);
  }
  const manText = readText(manifest);
  if (!manText.includes('com.motif.wallpaperengine.files')) {
    return fail(
      'WP03_CONTRACT_SURFACE_MISSING',
      'manifest must register FileProvider authority com.motif.wallpaperengine.files',
    );
  }
  if (!manText.includes('@xml/file_paths') && !manText.includes('file_paths')) {
    return fail('WP03_FILE_PATHS_MISSING', 'manifest must reference file_paths');
  }

  const catalog = loadWp03CatalogTask();
  if (!catalog.ok) return catalog;
  if (catalog.task.weight !== 8) {
    return fail(
      'WP03_CATALOG_FIELD_MISSING',
      `WP-03 weight must be 8, got ${catalog.task.weight}`,
    );
  }
  if (catalog.task.evidenceLevel !== 'E1') {
    return fail(
      'WP03_CATALOG_FIELD_MISSING',
      `WP-03 evidenceLevel must be E1, got ${catalog.task.evidenceLevel}`,
    );
  }
  const requiredDone = catalog.task.requiredEffectiveDone || [];
  if (!requiredDone.includes('WP-02')) {
    return fail(
      'WP03_PREREQUISITE_NOT_DONE',
      'WP-03.requiredEffectiveDone must include WP-02',
    );
  }

  const missingTests = missingNamedFiles(pluginPkgDir(cwd, 'test'), REQUIRED_UNIT_TESTS);
  if (missingTests.length) {
    return fail(
      'WP03_UNIT_TEST_MISSING',
      `missing unit tests: ${missingTests.join(', ')}`,
      { missing: missingTests },
    );
  }

  for (const [name, tokens] of Object.entries(REQUIRED_TOKENS)) {
    const file = pluginMainSource(cwd, `${name}.kt`);
    const text = readText(file);
    for (const token of tokens) {
      if (!text.includes(token)) {
        return fail(
          'WP03_PRODUCTION_SURFACE_MISSING',
          `${name}.kt missing token: ${token}`,
        );
      }
    }
  }

  return ok({
    weight: catalog.task.weight,
    evidenceLevel: catalog.task.evidenceLevel,
    productionFiles: REQUIRED_PRODUCTION.length,
    unitTests: REQUIRED_UNIT_TESTS.length,
    stagingRoot: 'files/plugin_stage/',
    fileProviderAuthority: 'com.motif.wallpaperengine.files',
  });
}

function assertMpkgQuotaPolicy(options = {}) {
  const cwd = options.cwd || REPO_ROOT;
  const file = pluginMainSource(cwd, 'StagingPolicy.kt');
  if (!pathExists(file)) {
    return fail('WP03_PRODUCTION_SURFACE_MISSING', 'StagingPolicy.kt missing');
  }
  const text = readText(file);
  const required = [
    'MAX_ENTRIES = 8',
    'TOTAL_QUOTA_BYTES',
    'MIN_BYTES',
    'MAX_BYTES',
    'inFlight',
    'current',
  ];
  for (const token of required) {
    if (!text.includes(token)) {
      return fail('WP03_PRODUCTION_SURFACE_MISSING', `quota token missing: ${token}`);
    }
  }
  if (options.callerBypassQuota === true) {
    return fail('CALLER_FORGED_QUOTA', 'caller cannot bypass staging quota', {
      EffectiveDone: false,
    });
  }
  return ok({ quota: true, maxEntries: 8, totalQuotaGiB: 4 });
}

function assertSourceConsumedRevoke(options = {}) {
  const cwd = options.cwd || REPO_ROOT;
  const files = ['MpkgStager.kt', 'PluginControlProvider.kt', 'RequestLedger.kt'].map(
    (n) => pluginMainSource(cwd, n),
  );
  const combined = files
    .filter((f) => pathExists(f))
    .map((f) => readText(f))
    .join('\n');
  if (!combined.includes('sourceConsumed')) {
    return fail(
      'WP03_PRODUCTION_SURFACE_MISSING',
      'sourceConsumed token missing from production surfaces',
    );
  }
  if (options.callerClaimedRevoke === true) {
    return fail(
      'CALLER_FORGED_REVOKE',
      'caller cannot claim sourceUri revoke on behalf of Mineradio',
      { EffectiveDone: false },
    );
  }
  return ok({ sourceConsumed: true });
}

function assertEngineAdapterIntent(options = {}) {
  const cwd = options.cwd || REPO_ROOT;
  const file = pluginMainSource(cwd, 'EngineAdapter.kt');
  if (!pathExists(file)) {
    return fail('WP03_PRODUCTION_SURFACE_MISSING', 'EngineAdapter.kt missing');
  }
  const text = readText(file);
  const tokens = [
    'createLaunchIntent',
    'ACTION_VIEW',
    'FLAG_GRANT_READ_URI_PERMISSION',
    'io.wallpaperengine.weclient',
    'BrowseActivity',
  ];
  for (const token of tokens) {
    if (!text.includes(token)) {
      return fail(
        'WP03_PRODUCTION_SURFACE_MISSING',
        `EngineAdapter missing token: ${token}`,
      );
    }
  }
  if (
    text.includes('FLAG_ACTIVITY_CLEAR_TASK') &&
    /addFlags\s*\([^)]*FLAG_ACTIVITY_CLEAR_TASK|FLAG_ACTIVITY_CLEAR_TASK\s*\)/.test(text)
  ) {
    return fail(
      'WP03_PRODUCTION_SURFACE_MISSING',
      'EngineAdapter must not use FLAG_ACTIVITY_CLEAR_TASK',
    );
  }
  if (options.callerForcedPreviewReady === true) {
    return fail(
      'CALLER_FORGED_PREVIEW',
      'caller cannot force PREVIEW_READY',
      { EffectiveDone: false },
    );
  }
  return ok({ engineAdapter: true });
}

/**
 * Refuse caller-injected WP-03 DONE / progress. Reads real receipt only.
 */
function assertWp03NotDone(options = {}) {
  const receiptPath = options.transactionFile || options.receiptPath || WP03_TXN;

  if (options.claimedEffectiveDone === true) {
    return fail(
      'WP03_EFFECTIVE_DONE_FORGED',
      'caller cannot inject EffectiveDone=true',
      { EffectiveDone: false, coreProgress: 0 },
    );
  }
  if (
    options.claimedCoreProgress != null &&
    options.claimedCoreProgress !== 18 &&
    options.claimedCoreProgress > 18
  ) {
    return fail(
      'WP03_PROGRESS_FORGED',
      'caller cannot elevate core progress above live receipts',
      { EffectiveDone: false },
    );
  }

  if (!pathExists(receiptPath)) {
    return fail('MISSING_RECEIPT', `WP-03 receipt missing: ${receiptPath}`, {
      EffectiveDone: false,
      coreProgress: 0,
    });
  }

  const receipt = readJson(receiptPath);
  if (receipt.taskId !== 'WP-03') {
    return fail('ILLEGAL_STATE', `receipt taskId ${receipt.taskId} != WP-03`, {
      EffectiveDone: false,
    });
  }
  if (receipt.EffectiveDone === true || receipt.state === 'DONE') {
    return fail(
      'WP03_EFFECTIVE_DONE_FORGED',
      'WP-03 EffectiveDone/state DONE is illegal without verify-done',
      { EffectiveDone: false, coreProgress: 0 },
    );
  }

  const forgedKeys = ['REMOTE_VERIFIED', 'merged', 'mergeSha', 'proof'];
  if (options.callerClaims && typeof options.callerClaims === 'object') {
    for (const key of forgedKeys) {
      if (options.callerClaims[key] != null) {
        return fail(
          'CALLER_FORGED_REMOTE_FACT',
          `caller cannot inject ${key}`,
          { EffectiveDone: false, coreProgress: 0 },
        );
      }
    }
  }

  return ok({
    EffectiveDone: false,
    state: receipt.state,
    receiptPath,
  });
}

function assertWp03Prerequisites(options = {}) {
  try {
    const infra = readJson(options.infraReceipt || WP_INFRA_FINAL);
    const wp00 = readJson(options.wp00Receipt || WP00_MERGE);
    const wp01 = readJson(options.wp01Receipt || WP01_TXN);
    const wp02 = readJson(options.wp02Receipt || WP02_TXN);
    if (infra.EffectiveGate !== true || infra.EffectiveDone !== true) {
      return fail('WP03_PREREQUISITE_NOT_DONE', 'WP-INFRA not EffectiveDone/Gate');
    }
    if (wp00.EffectiveDone !== true) {
      return fail('WP03_PREREQUISITE_NOT_DONE', 'WP-00 not EffectiveDone');
    }
    if (wp01.EffectiveDone !== true) {
      return fail('WP03_PREREQUISITE_NOT_DONE', 'WP-01 not EffectiveDone');
    }
    if (wp02.EffectiveDone !== true || wp02.state !== 'DONE') {
      return fail('WP03_PREREQUISITE_NOT_DONE', 'WP-02 not EffectiveDone');
    }
    return ok({
      WP_INFRA: true,
      'WP-00': true,
      'WP-01': true,
      'WP-02': true,
    });
  } catch (err) {
    return fail('WP03_PREREQUISITE_NOT_DONE', String(err && err.message));
  }
}

module.exports = {
  assertWp03StagingReady,
  assertMpkgQuotaPolicy,
  assertSourceConsumedRevoke,
  assertEngineAdapterIntent,
  assertWp03NotDone,
  assertWp03Prerequisites,
  loadWp03CatalogTask,
  REQUIRED_PRODUCTION,
  REQUIRED_UNIT_TESTS,
  WP03_TXN,
  REPO_ROOT,
};
