'use strict';

/**
 * Helpers for WP-05 / RED-01 contracts.
 *
 * Spec sources (read-only — never invent task definition):
 *   - WALLPAPER-PLUGIN-PROGRESS: WP-05 weight 8%, E1;
 *     "Mineradio FileProvider、URI 两跳、grant/revoke 与 24h 清理";
 *     RED: Provider/URI 生命周期契约测试
 *   - WALLPAPER-PLUGIN-DEVELOPMENT Task 5: paths XML / stager Smali /
 *     patcher + manifest + bridge modify / wallpaper-plugin-file-provider.test.js;
 *     authority com.mineradio.app.wallpaperplugin.files; content:// only;
 *     grant to plugin package; revoke on sourceConsumed; 24h cleanup
 *
 * Catalog fields are read dynamically. Production paths come only from Task 5
 * Files: list — not guessed feature surfaces.
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

/**
 * Task 5 production files (DEVELOPMENT.zh-CN "Files:" list — Create rows).
 * Relative to monorepo root. Modify rows are asserted via capacity markers.
 */
const WP05_PRODUCTION_CREATE_REL_PATHS = Object.freeze([
  'android-car/scripts/resources/xml/wallpaper_plugin_paths.xml',
  'android-car/scripts/smali/com/mineradio/app/car/CarWallpaperMpkgStager.smali',
]);

/** Task 5 Files: Modify rows (must exist as WP-04 surfaces; GREEN extends capacity). */
const WP05_PRODUCTION_MODIFY_REL_PATHS = Object.freeze([
  'android-car/scripts/patch-wallpaper-plugin-bridge.js',
  'android-car/scripts/patch-apk-manifest.js',
  'android-car/scripts/smali/com/mineradio/app/car/CarWallpaperPluginBridge.smali',
]);

/** Task 5 RED/GREEN unit contract test path. */
const WP05_UNIT_TEST_REL_PATHS = Object.freeze([
  'android-car/tests/wallpaper-plugin-file-provider.test.js',
]);

/** Inputs already present from WP-01…WP-04 (must not be self-injury). */
const WP05_REQUIRED_INPUT_REL_PATHS = Object.freeze([
  'android-car/scripts/wallpaper-plugin-contract.js',
  'android-car/scripts/smali/com/mineradio/app/car/CarWallpaperPluginBridge.smali',
  'android-car/scripts/patch-wallpaper-plugin-bridge.js',
  'android-car/scripts/patch-apk-manifest.js',
  path.join(
    'wallpaper-plugin',
    'app',
    'src',
    'main',
    'java',
    'com',
    'motif',
    'wallpaperengine',
    'plugin',
    'PluginContract.kt',
  ),
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

const TASK_ID = 'WP-05';
/** Progress table: WP-00(4)+…+WP-04(10)=36; WP-05 +8 → 44 when DONE. */
const EXPECTED_CURRENT_CORE_PROGRESS = 36;
const EXPECTED_WEIGHT_FROM_PROGRESS_TABLE = 8;
const EXPECTED_PROGRESS_WHEN_DONE = 44;

const FailureReason = Object.freeze({
  WP05_CATALOG_ENTRY_MISSING: 'WP05_CATALOG_ENTRY_MISSING',
  WP05_CATALOG_FIELD_MISSING: 'WP05_CATALOG_FIELD_MISSING',
  WP05_PRODUCTION_SURFACE_MISSING: 'WP05_PRODUCTION_SURFACE_MISSING',
  WP05_PATHS_XML_MISSING: 'WP05_PATHS_XML_MISSING',
  WP05_STAGER_SMALI_MISSING: 'WP05_STAGER_SMALI_MISSING',
  WP05_MANIFEST_PROVIDER_MISSING: 'WP05_MANIFEST_PROVIDER_MISSING',
  WP05_PATCHER_PATHS_WIRE_MISSING: 'WP05_PATCHER_PATHS_WIRE_MISSING',
  WP05_IMPORT_MPKG_CAPACITY_MISSING: 'WP05_IMPORT_MPKG_CAPACITY_MISSING',
  WP05_UNIT_TEST_MISSING: 'WP05_UNIT_TEST_MISSING',
  WP05_INPUT_MISSING: 'WP05_INPUT_MISSING',
  WP05_PREREQUISITE_NOT_DONE: 'WP05_PREREQUISITE_NOT_DONE',
  WP05_RECEIPT_MISSING: 'WP05_RECEIPT_MISSING',
  WP05_EFFECTIVE_DONE_FORGED: 'WP05_EFFECTIVE_DONE_FORGED',
  WP05_PROGRESS_FORGED: 'WP05_PROGRESS_FORGED',
  WP05_GATE_SKIPPED: 'WP05_GATE_SKIPPED',
  CALLER_DECLARED_DONE: 'CALLER_DECLARED_DONE',
  CALLER_FORGED_IDENTITY: 'CALLER_FORGED_IDENTITY',
  FAIL_CLOSED: 'FAIL_CLOSED',
});

/**
 * Spec-derived acceptance tokens for GREEN (not invented catalog fields).
 * Progress table weight 8% / E1; Task 5 FileProvider / URI hop / grant / 24h.
 */
const WP05_SPEC_ACCEPTANCE = Object.freeze({
  weightPercentFromProgressTable: EXPECTED_WEIGHT_FROM_PROGRESS_TABLE,
  evidenceLevelFromProgressTable: 'E1',
  milestone:
    'Mineradio FileProvider、URI 两跳、grant/revoke 与 24h 清理',
  productionCreateRelPaths: WP05_PRODUCTION_CREATE_REL_PATHS,
  productionModifyRelPaths: WP05_PRODUCTION_MODIFY_REL_PATHS,
  unitTestRelPaths: WP05_UNIT_TEST_REL_PATHS,
  fileProviderClass: 'androidx.core.content.FileProvider',
  fileProviderAuthority: 'com.mineradio.app.wallpaperplugin.files',
  pathsXmlResource: '@xml/wallpaper_plugin_paths',
  pathsXmlMetaName: 'android.support.FILE_PROVIDER_PATHS',
  cachePathName: 'wallpaper_plugin_stage',
  cachePathDir: 'wallpaper_plugin_stage/',
  grantPluginPackage: 'com.motif.wallpaperengine',
  enginePackage: 'io.wallpaperengine.weclient',
  contentSchemeOnly: 'content://',
  forbiddenSchemes: Object.freeze(['file://']),
  forbidAbsolutePaths: true,
  sourceConsumedRevoke: true,
  cleanupWindowHours: 24,
  jsMethod: 'importMpkg',
  providerMethod: 'import_mpkg',
  requiredEffectiveDone: Object.freeze([
    'WP-INFRA',
    'WP-00',
    'WP-01',
    'WP-02',
    'WP-03',
    'WP-04',
  ]),
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

const TASK_BRANCH_RE = /^codex\/wallpaper-plugin-/;
const FORBIDDEN_TASK_BRANCHES = Object.freeze([
  'main',
  'master',
  'huawei-android12-car',
]);

function isGitAncestor(ancestorSha, descendantSha, cwd = repoRoot) {
  const r = git(['merge-base', '--is-ancestor', ancestorSha, descendantSha], cwd);
  return r.status === 0;
}

function classifyHeadVsLiveBase(headSha, liveSha, flags = {}) {
  const head = String(headSha || '').toLowerCase();
  const live = String(liveSha || '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(head) || !/^[0-9a-f]{40}$/.test(live)) {
    return { ok: false, relation: 'invalid', failureReason: 'INVALID_SHA' };
  }
  if (head === live) {
    return { ok: true, relation: 'equal', failureReason: null };
  }
  if (flags.liveIsAncestorOfHead === true) {
    return { ok: true, relation: 'ahead', failureReason: null };
  }
  if (flags.headIsAncestorOfLive === true) {
    return {
      ok: false,
      relation: 'behind',
      failureReason: 'HEAD_BEHIND_LIVE_BASE',
    };
  }
  return {
    ok: false,
    relation: 'diverged',
    failureReason: 'HEAD_DIVERGED_FROM_LIVE_BASE',
  };
}

function isAllowedTaskBranch(branchName) {
  const branch = String(branchName || '');
  if (!branch || FORBIDDEN_TASK_BRANCHES.includes(branch)) {
    return { ok: false, failureReason: 'TASK_BRANCH_REJECTED', branch };
  }
  if (!TASK_BRANCH_RE.test(branch)) {
    return { ok: false, failureReason: 'TASK_BRANCH_REJECTED', branch };
  }
  return { ok: true, branch, failureReason: null };
}

/**
 * Live worktree identity: origin ls-remote base + task branch + ancestor relation.
 * Caller claims for base/HEAD/REMOTE_VERIFIED/merged are rejected (fail-closed).
 */
function readTaskWorktreeIdentity(options = {}) {
  if (
    options.claimedLiveBase != null ||
    options.claimedHead != null ||
    options.liveBaseSha != null ||
    options.headSha != null ||
    options.REMOTE_VERIFIED != null ||
    options.merged != null
  ) {
    return {
      ok: false,
      failureReason: FailureReason.CALLER_FORGED_IDENTITY,
      message: 'caller cannot inject base/HEAD/REMOTE_VERIFIED/merged',
    };
  }

  const branchResult = git(['branch', '--show-current']);
  if (branchResult.status !== 0) {
    return {
      ok: false,
      failureReason: 'BRANCH_READ_FAILED',
      message: branchResult.combined,
    };
  }
  const branchCheck = isAllowedTaskBranch(branchResult.stdout);
  if (!branchCheck.ok) return branchCheck;

  const headResult = git(['rev-parse', 'HEAD']);
  if (headResult.status !== 0 || !/^[0-9a-f]{40}$/i.test(headResult.stdout)) {
    return {
      ok: false,
      failureReason: 'HEAD_READ_FAILED',
      message: headResult.combined,
    };
  }
  const head = headResult.stdout.toLowerCase();

  let live;
  try {
    live = liveAuthoritativeBaseSha();
  } catch (err) {
    return {
      ok: false,
      failureReason: 'LIVE_BASE_READ_FAILED',
      message: String(err && err.message),
    };
  }

  const liveIsAncestorOfHead = isGitAncestor(live, head);
  const headIsAncestorOfLive = head !== live && isGitAncestor(head, live);
  const relation = classifyHeadVsLiveBase(head, live, {
    liveIsAncestorOfHead,
    headIsAncestorOfLive,
  });

  return {
    ok: relation.ok && branchCheck.ok,
    branch: branchCheck.branch,
    head,
    liveBaseSha: live,
    relation: relation.relation,
    failureReason: relation.ok ? null : relation.failureReason,
    liveIsAncestorOfHead,
    headIsAncestorOfLive,
  };
}

function absFromRepo(rel, cwd = repoRoot) {
  return path.join(cwd, rel);
}

function pathsXmlPath(cwd = repoRoot) {
  return absFromRepo(WP05_PRODUCTION_CREATE_REL_PATHS[0], cwd);
}

function stagerSmaliPath(cwd = repoRoot) {
  return absFromRepo(WP05_PRODUCTION_CREATE_REL_PATHS[1], cwd);
}

function patcherPath(cwd = repoRoot) {
  return absFromRepo('android-car/scripts/patch-wallpaper-plugin-bridge.js', cwd);
}

function manifestPatcherPath(cwd = repoRoot) {
  return absFromRepo('android-car/scripts/patch-apk-manifest.js', cwd);
}

function smaliBridgePath(cwd = repoRoot) {
  return absFromRepo(
    'android-car/scripts/smali/com/mineradio/app/car/CarWallpaperPluginBridge.smali',
    cwd,
  );
}

function fileProviderUnitTestPath(cwd = repoRoot) {
  return absFromRepo(WP05_UNIT_TEST_REL_PATHS[0], cwd);
}

function loadWp05CatalogEntry(catalogFile = catalogPath) {
  if (!pathExists(catalogFile)) {
    return {
      ok: false,
      failureReason: FailureReason.WP05_CATALOG_ENTRY_MISSING,
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
      failureReason: FailureReason.WP05_CATALOG_ENTRY_MISSING,
      message: `catalog must contain exactly one ${TASK_ID} entry (found ${matches.length})`,
      task: null,
      taskCount: tasks.length,
      taskIds: tasks.map((t) => t && t.taskId).filter(Boolean),
    };
  }
  return { ok: true, task: matches[0], catalog };
}

function parseWp05CatalogIdentity(catalogFile = catalogPath) {
  const loaded = loadWp05CatalogEntry(catalogFile);
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
      failureReason: FailureReason.WP05_CATALOG_FIELD_MISSING,
      message: `WP-05 catalog missing fields: ${missing.join(',')}`,
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
    inputs: task.inputs,
    outputs: task.outputs,
    task,
  };
}

function readPrerequisiteDone() {
  const infra = readJson(finalInfraReceipt);
  const wp00 = readJson(wp00MergeReceipt);
  const wp01 = readJson(wp01TxnReceipt);
  const wp02 = readJson(wp02TxnReceipt);
  const wp03 = readJson(wp03TxnReceipt);
  const wp04 = readJson(wp04TxnReceipt);
  const ok =
    infra.EffectiveGate === true &&
    infra.EffectiveDone === true &&
    infra.state === 'DONE' &&
    wp00.EffectiveDone === true &&
    wp01.EffectiveDone === true &&
    wp01.state === 'DONE' &&
    wp02.EffectiveDone === true &&
    wp02.state === 'DONE' &&
    wp02.taskId === 'WP-02' &&
    wp03.EffectiveDone === true &&
    wp03.state === 'DONE' &&
    wp03.taskId === 'WP-03' &&
    wp04.EffectiveDone === true &&
    wp04.state === 'DONE' &&
    wp04.taskId === 'WP-04';
  return {
    ok,
    failureReason: ok ? null : FailureReason.WP05_PREREQUISITE_NOT_DONE,
    WP_INFRA: {
      EffectiveGate: infra.EffectiveGate,
      EffectiveDone: infra.EffectiveDone,
      state: infra.state,
    },
    'WP-00': { EffectiveDone: wp00.EffectiveDone },
    'WP-01': { EffectiveDone: wp01.EffectiveDone, state: wp01.state },
    'WP-02': { EffectiveDone: wp02.EffectiveDone, state: wp02.state },
    'WP-03': { EffectiveDone: wp03.EffectiveDone, state: wp03.state },
    'WP-04': { EffectiveDone: wp04.EffectiveDone, state: wp04.state },
  };
}

function liveWp05OperationalProgress() {
  if (!pathExists(wp05TxnReceipt)) {
    return {
      exists: false,
      EffectiveDone: false,
      state: null,
      receipt: null,
    };
  }
  const receipt = readJson(wp05TxnReceipt);
  return {
    exists: true,
    EffectiveDone: receipt.EffectiveDone === true,
    state: receipt.state || null,
    receipt,
  };
}

function listMissingProductionCreates(cwd = repoRoot) {
  return WP05_PRODUCTION_CREATE_REL_PATHS.filter((rel) => !pathExists(absFromRepo(rel, cwd)));
}

function listMissingUnitTests(cwd = repoRoot) {
  return WP05_UNIT_TEST_REL_PATHS.filter((rel) => !pathExists(absFromRepo(rel, cwd)));
}

function listMissingInputs(cwd = repoRoot) {
  return WP05_REQUIRED_INPUT_REL_PATHS.filter((rel) => !pathExists(absFromRepo(rel, cwd)));
}

function assertWp05RequiredInputs(cwd = repoRoot) {
  const missing = listMissingInputs(cwd);
  if (missing.length) {
    return {
      ok: false,
      failureReason: FailureReason.WP05_INPUT_MISSING,
      message: `WP-05 required inputs missing: ${missing.join(', ')}`,
      missing,
    };
  }
  return { ok: true, missing: [] };
}

/**
 * GREEN must create paths XML + stager Smali (Task 5 Files Create:).
 */
function assertWp05ProductionSurfacesPresent(cwd = repoRoot) {
  const missing = listMissingProductionCreates(cwd);
  if (missing.length) {
    return {
      ok: false,
      failureReason: FailureReason.WP05_PRODUCTION_SURFACE_MISSING,
      message: `WP-05 production sources not implemented: ${missing.join(', ')}`,
      missing,
      EffectiveDone: false,
    };
  }
  return { ok: true, missing: [], EffectiveDone: false };
}

function assertWp05PathsXmlCapacity(cwd = repoRoot) {
  const p = pathsXmlPath(cwd);
  if (!pathExists(p)) {
    return {
      ok: false,
      failureReason: FailureReason.WP05_PATHS_XML_MISSING,
      message: `WP-05 paths XML missing: ${p}`,
      EffectiveDone: false,
    };
  }
  const text = readText(p);
  const hasCachePath =
    text.includes('cache-path') &&
    text.includes(WP05_SPEC_ACCEPTANCE.cachePathName) &&
    text.includes(WP05_SPEC_ACCEPTANCE.cachePathDir);
  if (!hasCachePath) {
    return {
      ok: false,
      failureReason: FailureReason.WP05_PATHS_XML_MISSING,
      message:
        'wallpaper_plugin_paths.xml must expose only cache-path ' +
        `${WP05_SPEC_ACCEPTANCE.cachePathName} → ${WP05_SPEC_ACCEPTANCE.cachePathDir}`,
      EffectiveDone: false,
    };
  }
  // Fail-closed: no files-path / external-path expansion beyond Task 5.
  if (/<(files-path|external-path|external-files-path|root-path)\b/.test(text)) {
    return {
      ok: false,
      failureReason: FailureReason.WP05_PATHS_XML_MISSING,
      message: 'paths XML must only allow cache-path wallpaper_plugin_stage/ (Task 5)',
      EffectiveDone: false,
    };
  }
  return { ok: true, path: p, EffectiveDone: false };
}

function assertWp05StagerSmaliPresent(cwd = repoRoot) {
  const p = stagerSmaliPath(cwd);
  if (!pathExists(p)) {
    return {
      ok: false,
      failureReason: FailureReason.WP05_STAGER_SMALI_MISSING,
      message: `WP-05 CarWallpaperMpkgStager.smali missing: ${p}`,
      EffectiveDone: false,
    };
  }
  const text = readText(p);
  const markers = [
    'CarWallpaperMpkgStager',
    'wallpaper_plugin_stage',
    'sha256',
    'grantUriPermission',
  ];
  const missing = markers.filter((m) => !text.toLowerCase().includes(m.toLowerCase()));
  // Class name is required; others may appear in various cases — require class + stage dir.
  if (!text.includes('CarWallpaperMpkgStager') || !text.includes('wallpaper_plugin_stage')) {
    return {
      ok: false,
      failureReason: FailureReason.WP05_STAGER_SMALI_MISSING,
      message:
        'stager Smali must implement cache/wallpaper_plugin_stage staging capacity (Task 5 GREEN)',
      EffectiveDone: false,
      missing,
    };
  }
  return { ok: true, path: p, EffectiveDone: false };
}

/**
 * Manifest patcher must inject Mineradio FileProvider authority + meta-data.
 * Reuse AndroidX FileProvider class — do not re-inject library code.
 */
function assertWp05ManifestProviderCapacity(cwd = repoRoot) {
  const p = manifestPatcherPath(cwd);
  if (!pathExists(p)) {
    return {
      ok: false,
      failureReason: FailureReason.WP05_MANIFEST_PROVIDER_MISSING,
      message: `patch-apk-manifest.js missing: ${p}`,
      EffectiveDone: false,
    };
  }
  const text = readText(p);
  const auth = WP05_SPEC_ACCEPTANCE.fileProviderAuthority;
  const hasAuthority = text.includes(auth);
  const hasProvider =
    text.includes('FileProvider') || text.includes('androidx.core.content.FileProvider');
  const hasPathsMeta =
    text.includes('wallpaper_plugin_paths') ||
    text.includes('FILE_PROVIDER_PATHS') ||
    text.includes(WP05_SPEC_ACCEPTANCE.pathsXmlResource);
  if (!hasAuthority || !hasProvider || !hasPathsMeta) {
    return {
      ok: false,
      failureReason: FailureReason.WP05_MANIFEST_PROVIDER_MISSING,
      message:
        `patch-apk-manifest.js must inject FileProvider authority ${auth} ` +
        'with FILE_PROVIDER_PATHS → @xml/wallpaper_plugin_paths (Task 5)',
      EffectiveDone: false,
      hasAuthority,
      hasProvider,
      hasPathsMeta,
    };
  }
  return { ok: true, path: p, EffectiveDone: false };
}

/**
 * Bridge patcher must copy paths XML into decoded APK res/xml/.
 */
function assertWp05PatcherPathsWire(cwd = repoRoot) {
  const p = patcherPath(cwd);
  if (!pathExists(p)) {
    return {
      ok: false,
      failureReason: FailureReason.WP05_PATCHER_PATHS_WIRE_MISSING,
      message: `patch-wallpaper-plugin-bridge.js missing: ${p}`,
      EffectiveDone: false,
    };
  }
  const text = readText(p);
  const hasPaths =
    text.includes('wallpaper_plugin_paths.xml') ||
    text.includes('wallpaper_plugin_paths');
  const hasResXml = text.includes('res/xml') || text.includes('res' + path.sep + 'xml');
  const hasStager =
    text.includes('CarWallpaperMpkgStager') || text.includes('MpkgStager');
  if (!hasPaths || !(hasResXml || hasStager)) {
    return {
      ok: false,
      failureReason: FailureReason.WP05_PATCHER_PATHS_WIRE_MISSING,
      message:
        'patch-wallpaper-plugin-bridge.js must wire wallpaper_plugin_paths.xml ' +
        'into decoded APK res/xml/ and stager surfaces (Task 5)',
      EffectiveDone: false,
      hasPaths,
      hasResXml,
      hasStager,
    };
  }
  return { ok: true, path: p, EffectiveDone: false };
}

/**
 * importMpkg must accept content:// only, reject file:// / absolute paths,
 * and route through stager (not a code=20 stub).
 */
function assertWp05ImportMpkgCapacity(cwd = repoRoot) {
  const p = smaliBridgePath(cwd);
  if (!pathExists(p)) {
    return {
      ok: false,
      failureReason: FailureReason.WP05_IMPORT_MPKG_CAPACITY_MISSING,
      message: `CarWallpaperPluginBridge.smali missing: ${p}`,
      EffectiveDone: false,
    };
  }
  const text = readText(p);
  if (!text.includes('importMpkg')) {
    return {
      ok: false,
      failureReason: FailureReason.WP05_IMPORT_MPKG_CAPACITY_MISSING,
      message: 'Smali bridge missing importMpkg JavascriptInterface method',
      EffectiveDone: false,
    };
  }
  // Stub from WP-04 returns fixed {"code":20,"providerMethod":"import_mpkg"} — not capacity.
  const stubMarker = '"{\\"code\\":20,\\"providerMethod\\":\\"import_mpkg\\"}"';
  const stubMarkerAlt = '{"code":20,"providerMethod":"import_mpkg"}';
  const looksLikeStub =
    (text.includes(stubMarker) || text.includes(stubMarkerAlt)) &&
    !text.includes('CarWallpaperMpkgStager') &&
    !text.includes('content://');

  const hasContentScheme =
    text.includes('content://') || text.includes('content\\:\\/\\/');
  const hasFileReject =
    text.includes('file://') ||
    text.includes('file\\:\\/\\/') ||
    text.includes('FILE_URI') ||
    text.includes('absolute');
  const hasStagerCall = text.includes('CarWallpaperMpkgStager');
  const hasGrant =
    text.includes('grantUriPermission') || text.includes('FLAG_GRANT_READ');

  if (looksLikeStub || !hasContentScheme || !hasStagerCall) {
    return {
      ok: false,
      failureReason: FailureReason.WP05_IMPORT_MPKG_CAPACITY_MISSING,
      message:
        'importMpkg production capacity missing: must stage content:// URI via ' +
        'CarWallpaperMpkgStager, reject file:// / absolute paths, grant plugin read ' +
        '(Task 5 GREEN) — WP-04 stub is not WP-05 capacity',
      EffectiveDone: false,
      looksLikeStub,
      hasContentScheme,
      hasFileReject,
      hasStagerCall,
      hasGrant,
    };
  }
  return { ok: true, path: p, EffectiveDone: false };
}

function assertWp05UnitTestsPresent(cwd = repoRoot) {
  const missing = listMissingUnitTests(cwd);
  if (missing.length) {
    return {
      ok: false,
      failureReason: FailureReason.WP05_UNIT_TEST_MISSING,
      message: `WP-05 unit tests not present: ${missing.join(', ')}`,
      missing,
      EffectiveDone: false,
    };
  }
  return { ok: true, missing: [], EffectiveDone: false };
}

/**
 * Aggregate production capacity for RED gap reporting.
 */
function assertWp05FullProductionCapacity(cwd = repoRoot) {
  const creates = assertWp05ProductionSurfacesPresent(cwd);
  if (!creates.ok) return creates;
  const paths = assertWp05PathsXmlCapacity(cwd);
  if (!paths.ok) return paths;
  const stager = assertWp05StagerSmaliPresent(cwd);
  if (!stager.ok) return stager;
  const manifest = assertWp05ManifestProviderCapacity(cwd);
  if (!manifest.ok) return manifest;
  const wire = assertWp05PatcherPathsWire(cwd);
  if (!wire.ok) return wire;
  const importCap = assertWp05ImportMpkgCapacity(cwd);
  if (!importCap.ok) return importCap;
  return { ok: true, EffectiveDone: false };
}

/**
 * Attempt caller forge of EffectiveDone / progress on a temp INIT receipt.
 */
function attemptCallerForgeEffectiveDone(receiptPath) {
  const target = receiptPath || initTempWp05Receipt().receipt;
  const current = pathExists(target)
    ? readJson(target)
    : { revision: 1, state: 'INIT' };
  const cas = runRunner([
    'receipt-cas',
    '--receipt',
    target,
    '--expected-revision',
    String(current.revision || 1),
    '--expected-state',
    String(current.state || 'INIT'),
    '--state',
    'DONE',
    '--set-json',
    JSON.stringify({
      EffectiveDone: true,
      coreProgressPercent: EXPECTED_PROGRESS_WHEN_DONE,
    }),
  ]);
  const verify = runRunner(['verify-done', '--task', TASK_ID, '--receipt', target]);
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
  return { cas, verify, declare, casState, receiptPath: target };
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

function defaultDoneReceiptsThroughWp04() {
  // Catalog-weighted receipts only (WP-INFRA weight=0; not required for percent).
  return {
    'WP-00': wp00MergeReceipt,
    'WP-01': wp01TxnReceipt,
    'WP-02': wp02TxnReceipt,
    'WP-03': wp03TxnReceipt,
    'WP-04': wp04TxnReceipt,
  };
}

function defaultDoneReceiptsWithWp05() {
  return {
    ...defaultDoneReceiptsThroughWp04(),
    'WP-05': wp05TxnReceipt,
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

function initTempWp05Receipt(taskId = TASK_ID) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp05-red-'));
  const receipt = path.join(dir, `${taskId.toLowerCase()}.json`);
  const init = runRunner(['receipt-init', '--task', taskId, '--receipt', receipt]);
  return { receipt, init, dir };
}

function ensureOperationalWp05Receipt() {
  if (pathExists(wp05TxnReceipt)) {
    return { created: false, path: wp05TxnReceipt, receipt: readJson(wp05TxnReceipt) };
  }
  const init = runRunner([
    'receipt-init',
    '--task',
    TASK_ID,
    '--receipt',
    wp05TxnReceipt,
  ]);
  return {
    created: true,
    path: wp05TxnReceipt,
    init,
    receipt: pathExists(wp05TxnReceipt) ? readJson(wp05TxnReceipt) : null,
  };
}

module.exports = {
  repoRoot,
  runnerPath,
  catalogPath,
  schemaPath,
  catalogToolPath,
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
  TASK_ID,
  EXPECTED_CURRENT_CORE_PROGRESS,
  EXPECTED_WEIGHT_FROM_PROGRESS_TABLE,
  EXPECTED_PROGRESS_WHEN_DONE,
  WP05_PRODUCTION_CREATE_REL_PATHS,
  WP05_PRODUCTION_MODIFY_REL_PATHS,
  WP05_UNIT_TEST_REL_PATHS,
  WP05_REQUIRED_INPUT_REL_PATHS,
  WP05_SPEC_ACCEPTANCE,
  FailureReason,
  git,
  runPython,
  runRunner,
  readJson,
  readText,
  pathExists,
  sha256File,
  liveAuthoritativeBaseSha,
  isGitAncestor,
  classifyHeadVsLiveBase,
  isAllowedTaskBranch,
  readTaskWorktreeIdentity,
  TASK_BRANCH_RE,
  FORBIDDEN_TASK_BRANCHES,
  absFromRepo,
  pathsXmlPath,
  stagerSmaliPath,
  patcherPath,
  manifestPatcherPath,
  smaliBridgePath,
  fileProviderUnitTestPath,
  loadWp05CatalogEntry,
  parseWp05CatalogIdentity,
  readPrerequisiteDone,
  liveWp05OperationalProgress,
  listMissingProductionCreates,
  listMissingUnitTests,
  listMissingInputs,
  assertWp05RequiredInputs,
  assertWp05ProductionSurfacesPresent,
  assertWp05PathsXmlCapacity,
  assertWp05StagerSmaliPresent,
  assertWp05ManifestProviderCapacity,
  assertWp05PatcherPathsWire,
  assertWp05ImportMpkgCapacity,
  assertWp05UnitTestsPresent,
  assertWp05FullProductionCapacity,
  attemptCallerForgeEffectiveDone,
  attemptSkipInfraGate,
  computeCoreProgress,
  defaultDoneReceiptsThroughWp04,
  defaultDoneReceiptsWithWp05,
  parseRunnerJson,
  initTempWp05Receipt,
  ensureOperationalWp05Receipt,
};
