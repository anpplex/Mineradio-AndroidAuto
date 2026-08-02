'use strict';

/**
 * Helpers for WP-06 / RED-01 — plugin install control + package visibility.
 *
 * RED only: catalog + production capacity gaps. Failures prove capacity missing.
 * Does not implement production code. Does not elevate EffectiveDone / progress.
 *
 * Spec: WALLAPER-PLUGIN-DEVELOPMENT Task 6
 *   Create CarWallpaperPluginInstaller.smali
 *   isInstalled / getPluginVersion / installPlugin(contentUri)
 *   REQUEST_INSTALL_PACKAGES + package queries
 *   PackageInstaller UI via one-shot action-token (never silent success)
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
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
const contractPath = path.join(
  repoRoot,
  'android-car',
  'scripts',
  'wallpaper-plugin-contract.js',
);
const patcherPath = path.join(
  repoRoot,
  'android-car',
  'scripts',
  'patch-wallpaper-plugin-bridge.js',
);
const manifestPatcherPath = path.join(
  repoRoot,
  'android-car',
  'scripts',
  'patch-apk-manifest.js',
);
const smaliBridgePath = path.join(
  repoRoot,
  'android-car',
  'scripts',
  'smali',
  'com',
  'mineradio',
  'app',
  'car',
  'CarWallpaperPluginBridge.smali',
);
const installerSmaliPath = path.join(
  repoRoot,
  'android-car',
  'scripts',
  'smali',
  'com',
  'mineradio',
  'app',
  'car',
  'CarWallpaperPluginInstaller.smali',
);
const installerUnitTestPath = path.join(
  repoRoot,
  'android-car',
  'tests',
  'wallpaper-plugin-installer.test.js',
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
const wp04TxnReceipt = path.join(transactionsRoot, 'wp-04.json');
const wp05TxnReceipt = path.join(transactionsRoot, 'wp-05.json');
const wp06TxnReceipt = path.join(transactionsRoot, 'wp-06.json');

const TASK_ID = 'WP-06';
/** WP-00…WP-05 = 44; +WP-06(6)=50 when DONE. */
const EXPECTED_CURRENT_CORE_PROGRESS = 44;
const EXPECTED_WEIGHT_FROM_PROGRESS_TABLE = 6;
const EXPECTED_PROGRESS_WHEN_DONE = 50;

// REFACTOR: pull install result mapping from contract (single JS truth).
// Fallback literals keep helpers loadable if contract path drifts during RED.
let _installFromContract = null;
try {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  _installFromContract = require('../scripts/wallpaper-plugin-contract.js');
} catch {
  _installFromContract = null;
}
const _ir = (_installFromContract && _installFromContract.installResult) || {};

const WP06_PLUGIN_PACKAGE = _ir.PLUGIN_PACKAGE || 'com.motif.wallpaperengine';
const WP06_WE_CLIENT_PACKAGE = _ir.WE_CLIENT_PACKAGE || 'io.wallpaperengine.weclient';
const WP06_APK_MIME = _ir.APK_MIME || 'application/vnd.android.package-archive';
const WP06_REQUEST_INSTALL_PERM =
  _ir.REQUEST_INSTALL_PACKAGES || 'android.permission.REQUEST_INSTALL_PACKAGES';

/** Task 6 Create surfaces (production). Unit test file is created in RED. */
const WP06_PRODUCTION_CREATE_REL_PATHS = Object.freeze([
  'android-car/scripts/smali/com/mineradio/app/car/CarWallpaperPluginInstaller.smali',
]);

const WP06_UNIT_TEST_REL_PATHS = Object.freeze([
  'android-car/tests/wallpaper-plugin-installer.test.js',
]);

const WP06_SPEC_ACCEPTANCE = Object.freeze({
  pluginPackage: WP06_PLUGIN_PACKAGE,
  weClientPackage: WP06_WE_CLIENT_PACKAGE,
  apkMime: WP06_APK_MIME,
  requestInstallPermission: WP06_REQUEST_INSTALL_PERM,
  methods: Object.freeze(['isInstalled', 'getPluginVersion', 'installPlugin']),
  /** install opened PackageInstaller UI — not silent success */
  codeInstallUiOpened: _ir.USER_ACTION_OR_NOT_INSTALLED ?? 20,
  codeOk: _ir.OK ?? 0,
  codeBadInput: _ir.BAD_INPUT ?? 40,
  codeSystemReject: _ir.SYSTEM_REJECT ?? 60,
  settingsRequired: _ir.SETTINGS_REQUIRED || 'SETTINGS_REQUIRED',
  userActionKind: _ir.USER_ACTION_KIND || 'INSTALL_PLUGIN',
});

const FailureReason = Object.freeze({
  WP06_CATALOG_ENTRY_MISSING: 'WP06_CATALOG_ENTRY_MISSING',
  WP06_CATALOG_FIELD_MISSING: 'WP06_CATALOG_FIELD_MISSING',
  WP06_PRODUCTION_SURFACE_MISSING: 'WP06_PRODUCTION_SURFACE_MISSING',
  WP06_INSTALLER_SMALI_MISSING: 'WP06_INSTALLER_SMALI_MISSING',
  WP06_MANIFEST_QUERIES_MISSING: 'WP06_MANIFEST_QUERIES_MISSING',
  WP06_REQUEST_INSTALL_PERM_MISSING: 'WP06_REQUEST_INSTALL_PERM_MISSING',
  WP06_BRIDGE_METHODS_MISSING: 'WP06_BRIDGE_METHODS_MISSING',
  WP06_INSTALL_PLUGIN_STUB: 'WP06_INSTALL_PLUGIN_STUB',
  WP06_UNIT_TEST_MISSING: 'WP06_UNIT_TEST_MISSING',
  WP06_PREREQUISITE_NOT_DONE: 'WP06_PREREQUISITE_NOT_DONE',
  WP06_RECEIPT_MISSING: 'WP06_RECEIPT_MISSING',
  WP06_EFFECTIVE_DONE_FORGED: 'WP06_EFFECTIVE_DONE_FORGED',
  WP06_PROGRESS_FORGED: 'WP06_PROGRESS_FORGED',
  WP06_GATE_SKIPPED: 'WP06_GATE_SKIPPED',
  CALLER_FORGED_IDENTITY: 'CALLER_FORGED_IDENTITY',
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

function runRunner(args, options = {}) {
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

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

function pathExists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function liveAuthoritativeBaseSha(cwd = repoRoot) {
  const r = git(['ls-remote', '--refs', 'origin', 'refs/heads/huawei-android12-car'], cwd);
  if (r.status !== 0) throw new Error(`ls-remote failed: ${r.stderr || r.stdout}`);
  const sha = (r.stdout.split(/\s+/)[0] || '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`invalid ls-remote base: ${r.stdout}`);
  return sha;
}

function isGitAncestor(ancestorSha, descendantSha, cwd = repoRoot) {
  return git(['merge-base', '--is-ancestor', ancestorSha, descendantSha], cwd).status === 0;
}

function readTaskWorktreeIdentity() {
  const branch = git(['branch', '--show-current']).stdout;
  const head = git(['rev-parse', 'HEAD']).stdout.toLowerCase();
  const live = liveAuthoritativeBaseSha();
  const liveIsAncestorOfHead = isGitAncestor(live, head);
  const relation =
    head === live ? 'equal' : liveIsAncestorOfHead ? 'ahead' : 'other';
  return {
    ok: /^codex\/wallpaper-plugin-/.test(branch) && (relation === 'equal' || relation === 'ahead'),
    branch,
    head,
    liveBaseSha: live,
    relation,
    liveIsAncestorOfHead,
  };
}

function loadWp06CatalogEntry() {
  if (!pathExists(catalogPath)) {
    return { ok: false, failureReason: FailureReason.WP06_CATALOG_ENTRY_MISSING };
  }
  const catalog = readJson(catalogPath);
  const matches = (catalog.tasks || []).filter((t) => t && t.taskId === TASK_ID);
  if (matches.length !== 1) {
    return {
      ok: false,
      failureReason: FailureReason.WP06_CATALOG_ENTRY_MISSING,
      count: matches.length,
      catalog,
    };
  }
  return { ok: true, task: matches[0], catalog };
}

function parseWp06CatalogIdentity(task) {
  const missing = [];
  if (task.weight !== EXPECTED_WEIGHT_FROM_PROGRESS_TABLE) missing.push('weight');
  if (task.evidenceLevel !== 'E1') missing.push('evidenceLevel');
  const req = task.requiredEffectiveDone || [];
  for (const dep of ['WP-INFRA', 'WP-00', 'WP-01', 'WP-02', 'WP-03', 'WP-04', 'WP-05']) {
    if (!req.includes(dep)) missing.push(`requiredEffectiveDone:${dep}`);
  }
  if (missing.length) {
    return {
      ok: false,
      failureReason: FailureReason.WP06_CATALOG_FIELD_MISSING,
      missing,
    };
  }
  return { ok: true, task };
}

function readPrerequisiteDone() {
  const paths = {
    'WP-INFRA': finalInfraReceipt,
    'WP-00': wp00MergeReceipt,
    'WP-01': wp01TxnReceipt,
    'WP-02': wp02TxnReceipt,
    'WP-03': wp03TxnReceipt,
    'WP-04': wp04TxnReceipt,
    'WP-05': wp05TxnReceipt,
  };
  const out = { ok: true };
  for (const [id, p] of Object.entries(paths)) {
    if (!pathExists(p)) {
      return {
        ok: false,
        failureReason: FailureReason.WP06_PREREQUISITE_NOT_DONE,
        missing: id,
      };
    }
    const data = readJson(p);
    const done = data.EffectiveDone === true;
    const stateOk =
      id === 'WP-INFRA' || id === 'WP-00' ? done : done && data.state === 'DONE';
    out[id] = {
      EffectiveDone: done,
      state: data.state,
      path: p,
    };
    if (id === 'WP-INFRA') {
      out['WP-INFRA'].EffectiveGate = data.EffectiveGate === true;
      if (!done || data.EffectiveGate !== true) out.ok = false;
    } else if (!stateOk) {
      out.ok = false;
    }
  }
  if (!out.ok) out.failureReason = FailureReason.WP06_PREREQUISITE_NOT_DONE;
  return out;
}

function listMissingProductionCreates(cwd = repoRoot) {
  return WP06_PRODUCTION_CREATE_REL_PATHS.filter(
    (rel) => !pathExists(path.join(cwd, rel)),
  );
}

function assertWp06InstallerSmaliPresent(cwd = repoRoot) {
  const p = path.join(cwd, WP06_PRODUCTION_CREATE_REL_PATHS[0]);
  if (!pathExists(p)) {
    return {
      ok: false,
      failureReason: FailureReason.WP06_INSTALLER_SMALI_MISSING,
      message: `missing ${p}`,
      EffectiveDone: false,
    };
  }
  const text = readText(p);
  const need = [
    'CarWallpaperPluginInstaller',
    WP06_PLUGIN_PACKAGE,
    'PackageInstaller',
    'content://',
  ];
  const missing = need.filter((s) => !text.includes(s));
  if (missing.length) {
    return {
      ok: false,
      failureReason: FailureReason.WP06_INSTALLER_SMALI_MISSING,
      message: `installer smali missing markers: ${missing.join(',')}`,
      EffectiveDone: false,
    };
  }
  return { ok: true, path: p, EffectiveDone: false };
}

function assertWp06ManifestInstallCapacity(cwd = repoRoot) {
  const p = path.join(cwd, 'android-car/scripts/patch-apk-manifest.js');
  if (!pathExists(p)) {
    return {
      ok: false,
      failureReason: FailureReason.WP06_MANIFEST_QUERIES_MISSING,
      message: 'patch-apk-manifest.js missing',
      EffectiveDone: false,
    };
  }
  const text = readText(p);
  const hasPerm = text.includes(WP06_REQUEST_INSTALL_PERM);
  const hasQueries =
    text.includes('<queries') ||
    text.includes('queries') ||
    text.includes(WP06_PLUGIN_PACKAGE);
  const hasWeClient = text.includes(WP06_WE_CLIENT_PACKAGE);
  if (!hasPerm) {
    return {
      ok: false,
      failureReason: FailureReason.WP06_REQUEST_INSTALL_PERM_MISSING,
      message: `manifest patcher missing ${WP06_REQUEST_INSTALL_PERM}`,
      EffectiveDone: false,
    };
  }
  if (!hasQueries || !hasWeClient) {
    return {
      ok: false,
      failureReason: FailureReason.WP06_MANIFEST_QUERIES_MISSING,
      message: 'manifest patcher missing package queries for WE packages',
      EffectiveDone: false,
    };
  }
  return { ok: true, EffectiveDone: false };
}

function assertWp06BridgeMethodsCapacity(cwd = repoRoot) {
  const bridge = path.join(
    cwd,
    'android-car/scripts/smali/com/mineradio/app/car/CarWallpaperPluginBridge.smali',
  );
  const contract = path.join(cwd, 'android-car/scripts/wallpaper-plugin-contract.js');
  if (!pathExists(bridge) || !pathExists(contract)) {
    return {
      ok: false,
      failureReason: FailureReason.WP06_BRIDGE_METHODS_MISSING,
      message: 'bridge or contract missing',
      EffectiveDone: false,
    };
  }
  const bridgeText = readText(bridge);
  const contractText = readText(contract);
  const missing = [];
  for (const m of WP06_SPEC_ACCEPTANCE.methods) {
    if (!bridgeText.includes(m) && !contractText.includes(m)) missing.push(m);
  }
  // isInstalled / getPluginVersion must exist on bridge for package visibility
  if (!bridgeText.includes('isInstalled')) missing.push('bridge.isInstalled');
  if (!bridgeText.includes('getPluginVersion')) missing.push('bridge.getPluginVersion');
  if (missing.length) {
    return {
      ok: false,
      failureReason: FailureReason.WP06_BRIDGE_METHODS_MISSING,
      message: `missing methods: ${missing.join(',')}`,
      missing,
      EffectiveDone: false,
    };
  }
  return { ok: true, EffectiveDone: false };
}

/**
 * installPlugin must not silently claim success; content:// only;
 * real path routes through installer + action-token confirm.
 */
function assertWp06InstallPluginCapacity(cwd = repoRoot) {
  const bridge = path.join(
    cwd,
    'android-car/scripts/smali/com/mineradio/app/car/CarWallpaperPluginBridge.smali',
  );
  if (!pathExists(bridge)) {
    return {
      ok: false,
      failureReason: FailureReason.WP06_INSTALL_PLUGIN_STUB,
      message: 'bridge missing',
      EffectiveDone: false,
    };
  }
  const text = readText(bridge);
  // WP-04 stub was a fixed INSTALL_PLUGIN string with no installer class call.
  const isLegacyInstallStub =
    /const-string v0, "\{\\"code\\":20,\\"userActionKind\\":\\"INSTALL_PLUGIN\\"\}"/.test(
      text,
    ) && !text.includes('CarWallpaperPluginInstaller');
  const routesInstaller =
    text.includes('CarWallpaperPluginInstaller') &&
    /installPlugin\(Ljava\/lang\/String;\)/.test(text) &&
    text.includes('requestInstallFromContentUri');
  if (isLegacyInstallStub || !routesInstaller) {
    return {
      ok: false,
      failureReason: FailureReason.WP06_INSTALL_PLUGIN_STUB,
      message:
        'installPlugin is stub or does not route PackageInstaller/action-token; ' +
        'must not silently claim install success',
      EffectiveDone: false,
    };
  }
  if (!pathExists(installerSmaliPath)) {
    return {
      ok: false,
      failureReason: FailureReason.WP06_INSTALLER_SMALI_MISSING,
      message: 'installer smali missing for installPlugin route',
      EffectiveDone: false,
    };
  }
  const installerText = readText(installerSmaliPath);
  if (
    !installerText.includes('PackageInstaller') ||
    !installerText.includes('content://') ||
    !installerText.includes(WP06_APK_MIME)
  ) {
    return {
      ok: false,
      failureReason: FailureReason.WP06_INSTALL_PLUGIN_STUB,
      message: 'installer missing PackageInstaller/content/MIME markers',
      EffectiveDone: false,
    };
  }
  return { ok: true, EffectiveDone: false };
}

function assertWp06ProductionSurfacesPresent(cwd = repoRoot) {
  const missing = listMissingProductionCreates(cwd);
  if (missing.length) {
    return {
      ok: false,
      failureReason: FailureReason.WP06_PRODUCTION_SURFACE_MISSING,
      message: `missing Create surfaces: ${missing.join(', ')}`,
      missing,
      EffectiveDone: false,
    };
  }
  return { ok: true, EffectiveDone: false };
}

function assertWp06FullProductionCapacity(cwd = repoRoot) {
  const checks = [
    assertWp06ProductionSurfacesPresent(cwd),
    assertWp06InstallerSmaliPresent(cwd),
    assertWp06ManifestInstallCapacity(cwd),
    assertWp06BridgeMethodsCapacity(cwd),
    assertWp06InstallPluginCapacity(cwd),
  ];
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) {
    return {
      ok: false,
      failureReason: failed[0].failureReason,
      message: failed.map((f) => `${f.failureReason}: ${f.message || ''}`).join(' | '),
      failures: failed.map((f) => f.failureReason),
      EffectiveDone: false,
    };
  }
  return { ok: true, EffectiveDone: false };
}

function computeCoreProgress(doneMap) {
  return runRunner([
    'compute-core-progress',
    '--done-receipts-json',
    JSON.stringify(doneMap),
  ]);
}

function defaultDoneReceiptsThroughWp05() {
  return {
    'WP-00': wp00MergeReceipt,
    'WP-01': wp01TxnReceipt,
    'WP-02': wp02TxnReceipt,
    'WP-03': wp03TxnReceipt,
    'WP-04': wp04TxnReceipt,
    'WP-05': wp05TxnReceipt,
  };
}

function defaultDoneReceiptsWithWp06() {
  return {
    ...defaultDoneReceiptsThroughWp05(),
    'WP-06': wp06TxnReceipt,
  };
}

function liveWp06OperationalProgress() {
  if (!pathExists(wp06TxnReceipt)) {
    return {
      exists: false,
      EffectiveDone: false,
      expectedCoreProgressPercent: EXPECTED_CURRENT_CORE_PROGRESS,
    };
  }
  const receipt = readJson(wp06TxnReceipt);
  const done = receipt.EffectiveDone === true && receipt.state === 'DONE';
  return {
    exists: true,
    receipt,
    EffectiveDone: done,
    expectedCoreProgressPercent: done
      ? EXPECTED_PROGRESS_WHEN_DONE
      : EXPECTED_CURRENT_CORE_PROGRESS,
  };
}

function attemptCallerForgeEffectiveDone() {
  if (!pathExists(wp06TxnReceipt)) {
    return { ok: false, failureReason: FailureReason.WP06_RECEIPT_MISSING };
  }
  const before = readJson(wp06TxnReceipt);
  const cas = runRunner([
    'receipt-cas',
    '--receipt',
    wp06TxnReceipt,
    '--expected-revision',
    String(before.revision || 1),
    '--expected-state',
    String(before.state || 'INIT'),
    '--state',
    'DONE',
    '--set-json',
    JSON.stringify({ EffectiveDone: true, coreProgressPercent: 50 }),
  ]);
  const after = pathExists(wp06TxnReceipt) ? readJson(wp06TxnReceipt) : null;
  return {
    ok: cas.status !== 0 && after && after.EffectiveDone !== true,
    status: cas.status,
    combined: cas.combined,
    after,
    failureReason:
      cas.status === 0 || (after && after.EffectiveDone === true)
        ? FailureReason.WP06_EFFECTIVE_DONE_FORGED
        : null,
  };
}

function initTempWp06Receipt() {
  const receipt = path.join(
    os.tmpdir(),
    `wp06-red-${process.pid}-${Date.now()}.json`,
  );
  const init = runRunner(['receipt-init', '--task', TASK_ID, '--receipt', receipt]);
  return { receipt, init };
}

module.exports = {
  repoRoot,
  runnerPath,
  catalogPath,
  schemaPath,
  contractPath,
  patcherPath,
  manifestPatcherPath,
  smaliBridgePath,
  installerSmaliPath,
  installerUnitTestPath,
  verificationRoot,
  bootstrapRoot,
  transactionsRoot,
  finalInfraReceipt,
  wp00MergeReceipt,
  wp01TxnReceipt,
  wp02TxnReceipt,
  wp03TxnReceipt,
  wp04TxnReceipt,
  wp05TxnReceipt,
  wp06TxnReceipt,
  TASK_ID,
  EXPECTED_CURRENT_CORE_PROGRESS,
  EXPECTED_WEIGHT_FROM_PROGRESS_TABLE,
  EXPECTED_PROGRESS_WHEN_DONE,
  WP06_PRODUCTION_CREATE_REL_PATHS,
  WP06_UNIT_TEST_REL_PATHS,
  WP06_SPEC_ACCEPTANCE,
  FailureReason,
  git,
  runRunner,
  parseRunnerJson,
  readJson,
  readText,
  pathExists,
  liveAuthoritativeBaseSha,
  isGitAncestor,
  readTaskWorktreeIdentity,
  loadWp06CatalogEntry,
  parseWp06CatalogIdentity,
  readPrerequisiteDone,
  listMissingProductionCreates,
  assertWp06InstallerSmaliPresent,
  assertWp06ManifestInstallCapacity,
  assertWp06BridgeMethodsCapacity,
  assertWp06InstallPluginCapacity,
  assertWp06ProductionSurfacesPresent,
  assertWp06FullProductionCapacity,
  computeCoreProgress,
  defaultDoneReceiptsThroughWp05,
  defaultDoneReceiptsWithWp06,
  liveWp06OperationalProgress,
  attemptCallerForgeEffectiveDone,
  initTempWp06Receipt,
};
