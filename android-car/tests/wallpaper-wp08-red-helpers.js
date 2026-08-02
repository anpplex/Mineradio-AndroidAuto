'use strict';

/**
 * Helpers for WP-08 / RED-01 — 队列、公开 WallpaperManager apply/stop、
 * operationState/bindingState、Activity death 与外部壁纸对账.
 *
 * RED only: catalog + plugin production capacity gaps. Failures prove capacity
 * missing. Does not implement production code. Does not elevate EffectiveDone.
 *
 * Spec: WALLAPER-PLUGIN-DEVELOPMENT Task 8 (WallpaperEngine plugin sandbox)
 * Weight 8% E1; prereqs INFRA…WP-07; progress 56 → 64 when DONE.
 */

const fs = require('node:fs');
const path = require('node:path');
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

/** Task 8 production root (Wallpaper Engine plugin sandbox). */
const pluginSandboxRoot = path.join(
  '/Users/anpple/Codex/WallpaperEngine',
  '.worktrees',
  'mineradio-plugin-sandbox',
);
const pluginMainRoot = path.join(
  pluginSandboxRoot,
  'app',
  'src',
  'main',
  'java',
  'com',
  'motif',
  'wallpaperengine',
  'plugin',
);
const pluginTestRoot = path.join(
  pluginSandboxRoot,
  'app',
  'src',
  'test',
  'java',
  'com',
  'motif',
  'wallpaperengine',
  'plugin',
);

const WP08_CREATE_REL = Object.freeze([
  'app/src/main/java/com/motif/wallpaperengine/plugin/WallpaperApplyController.kt',
  'app/src/main/java/com/motif/wallpaperengine/plugin/WallpaperQueue.kt',
  'app/src/main/java/com/motif/wallpaperengine/plugin/PluginRuntimeState.kt',
  'app/src/test/java/com/motif/wallpaperengine/plugin/WallpaperQueueTest.kt',
  'app/src/test/java/com/motif/wallpaperengine/plugin/PluginRuntimeStateTest.kt',
]);

const WP08_MODIFY_REL = Object.freeze([
  'app/src/main/java/com/motif/wallpaperengine/plugin/PluginControlProvider.kt',
  'app/src/main/java/com/motif/wallpaperengine/plugin/PluginActionActivity.kt',
]);

const WP08_PUBLIC_API_MARKERS = Object.freeze([
  'WallpaperManager',
  'ACTION_CHANGE_LIVE_WALLPAPER',
  'EXTRA_LIVE_WALLPAPER_COMPONENT',
  'getWallpaperInfo',
  'apply_current',
  'operationState',
  'bindingState',
  'ACTIVE_TARGET',
  'ACTIVE_OTHER',
  'UNBOUND',
  'claimLaunch',
  'APPLY_PERMISSION_REQUIRED',
]);

const WP08_QUEUE_CONTRACT = Object.freeze([
  'emptyQueue',
  'singleItemLoop',
  'nextPrevious',
  'skipCorrupt',
  'stopIdempotent',
  'stopDoesNotChangeBinding',
]);

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
const wp07TxnReceipt = path.join(transactionsRoot, 'wp-07.json');
const wp08TxnReceipt = path.join(transactionsRoot, 'wp-08.json');

const TASK_ID = 'WP-08';
/** WP-00…WP-07 = 56; +WP-08(8)=64 when DONE. */
const EXPECTED_CURRENT_CORE_PROGRESS = 56;
const EXPECTED_WEIGHT_FROM_PROGRESS_TABLE = 8;
const EXPECTED_PROGRESS_WHEN_DONE = 64;

const FailureReason = Object.freeze({
  WP08_CATALOG_ENTRY_MISSING: 'WP08_CATALOG_ENTRY_MISSING',
  WP08_CATALOG_FIELD_MISSING: 'WP08_CATALOG_FIELD_MISSING',
  WP08_PRODUCTION_SURFACE_MISSING: 'WP08_PRODUCTION_SURFACE_MISSING',
  WP08_QUEUE_MISSING: 'WP08_QUEUE_MISSING',
  WP08_RUNTIME_STATE_MISSING: 'WP08_RUNTIME_STATE_MISSING',
  WP08_APPLY_CONTROLLER_MISSING: 'WP08_APPLY_CONTROLLER_MISSING',
  WP08_PUBLIC_API_CONTRACT_MISSING: 'WP08_PUBLIC_API_CONTRACT_MISSING',
  WP08_UNIT_TEST_MISSING: 'WP08_UNIT_TEST_MISSING',
  WP08_PROVIDER_ACTIVITY_MISSING: 'WP08_PROVIDER_ACTIVITY_MISSING',
  WP08_PREREQUISITE_NOT_DONE: 'WP08_PREREQUISITE_NOT_DONE',
  WP08_RECEIPT_MISSING: 'WP08_RECEIPT_MISSING',
  WP08_EFFECTIVE_DONE_FORGED: 'WP08_EFFECTIVE_DONE_FORGED',
  WP08_PLUGIN_SANDBOX_MISSING: 'WP08_PLUGIN_SANDBOX_MISSING',
});

function git(args, cwd = repoRoot) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return {
    status: r.status === null ? 1 : r.status,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
  };
}

function runRunner(args, options = {}) {
  const r = spawnSync('python3', [runnerPath, ...args], {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...(options.env || {}) },
  });
  return {
    status: r.status === null ? 1 : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    combined: `${r.stdout || ''}\n${r.stderr || ''}`,
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

function isGitAncestor(a, d, cwd = repoRoot) {
  return git(['merge-base', '--is-ancestor', a, d], cwd).status === 0;
}

function readTaskWorktreeIdentity() {
  const branch = git(['branch', '--show-current']).stdout;
  const head = git(['rev-parse', 'HEAD']).stdout.toLowerCase();
  const live = liveAuthoritativeBaseSha();
  const equal = head === live;
  const liveIsAncestorOfHead = equal || isGitAncestor(live, head);
  return {
    ok: /^codex\/wallpaper-plugin-/.test(branch) && liveIsAncestorOfHead,
    branch,
    head,
    liveBaseSha: live,
    relation: equal ? 'equal' : liveIsAncestorOfHead ? 'ahead' : 'diverged',
  };
}

function loadWp08CatalogEntry() {
  if (!pathExists(catalogPath)) {
    return { ok: false, failureReason: FailureReason.WP08_CATALOG_ENTRY_MISSING };
  }
  const catalog = readJson(catalogPath);
  const matches = (catalog.tasks || []).filter((t) => t && t.taskId === TASK_ID);
  if (matches.length !== 1) {
    return {
      ok: false,
      failureReason: FailureReason.WP08_CATALOG_ENTRY_MISSING,
      count: matches.length,
      catalog,
    };
  }
  return { ok: true, task: matches[0], catalog };
}

function parseWp08CatalogIdentity(task) {
  const missing = [];
  if (task.weight !== EXPECTED_WEIGHT_FROM_PROGRESS_TABLE) missing.push('weight');
  if (task.evidenceLevel !== 'E1') missing.push('evidenceLevel');
  const req = task.requiredEffectiveDone || [];
  for (const dep of [
    'WP-INFRA',
    'WP-00',
    'WP-01',
    'WP-02',
    'WP-03',
    'WP-04',
    'WP-05',
    'WP-06',
    'WP-07',
  ]) {
    if (!req.includes(dep)) missing.push(`requiredEffectiveDone:${dep}`);
  }
  if (missing.length) {
    return {
      ok: false,
      failureReason: FailureReason.WP08_CATALOG_FIELD_MISSING,
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
    'WP-06': wp06TxnReceipt,
    'WP-07': wp07TxnReceipt,
  };
  const out = { ok: true };
  for (const [id, p] of Object.entries(paths)) {
    if (!pathExists(p)) {
      return {
        ok: false,
        failureReason: FailureReason.WP08_PREREQUISITE_NOT_DONE,
        missing: id,
      };
    }
    const data = readJson(p);
    const done = data.EffectiveDone === true;
    const stateOk =
      id === 'WP-INFRA' || id === 'WP-00' ? done : done && data.state === 'DONE';
    out[id] = { EffectiveDone: done, state: data.state, path: p };
    if (id === 'WP-INFRA') {
      out['WP-INFRA'].EffectiveGate = data.EffectiveGate === true;
      if (!done || data.EffectiveGate !== true) out.ok = false;
    } else if (!stateOk) {
      out.ok = false;
    }
  }
  if (!out.ok) out.failureReason = FailureReason.WP08_PREREQUISITE_NOT_DONE;
  return out;
}

function assertPluginSandboxPresent() {
  if (!pathExists(pluginSandboxRoot) || !pathExists(path.join(pluginSandboxRoot, 'gradlew'))) {
    return {
      ok: false,
      failureReason: FailureReason.WP08_PLUGIN_SANDBOX_MISSING,
      message: `plugin sandbox missing: ${pluginSandboxRoot}`,
      EffectiveDone: false,
    };
  }
  return { ok: true, path: pluginSandboxRoot, EffectiveDone: false };
}

function listMissingCreateSurfaces() {
  return WP08_CREATE_REL.filter((rel) => !pathExists(path.join(pluginSandboxRoot, rel)));
}

function listMissingModifySurfaces() {
  return WP08_MODIFY_REL.filter((rel) => !pathExists(path.join(pluginSandboxRoot, rel)));
}

function assertWp08ProductionSurfacesPresent() {
  const missing = listMissingCreateSurfaces();
  if (missing.length) {
    return {
      ok: false,
      failureReason: FailureReason.WP08_PRODUCTION_SURFACE_MISSING,
      message: `missing Create surfaces: ${missing.join(', ')}`,
      missing,
      EffectiveDone: false,
    };
  }
  return { ok: true, EffectiveDone: false };
}

function assertWp08QueuePresent() {
  const p = path.join(pluginMainRoot, 'WallpaperQueue.kt');
  if (!pathExists(p)) {
    return {
      ok: false,
      failureReason: FailureReason.WP08_QUEUE_MISSING,
      message: `missing ${p}`,
      EffectiveDone: false,
    };
  }
  return { ok: true, path: p, EffectiveDone: false };
}

function assertWp08RuntimeStatePresent() {
  const p = path.join(pluginMainRoot, 'PluginRuntimeState.kt');
  if (!pathExists(p)) {
    return {
      ok: false,
      failureReason: FailureReason.WP08_RUNTIME_STATE_MISSING,
      message: `missing ${p}`,
      EffectiveDone: false,
    };
  }
  return { ok: true, path: p, EffectiveDone: false };
}

function assertWp08ApplyControllerPresent() {
  const p = path.join(pluginMainRoot, 'WallpaperApplyController.kt');
  if (!pathExists(p)) {
    return {
      ok: false,
      failureReason: FailureReason.WP08_APPLY_CONTROLLER_MISSING,
      message: `missing ${p}`,
      EffectiveDone: false,
    };
  }
  return { ok: true, path: p, EffectiveDone: false };
}

function assertWp08PublicApiContract() {
  const files = [
    path.join(pluginMainRoot, 'WallpaperApplyController.kt'),
    path.join(pluginMainRoot, 'PluginRuntimeState.kt'),
    path.join(pluginMainRoot, 'PluginControlProvider.kt'),
    path.join(pluginMainRoot, 'PluginActionActivity.kt'),
  ];
  const existing = files.filter((f) => pathExists(f));
  if (!existing.length) {
    return {
      ok: false,
      failureReason: FailureReason.WP08_PUBLIC_API_CONTRACT_MISSING,
      message: 'no apply/activity/provider surfaces to scan',
      missing: WP08_PUBLIC_API_MARKERS.slice(),
      EffectiveDone: false,
    };
  }
  const text = existing.map((f) => readText(f)).join('\n');
  const missing = WP08_PUBLIC_API_MARKERS.filter((m) => !text.includes(m));
  if (missing.length) {
    return {
      ok: false,
      failureReason: FailureReason.WP08_PUBLIC_API_CONTRACT_MISSING,
      message: `public API contract missing: ${missing.join(',')}`,
      missing,
      EffectiveDone: false,
    };
  }
  // Forbid shell / non-public wallpaper APIs as baseline path (code only).
  if (/Runtime\.getRuntime\(\)\.exec\s*\(|setWallpaperComponent\s*\(/.test(text)) {
    return {
      ok: false,
      failureReason: FailureReason.WP08_PUBLIC_API_CONTRACT_MISSING,
      message: 'baseline path must not use shell or setWallpaperComponent()',
      EffectiveDone: false,
    };
  }
  return { ok: true, EffectiveDone: false };
}

function assertWp08UnitTestsPresent() {
  const missing = [
    'WallpaperQueueTest.kt',
    'PluginRuntimeStateTest.kt',
  ].filter((name) => !pathExists(path.join(pluginTestRoot, name)));
  if (missing.length) {
    return {
      ok: false,
      failureReason: FailureReason.WP08_UNIT_TEST_MISSING,
      message: `missing unit tests: ${missing.join(', ')}`,
      missing,
      EffectiveDone: false,
    };
  }
  return { ok: true, EffectiveDone: false };
}

function assertWp08ProviderActivityPresent() {
  const missing = listMissingModifySurfaces();
  if (missing.length) {
    return {
      ok: false,
      failureReason: FailureReason.WP08_PROVIDER_ACTIVITY_MISSING,
      message: `missing modify surfaces: ${missing.join(', ')}`,
      missing,
      EffectiveDone: false,
    };
  }
  return { ok: true, EffectiveDone: false };
}

function assertWp08FullProductionCapacity() {
  const checks = [
    assertPluginSandboxPresent(),
    assertWp08ProductionSurfacesPresent(),
    assertWp08QueuePresent(),
    assertWp08RuntimeStatePresent(),
    assertWp08ApplyControllerPresent(),
    assertWp08PublicApiContract(),
    assertWp08UnitTestsPresent(),
    assertWp08ProviderActivityPresent(),
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

function defaultDoneReceiptsThroughWp07() {
  return {
    'WP-00': wp00MergeReceipt,
    'WP-01': wp01TxnReceipt,
    'WP-02': wp02TxnReceipt,
    'WP-03': wp03TxnReceipt,
    'WP-04': wp04TxnReceipt,
    'WP-05': wp05TxnReceipt,
    'WP-06': wp06TxnReceipt,
    'WP-07': wp07TxnReceipt,
  };
}

function defaultDoneReceiptsWithWp08() {
  return {
    ...defaultDoneReceiptsThroughWp07(),
    'WP-08': wp08TxnReceipt,
  };
}

function liveWp08OperationalProgress() {
  if (!pathExists(wp08TxnReceipt)) {
    return {
      exists: false,
      EffectiveDone: false,
      expectedCoreProgressPercent: EXPECTED_CURRENT_CORE_PROGRESS,
    };
  }
  const receipt = readJson(wp08TxnReceipt);
  const done = receipt && receipt.EffectiveDone === true && receipt.state === 'DONE';
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
  if (!pathExists(wp08TxnReceipt)) {
    return { ok: false, failureReason: FailureReason.WP08_RECEIPT_MISSING };
  }
  const before = readJson(wp08TxnReceipt);
  const cas = runRunner([
    'receipt-cas',
    '--receipt',
    wp08TxnReceipt,
    '--expected-revision',
    String(before.revision || 1),
    '--expected-state',
    String(before.state || 'INIT'),
    '--state',
    'DONE',
    '--set-json',
    JSON.stringify({ EffectiveDone: true, coreProgressPercent: 64 }),
  ]);
  const after = pathExists(wp08TxnReceipt) ? readJson(wp08TxnReceipt) : null;
  return {
    ok: cas.status !== 0 && after && after.EffectiveDone !== true,
    status: cas.status,
    combined: cas.combined,
    after,
    failureReason:
      cas.status === 0 || (after && after.EffectiveDone === true)
        ? FailureReason.WP08_EFFECTIVE_DONE_FORGED
        : null,
  };
}

function initTempWp08Receipt() {
  const receipt = path.join(
    os.tmpdir(),
    `wp08-red-${process.pid}-${Date.now()}.json`,
  );
  const init = runRunner(['receipt-init', '--task', TASK_ID, '--receipt', receipt]);
  return { receipt, init };
}

module.exports = {
  repoRoot,
  runnerPath,
  catalogPath,
  schemaPath,
  pluginSandboxRoot,
  pluginMainRoot,
  pluginTestRoot,
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
  wp07TxnReceipt,
  wp08TxnReceipt,
  TASK_ID,
  EXPECTED_CURRENT_CORE_PROGRESS,
  EXPECTED_WEIGHT_FROM_PROGRESS_TABLE,
  EXPECTED_PROGRESS_WHEN_DONE,
  WP08_CREATE_REL,
  WP08_MODIFY_REL,
  WP08_PUBLIC_API_MARKERS,
  WP08_QUEUE_CONTRACT,
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
  loadWp08CatalogEntry,
  parseWp08CatalogIdentity,
  readPrerequisiteDone,
  assertPluginSandboxPresent,
  listMissingCreateSurfaces,
  listMissingModifySurfaces,
  assertWp08ProductionSurfacesPresent,
  assertWp08QueuePresent,
  assertWp08RuntimeStatePresent,
  assertWp08ApplyControllerPresent,
  assertWp08PublicApiContract,
  assertWp08UnitTestsPresent,
  assertWp08ProviderActivityPresent,
  assertWp08FullProductionCapacity,
  computeCoreProgress,
  defaultDoneReceiptsThroughWp07,
  defaultDoneReceiptsWithWp08,
  liveWp08OperationalProgress,
  attemptCallerForgeEffectiveDone,
  initTempWp08Receipt,
};
