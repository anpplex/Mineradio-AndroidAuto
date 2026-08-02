'use strict';

/**
 * Helpers for WP-07 / RED-01 — 车机 HMI 状态卡与命令队列 / 轮询 runtime.
 *
 * RED only: catalog + production capacity gaps. Failures prove capacity missing.
 * Does not implement production code. Does not elevate EffectiveDone / progress.
 *
 * Spec: WALLPAPER-PLUGIN-DEVELOPMENT Task 7
 *   Create wallpaper-plugin-runtime.js + wallpaper-plugin-runtime.test.js
 *   Modify patch-car-hmi-assets.js (inject runtime + status card)
 *   window.MineradioWallpaperPlugin 1:1 bridge mapping; status poll; UI states
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
const runtimePath = path.join(
  repoRoot,
  'android-car',
  'scripts',
  'wallpaper-plugin-runtime.js',
);
const hmiPatcherPath = path.join(
  repoRoot,
  'android-car',
  'scripts',
  'patch-car-hmi-assets.js',
);
const runtimeTestPath = path.join(
  repoRoot,
  'android-car',
  'tests',
  'wallpaper-plugin-runtime.test.js',
);
const visualLayerDocPath = path.join(
  repoRoot,
  'android-car',
  'docs',
  'VISUAL-LAYER.zh-CN.md',
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
const wp07TxnReceipt = path.join(transactionsRoot, 'wp-07.json');

const TASK_ID = 'WP-07';
/** WP-00…WP-06 = 50; +WP-07(6)=56 when DONE. */
const EXPECTED_CURRENT_CORE_PROGRESS = 50;
const EXPECTED_WEIGHT_FROM_PROGRESS_TABLE = 6;
const EXPECTED_PROGRESS_WHEN_DONE = 56;

const WP07_GLOBAL = 'MineradioWallpaperPlugin';
const WP07_BRIDGE = 'WallpaperPlugin';

const WP07_METHODS = Object.freeze([
  'refresh',
  'importMpkg',
  'installPlugin',
  'confirmUserAction',
  'renewAction',
  'openLibrary',
  'applyCurrent',
  'next',
  'previous',
  'stop',
  'diagnostics',
]);

const WP07_UI_STATES = Object.freeze([
  '未安装',
  '需要安装确认',
  '插件可用',
  '等待用户确认',
  '正在导入',
  '已投递到壁纸引擎',
  '可预览（仅可靠回调）',
  '正在应用',
  '动态壁纸已运行（公开 API 已确认）',
  '需要 Lyra/R3 授权',
  '失败，可重试',
]);

const WP07_PRODUCTION_CREATE_REL_PATHS = Object.freeze([
  'android-car/scripts/wallpaper-plugin-runtime.js',
]);

const WP07_UNIT_TEST_REL_PATHS = Object.freeze([
  'android-car/tests/wallpaper-plugin-runtime.test.js',
]);

const WP07_SPEC_ACCEPTANCE = Object.freeze({
  globalName: WP07_GLOBAL,
  bridgeName: WP07_BRIDGE,
  methods: WP07_METHODS,
  uiStates: WP07_UI_STATES,
  pollActiveMs: 500,
  pollIdleMs: 5000,
  minTouchCssPx: 48,
  minPrimaryCssPx: 64,
  settingsOnlyEntry: true,
  noDefaultPlaybackMainOps: true,
  stopPollingWhenHidden: true,
  noEngineLaunchedAsPreview: true,
  stableOperationIdOnRetry: true,
  stopCarriesTargetOperationId: true,
  allowlistTopLevelOnly: true,
});

const FailureReason = Object.freeze({
  WP07_CATALOG_ENTRY_MISSING: 'WP07_CATALOG_ENTRY_MISSING',
  WP07_CATALOG_FIELD_MISSING: 'WP07_CATALOG_FIELD_MISSING',
  WP07_PRODUCTION_SURFACE_MISSING: 'WP07_PRODUCTION_SURFACE_MISSING',
  WP07_RUNTIME_MISSING: 'WP07_RUNTIME_MISSING',
  WP07_RUNTIME_API_MISSING: 'WP07_RUNTIME_API_MISSING',
  WP07_HMI_INJECT_MISSING: 'WP07_HMI_INJECT_MISSING',
  WP07_UNIT_TEST_MISSING: 'WP07_UNIT_TEST_MISSING',
  WP07_UI_STATE_CONTRACT_MISSING: 'WP07_UI_STATE_CONTRACT_MISSING',
  WP07_POLL_CONTRACT_MISSING: 'WP07_POLL_CONTRACT_MISSING',
  WP07_PREREQUISITE_NOT_DONE: 'WP07_PREREQUISITE_NOT_DONE',
  WP07_RECEIPT_MISSING: 'WP07_RECEIPT_MISSING',
  WP07_EFFECTIVE_DONE_FORGED: 'WP07_EFFECTIVE_DONE_FORGED',
  WP07_PROGRESS_FORGED: 'WP07_PROGRESS_FORGED',
  CALLER_FORGED_IDENTITY: 'CALLER_FORGED_IDENTITY',
});

function git(args, cwd = repoRoot) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return {
    status: r.status === null ? 1 : r.status,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
    combined: `${r.stdout || ''}\n${r.stderr || ''}`,
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

function loadWp07CatalogEntry() {
  if (!pathExists(catalogPath)) {
    return { ok: false, failureReason: FailureReason.WP07_CATALOG_ENTRY_MISSING };
  }
  const catalog = readJson(catalogPath);
  const matches = (catalog.tasks || []).filter((t) => t && t.taskId === TASK_ID);
  if (matches.length !== 1) {
    return {
      ok: false,
      failureReason: FailureReason.WP07_CATALOG_ENTRY_MISSING,
      count: matches.length,
      catalog,
    };
  }
  return { ok: true, task: matches[0], catalog };
}

function parseWp07CatalogIdentity(task) {
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
  ]) {
    if (!req.includes(dep)) missing.push(`requiredEffectiveDone:${dep}`);
  }
  if (missing.length) {
    return {
      ok: false,
      failureReason: FailureReason.WP07_CATALOG_FIELD_MISSING,
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
  };
  const out = { ok: true };
  for (const [id, p] of Object.entries(paths)) {
    if (!pathExists(p)) {
      return {
        ok: false,
        failureReason: FailureReason.WP07_PREREQUISITE_NOT_DONE,
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
  if (!out.ok) out.failureReason = FailureReason.WP07_PREREQUISITE_NOT_DONE;
  return out;
}

function listMissingProductionCreates(cwd = repoRoot) {
  return WP07_PRODUCTION_CREATE_REL_PATHS.filter(
    (rel) => !pathExists(path.join(cwd, rel)),
  );
}

function assertWp07RuntimePresent(cwd = repoRoot) {
  const p = path.join(cwd, WP07_PRODUCTION_CREATE_REL_PATHS[0]);
  if (!pathExists(p)) {
    return {
      ok: false,
      failureReason: FailureReason.WP07_RUNTIME_MISSING,
      message: `missing ${p}`,
      EffectiveDone: false,
    };
  }
  return { ok: true, path: p, EffectiveDone: false };
}

function assertWp07RuntimeApiCapacity(cwd = repoRoot) {
  const p = path.join(cwd, WP07_PRODUCTION_CREATE_REL_PATHS[0]);
  if (!pathExists(p)) {
    return {
      ok: false,
      failureReason: FailureReason.WP07_RUNTIME_MISSING,
      message: `missing ${p}`,
      EffectiveDone: false,
    };
  }
  const text = readText(p);
  const missing = [];
  if (!text.includes(WP07_GLOBAL)) missing.push(WP07_GLOBAL);
  if (!text.includes(WP07_BRIDGE) && !text.includes('window.WallpaperPlugin')) {
    missing.push('WallpaperPlugin bridge binding');
  }
  for (const m of WP07_METHODS) {
    if (!text.includes(m)) missing.push(`method:${m}`);
  }
  // Must not define a second protocol / reinvent codes.
  if (/secondProtocol|SecondProtocol|defineProtocol/.test(text)) {
    missing.push('secondProtocolForbidden');
  }
  if (missing.length) {
    return {
      ok: false,
      failureReason: FailureReason.WP07_RUNTIME_API_MISSING,
      message: `runtime API capacity missing: ${missing.join(',')}`,
      missing,
      EffectiveDone: false,
    };
  }
  return { ok: true, EffectiveDone: false };
}

function assertWp07PollContract(cwd = repoRoot) {
  const p = path.join(cwd, WP07_PRODUCTION_CREATE_REL_PATHS[0]);
  if (!pathExists(p)) {
    return {
      ok: false,
      failureReason: FailureReason.WP07_POLL_CONTRACT_MISSING,
      message: 'runtime missing',
      EffectiveDone: false,
    };
  }
  const text = readText(p);
  const need = [
    '500',
    '5000',
    'visibilitychange',
    'hidden',
    'status',
  ];
  const missing = need.filter((s) => !text.includes(s));
  // page hide stops poll
  if (!/hidden|visibilityState|document\.hidden/.test(text)) {
    missing.push('stopOnHidden');
  }
  if (missing.length) {
    return {
      ok: false,
      failureReason: FailureReason.WP07_POLL_CONTRACT_MISSING,
      message: `poll contract missing: ${missing.join(',')}`,
      missing,
      EffectiveDone: false,
    };
  }
  return { ok: true, EffectiveDone: false };
}

function assertWp07UiStateContract(cwd = repoRoot) {
  const p = path.join(cwd, WP07_PRODUCTION_CREATE_REL_PATHS[0]);
  if (!pathExists(p)) {
    return {
      ok: false,
      failureReason: FailureReason.WP07_UI_STATE_CONTRACT_MISSING,
      message: 'runtime missing',
      EffectiveDone: false,
    };
  }
  const text = readText(p);
  const missing = WP07_UI_STATES.filter((s) => !text.includes(s));
  // ENGINE_LAUNCHED must not map to 可预览 alone
  if (/ENGINE_LAUNCHED/.test(text) && /可预览/.test(text)) {
    // require explicit guard marker
    if (!/not.*preview|不得.*可预览|ENGINE_LAUNCHED.*!.*preview|forbidEngineLaunchedPreview/i.test(text)) {
      missing.push('ENGINE_LAUNCHED_must_not_show_preview');
    }
  }
  if (missing.length) {
    return {
      ok: false,
      failureReason: FailureReason.WP07_UI_STATE_CONTRACT_MISSING,
      message: `UI state contract missing: ${missing.join(',')}`,
      missing,
      EffectiveDone: false,
    };
  }
  return { ok: true, EffectiveDone: false };
}

function assertWp07HmiInjectCapacity(cwd = repoRoot) {
  const p = path.join(cwd, 'android-car/scripts/patch-car-hmi-assets.js');
  if (!pathExists(p)) {
    return {
      ok: false,
      failureReason: FailureReason.WP07_HMI_INJECT_MISSING,
      message: 'patch-car-hmi-assets.js missing',
      EffectiveDone: false,
    };
  }
  const text = readText(p);
  const need = [
    'wallpaper-plugin-runtime.js',
    WP07_GLOBAL,
    // status card inject markers
    'wallpaper-plugin',
  ];
  const missing = [];
  if (!text.includes('wallpaper-plugin-runtime.js')) missing.push('runtimeScriptInject');
  if (!text.includes(WP07_GLOBAL) && !/MineradioWallpaperPlugin/.test(text)) {
    missing.push(WP07_GLOBAL);
  }
  // must inject into MENC / car HMI assets path somehow
  if (!/status|状态|plugin-card|wallpaper-plugin-card|settings|实验/.test(text)) {
    missing.push('statusCardInject');
  }
  if (missing.length) {
    return {
      ok: false,
      failureReason: FailureReason.WP07_HMI_INJECT_MISSING,
      message: `HMI inject capacity missing: ${missing.join(',')}`,
      missing,
      EffectiveDone: false,
    };
  }
  return { ok: true, EffectiveDone: false };
}

function assertWp07ProductionSurfacesPresent(cwd = repoRoot) {
  const missing = listMissingProductionCreates(cwd);
  if (missing.length) {
    return {
      ok: false,
      failureReason: FailureReason.WP07_PRODUCTION_SURFACE_MISSING,
      message: `missing Create surfaces: ${missing.join(', ')}`,
      missing,
      EffectiveDone: false,
    };
  }
  return { ok: true, EffectiveDone: false };
}

function assertWp07FullProductionCapacity(cwd = repoRoot) {
  const checks = [
    assertWp07ProductionSurfacesPresent(cwd),
    assertWp07RuntimePresent(cwd),
    assertWp07RuntimeApiCapacity(cwd),
    assertWp07PollContract(cwd),
    assertWp07UiStateContract(cwd),
    assertWp07HmiInjectCapacity(cwd),
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

function defaultDoneReceiptsThroughWp06() {
  return {
    'WP-00': wp00MergeReceipt,
    'WP-01': wp01TxnReceipt,
    'WP-02': wp02TxnReceipt,
    'WP-03': wp03TxnReceipt,
    'WP-04': wp04TxnReceipt,
    'WP-05': wp05TxnReceipt,
    'WP-06': wp06TxnReceipt,
  };
}

function defaultDoneReceiptsWithWp07() {
  return {
    ...defaultDoneReceiptsThroughWp06(),
    'WP-07': wp07TxnReceipt,
  };
}

function liveWp07OperationalProgress() {
  if (!pathExists(wp07TxnReceipt)) {
    return {
      exists: false,
      EffectiveDone: false,
      expectedCoreProgressPercent: EXPECTED_CURRENT_CORE_PROGRESS,
    };
  }
  const receipt = readJson(wp07TxnReceipt);
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
  if (!pathExists(wp07TxnReceipt)) {
    return { ok: false, failureReason: FailureReason.WP07_RECEIPT_MISSING };
  }
  const before = readJson(wp07TxnReceipt);
  const cas = runRunner([
    'receipt-cas',
    '--receipt',
    wp07TxnReceipt,
    '--expected-revision',
    String(before.revision || 1),
    '--expected-state',
    String(before.state || 'INIT'),
    '--state',
    'DONE',
    '--set-json',
    JSON.stringify({ EffectiveDone: true, coreProgressPercent: 56 }),
  ]);
  const after = pathExists(wp07TxnReceipt) ? readJson(wp07TxnReceipt) : null;
  return {
    ok: cas.status !== 0 && after && after.EffectiveDone !== true,
    status: cas.status,
    combined: cas.combined,
    after,
    failureReason:
      cas.status === 0 || (after && after.EffectiveDone === true)
        ? FailureReason.WP07_EFFECTIVE_DONE_FORGED
        : null,
  };
}

function initTempWp07Receipt() {
  const receipt = path.join(
    os.tmpdir(),
    `wp07-red-${process.pid}-${Date.now()}.json`,
  );
  const init = runRunner(['receipt-init', '--task', TASK_ID, '--receipt', receipt]);
  return { receipt, init };
}

module.exports = {
  repoRoot,
  runnerPath,
  catalogPath,
  schemaPath,
  runtimePath,
  hmiPatcherPath,
  runtimeTestPath,
  visualLayerDocPath,
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
  TASK_ID,
  EXPECTED_CURRENT_CORE_PROGRESS,
  EXPECTED_WEIGHT_FROM_PROGRESS_TABLE,
  EXPECTED_PROGRESS_WHEN_DONE,
  WP07_PRODUCTION_CREATE_REL_PATHS,
  WP07_UNIT_TEST_REL_PATHS,
  WP07_SPEC_ACCEPTANCE,
  WP07_METHODS,
  WP07_UI_STATES,
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
  loadWp07CatalogEntry,
  parseWp07CatalogIdentity,
  readPrerequisiteDone,
  listMissingProductionCreates,
  assertWp07RuntimePresent,
  assertWp07RuntimeApiCapacity,
  assertWp07PollContract,
  assertWp07UiStateContract,
  assertWp07HmiInjectCapacity,
  assertWp07ProductionSurfacesPresent,
  assertWp07FullProductionCapacity,
  computeCoreProgress,
  defaultDoneReceiptsThroughWp06,
  defaultDoneReceiptsWithWp07,
  liveWp07OperationalProgress,
  attemptCallerForgeEffectiveDone,
  initTempWp07Receipt,
};
