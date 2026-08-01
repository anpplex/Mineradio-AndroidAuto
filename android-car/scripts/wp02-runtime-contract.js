'use strict';

/**
 * WP-02 runtime contract surface (GREEN-02).
 *
 * Fail-closed Node facade over monorepo wallpaper-plugin runtime surfaces,
 * catalog identity, and transaction receipts. Does not create a second
 * EffectiveDone / progress truth — only verifies real files + runner facts.
 *
 * Caller claims for EffectiveDone, coreProgress, REMOTE_VERIFIED, merged, or
 * proof are never accepted as sources of truth.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const SCRIPT_DIR = __dirname;
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const RUNNER = path.join(SCRIPT_DIR, 'wallpaper-task.py');
const CATALOG = path.join(SCRIPT_DIR, 'wallpaper-plugin-tasks.json');
const SCHEMA = path.join(SCRIPT_DIR, 'wallpaper-task.schema.json');

const VERIFICATION_ROOT = path.join(
  '/Users/anpple/Codex/Mineradio',
  'android-car',
  'verification',
  'wallpaper-plugin',
);
const TXN_ROOT = path.join(VERIFICATION_ROOT, 'transactions');
const BOOTSTRAP = path.join(VERIFICATION_ROOT, 'bootstrap');
const WP02_TXN = path.join(TXN_ROOT, 'wp-02.json');
const WP01_TXN = path.join(TXN_ROOT, 'wp-01.json');
const WP00_MERGE = path.join(BOOTSTRAP, 'WP-00-PR-MERGE-19.json');
const WP_INFRA_FINAL = path.join(BOOTSTRAP, 'WP-INFRA-FINAL-RECEIPT-17.json');

const PLUGIN_ROOT = path.join(REPO_ROOT, 'wallpaper-plugin');
const PLUGIN_PKG = path.join(
  PLUGIN_ROOT,
  'app',
  'src',
  'main',
  'java',
  'com',
  'motif',
  'wallpaperengine',
  'plugin',
);
const MANIFEST = path.join(
  PLUGIN_ROOT,
  'app',
  'src',
  'main',
  'AndroidManifest.xml',
);

const REQUIRED_RUNTIME = Object.freeze([
  'PluginControlProvider.kt',
  'CallerPolicy.kt',
  'RequestLedger.kt',
  'PluginOperationRepository.kt',
  'PluginRuntimeService.kt',
  'PluginActionActivity.kt',
]);

const REQUIRED_UNIT_TESTS = Object.freeze([
  'CallerPolicyTest.kt',
  'RequestLedgerTest.kt',
  'PluginOperationRepositoryTest.kt',
  'PluginControlProviderTest.kt',
]);

const MANIFEST_MARKERS = Object.freeze([
  'com.motif.wallpaperengine.control',
  ':we_runtime',
  'PluginControlProvider',
  'PluginRuntimeService',
  'PluginActionActivity',
]);

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

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function runRunner(args) {
  const result = spawnSync('python3', [RUNNER, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return {
    status: result.status === null ? 1 : result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    combined: `${result.stdout || ''}\n${result.stderr || ''}`,
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

function loadWp02CatalogTask() {
  if (!pathExists(CATALOG)) {
    return fail('WP02_CATALOG_ENTRY_MISSING', `catalog missing: ${CATALOG}`);
  }
  const catalog = readJson(CATALOG);
  const matches = (catalog.tasks || []).filter((t) => t && t.taskId === 'WP-02');
  if (matches.length !== 1) {
    return fail(
      'WP02_CATALOG_ENTRY_MISSING',
      `catalog must contain exactly one WP-02 entry (found ${matches.length})`,
    );
  }
  return ok({ task: matches[0], catalog });
}

/**
 * Assert monorepo runtime sources + manifest markers exist (GREEN capacity).
 */
function pluginPkgDir(cwd, kind /* 'main' | 'test' */) {
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

function missingNamedFiles(dir, names) {
  return names.filter((name) => !pathExists(path.join(dir, name)));
}

function assertWp02RuntimeReady(options = {}) {
  const cwd = options.cwd || REPO_ROOT;
  const pluginPkg = pluginPkgDir(cwd, 'main');
  const manifest = path.join(
    cwd,
    'wallpaper-plugin',
    'app',
    'src',
    'main',
    'AndroidManifest.xml',
  );

  const missing = missingNamedFiles(pluginPkg, REQUIRED_RUNTIME);
  if (missing.length) {
    return fail(
      'WP02_PRODUCTION_SURFACE_MISSING',
      `missing runtime sources: ${missing.join(', ')}`,
      { missing },
    );
  }

  if (!pathExists(manifest)) {
    return fail('WP02_MANIFEST_RUNTIME_MISSING', `manifest missing: ${manifest}`);
  }
  const text = readText(manifest);
  const missingMarkers = MANIFEST_MARKERS.filter((m) => !text.includes(m));
  if (missingMarkers.length) {
    return fail(
      'WP02_MANIFEST_RUNTIME_MISSING',
      `manifest markers missing: ${missingMarkers.join(', ')}`,
      { missingMarkers },
    );
  }

  const catalog = loadWp02CatalogTask();
  if (!catalog.ok) return catalog;
  if (catalog.task.weight !== 8) {
    return fail(
      'WP02_CATALOG_FIELD_MISSING',
      `WP-02 weight must be 8 (from frozen progress table), got ${catalog.task.weight}`,
    );
  }
  if (catalog.task.evidenceLevel !== 'E1') {
    return fail(
      'WP02_CATALOG_FIELD_MISSING',
      `WP-02 evidenceLevel must be E1, got ${catalog.task.evidenceLevel}`,
    );
  }
  const requiredDone = catalog.task.requiredEffectiveDone || [];
  if (!requiredDone.includes('WP-01')) {
    return fail(
      'WP02_PREREQUISITE_NOT_DONE',
      'WP-02.requiredEffectiveDone must include WP-01',
    );
  }

  const missingTests = missingNamedFiles(pluginPkgDir(cwd, 'test'), REQUIRED_UNIT_TESTS);
  if (missingTests.length) {
    return fail(
      'WP02_UNIT_TEST_MISSING',
      `missing unit tests: ${missingTests.join(', ')}`,
      { missing: missingTests },
    );
  }

  return ok({
    weight: catalog.task.weight,
    evidenceLevel: catalog.task.evidenceLevel,
    runtimeFiles: REQUIRED_RUNTIME.length,
    unitTests: REQUIRED_UNIT_TESTS.length,
    manifestMarkers: MANIFEST_MARKERS.length,
  });
}

/**
 * claimLaunch contract: repository source must expose atomic lease API surface.
 * Pure static check — no caller-forged lease state accepted.
 */
function pluginMainSource(cwd, fileName) {
  return path.join(
    cwd,
    'wallpaper-plugin',
    'app',
    'src',
    'main',
    'java',
    'com',
    'motif',
    'wallpaperengine',
    'plugin',
    fileName,
  );
}

function requireSourceTokens(file, tokens, failureReason) {
  if (!pathExists(file)) {
    return fail(
      'WP02_PRODUCTION_SURFACE_MISSING',
      `missing source: ${path.basename(file)}`,
    );
  }
  const text = readText(file);
  for (const token of tokens) {
    if (!text.includes(token)) {
      return fail(failureReason, `${path.basename(file)} missing token: ${token}`);
    }
  }
  return ok({ text });
}

function assertClaimLaunchAtomic(options = {}) {
  const cwd = options.cwd || REPO_ROOT;
  const file = pluginMainSource(cwd, 'PluginOperationRepository.kt');
  const tokens = requireSourceTokens(
    file,
    ['claimLaunch', 'actionEpoch', 'ownerNonce', 'lease'],
    'WP02_CLAIM_LAUNCH_INCOMPLETE',
  );
  if (!tokens.ok) return tokens;
  // Caller cannot inject claim success
  if (options.callerClaimedLease === true) {
    return fail(
      'CALLER_FORGED_LEASE',
      'caller cannot declare claimLaunch success',
      { EffectiveDone: false },
    );
  }
  return ok({ claimLaunch: true });
}

/**
 * PendingIntent one-shot / immutable uniqueness surface in production sources.
 */
function assertPendingIntentOneShot(options = {}) {
  const cwd = options.cwd || REPO_ROOT;
  const files = [
    'PluginControlProvider.kt',
    'PluginActionActivity.kt',
    'PluginOperationRepository.kt',
  ].map((name) => pluginMainSource(cwd, name));
  const combined = files
    .filter((f) => pathExists(f))
    .map((f) => readText(f))
    .join('\n');
  if (!combined) {
    return fail('WP02_PRODUCTION_SURFACE_MISSING', 'no PendingIntent surface sources');
  }
  const required = [
    'FLAG_ONE_SHOT',
    'FLAG_IMMUTABLE',
    'FLAG_UPDATE_CURRENT',
    'motif-we-action://',
  ];
  for (const token of required) {
    if (!combined.includes(token)) {
      return fail(
        'WP02_PENDING_INTENT_INCOMPLETE',
        `PendingIntent contract token missing: ${token}`,
      );
    }
  }
  return ok({ pendingIntent: true });
}

/**
 * Caller policy surface: package + cert allowlist, shell debug-only.
 */
function assertCallerPolicy(options = {}) {
  const cwd = options.cwd || REPO_ROOT;
  const file = pluginMainSource(cwd, 'CallerPolicy.kt');
  if (!pathExists(file)) {
    return fail('WP02_PRODUCTION_SURFACE_MISSING', 'CallerPolicy.kt missing');
  }
  const text = readText(file);
  const lower = text.toLowerCase();
  const required = [
    { token: 'com.mineradio.app', match: () => text.includes('com.mineradio.app') },
    {
      token: 'com.motif.wallpaperengine',
      match: () => text.includes('com.motif.wallpaperengine'),
    },
    {
      token: 'CALLER_REJECTED',
      match: () => text.includes('CALLER_REJECTED'),
    },
    {
      token: 'shell',
      match: () => lower.includes('shell'),
    },
    {
      token: 'cert',
      match: () =>
        lower.includes('cert') || text.includes('Sha256') || text.includes('certificate'),
    },
  ];
  for (const item of required) {
    if (!item.match()) {
      return fail(
        'WP02_CALLER_POLICY_INCOMPLETE',
        `CallerPolicy missing token: ${item.token}`,
      );
    }
  }
  // Forged allow-all from caller rejected
  if (options.callerAllowAll === true) {
    return fail(
      'CALLER_FORGED_POLICY',
      'caller cannot force allow-all caller policy',
      { EffectiveDone: false },
    );
  }
  return ok({ callerPolicy: true });
}

/**
 * Refuse caller-injected WP-02 DONE / progress. Reads real receipt only.
 */
function assertWp02NotDone(options = {}) {
  const receiptPath = options.transactionFile || options.receiptPath || WP02_TXN;

  // Caller claims are never sources of truth — reject elevation attempts first.
  if (options.claimedEffectiveDone === true) {
    return fail(
      'WP02_EFFECTIVE_DONE_FORGED',
      'caller cannot inject EffectiveDone=true',
      { EffectiveDone: false, coreProgress: 0 },
    );
  }
  if (options.claimedCoreProgress != null && options.claimedCoreProgress !== 10) {
    // Non-authoritative progress claim is ignored for truth; only reject elevation above live.
    // Live progress is still computed from receipts below.
  }

  if (!pathExists(receiptPath)) {
    return fail('MISSING_RECEIPT', `WP-02 receipt missing: ${receiptPath}`, {
      EffectiveDone: false,
      coreProgress: 0,
    });
  }

  const receipt = readJson(receiptPath);
  if (receipt.taskId !== 'WP-02') {
    return fail('ILLEGAL_STATE', `receipt taskId ${receipt.taskId} != WP-02`, {
      EffectiveDone: false,
    });
  }
  if (receipt.EffectiveDone === true || receipt.state === 'DONE') {
    return fail(
      'WP02_EFFECTIVE_DONE_FORGED',
      'WP-02 EffectiveDone/state DONE is illegal without verify-done',
      { EffectiveDone: false, coreProgress: 0 },
    );
  }

  // Reject caller-forged remote facts if presented
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

  const progress = computeCoreProgressFromReceipts(options.doneReceipts);
  return ok({
    EffectiveDone: false,
    coreProgress: progress,
    state: receipt.state,
    receiptPath,
  });
}

function computeCoreProgressFromReceipts(doneReceipts) {
  const map = doneReceipts || {
    'WP-00': WP00_MERGE,
    'WP-01': WP01_TXN,
    'WP-02': WP02_TXN,
  };
  const result = runRunner([
    'compute-core-progress',
    '--done-receipts-json',
    JSON.stringify(map),
  ]);
  const body = parseRunnerJson(result);
  if (!body || body.ok !== true) return null;
  return body.coreProgressPercent;
}

/**
 * Prerequisites: WP-INFRA / WP-00 / WP-01 EffectiveDone from real receipts.
 */
function assertWp02Prerequisites(options = {}) {
  const infraPath = options.infraReceipt || WP_INFRA_FINAL;
  const wp00Path = options.wp00Receipt || WP00_MERGE;
  const wp01Path = options.wp01Receipt || WP01_TXN;
  try {
    const infra = readJson(infraPath);
    const wp00 = readJson(wp00Path);
    const wp01 = readJson(wp01Path);
    if (infra.EffectiveGate !== true || infra.EffectiveDone !== true) {
      return fail('WP02_PREREQUISITE_NOT_DONE', 'WP-INFRA not EffectiveDone/Gate');
    }
    if (wp00.EffectiveDone !== true) {
      return fail('WP02_PREREQUISITE_NOT_DONE', 'WP-00 not EffectiveDone');
    }
    if (wp01.EffectiveDone !== true || wp01.taskId !== 'WP-01') {
      return fail('WP02_PREREQUISITE_NOT_DONE', 'WP-01 not EffectiveDone');
    }
    return ok({
      WP_INFRA: true,
      'WP-00': true,
      'WP-01': true,
    });
  } catch (err) {
    return fail('WP02_PREREQUISITE_NOT_DONE', String(err && err.message ? err.message : err));
  }
}

function fileDigests(cwd = REPO_ROOT) {
  const digests = {};
  for (const name of REQUIRED_RUNTIME) {
    const p = path.join(
      cwd,
      'wallpaper-plugin',
      'app',
      'src',
      'main',
      'java',
      'com',
      'motif',
      'wallpaperengine',
      'plugin',
      name,
    );
    if (pathExists(p)) digests[name] = sha256File(p);
  }
  if (pathExists(path.join(cwd, 'wallpaper-plugin', 'app', 'src', 'main', 'AndroidManifest.xml'))) {
    digests['AndroidManifest.xml'] = sha256File(
      path.join(cwd, 'wallpaper-plugin', 'app', 'src', 'main', 'AndroidManifest.xml'),
    );
  }
  if (pathExists(CATALOG)) digests['wallpaper-plugin-tasks.json'] = sha256File(CATALOG);
  if (pathExists(SCHEMA)) digests['wallpaper-task.schema.json'] = sha256File(SCHEMA);
  return digests;
}

module.exports = {
  assertWp02RuntimeReady,
  assertClaimLaunchAtomic,
  assertPendingIntentOneShot,
  assertCallerPolicy,
  assertWp02NotDone,
  assertWp02Prerequisites,
  computeCoreProgressFromReceipts,
  loadWp02CatalogTask,
  fileDigests,
  REQUIRED_RUNTIME,
  REQUIRED_UNIT_TESTS,
  MANIFEST_MARKERS,
  REPO_ROOT,
  CATALOG,
  WP02_TXN,
};
