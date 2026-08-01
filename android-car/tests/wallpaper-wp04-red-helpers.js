'use strict';

/**
 * Helpers for WP-04 / RED-01 contracts.
 *
 * Spec sources (read-only — never invent task definition):
 *   - WALLPAPER-PLUGIN-PROGRESS: WP-04 weight 10%, E1;
 *     "Mineradio Smali bridge、action-token registry、trusted local WebView；
 *      token 不等于 user-gesture proof"; RED: token TTL/一次性/并发 fixture
 *   - WALLPAPER-PLUGIN-DEVELOPMENT Task 4: contract / patcher / Smali bridge /
 *     bridge test / build-car-apk.sh wire; action registry max 16, TTL 10 min
 *
 * Catalog fields are read dynamically. Production paths come only from Task 4
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
 * Task 4 production files (DEVELOPMENT.zh-CN "Files:" list).
 * Relative to monorepo root.
 */
const WP04_PRODUCTION_REL_PATHS = Object.freeze([
  'android-car/scripts/wallpaper-plugin-contract.js',
  'android-car/scripts/patch-wallpaper-plugin-bridge.js',
  'android-car/scripts/smali/com/mineradio/app/car/CarWallpaperPluginBridge.smali',
]);

/** Task 4 production contract test (GREEN must add; RED asserts absence/gap). */
const WP04_UNIT_TEST_REL_PATHS = Object.freeze([
  'android-car/tests/wallpaper-plugin-bridge.test.js',
]);

/** Build wire: patcher after audio-focus bridge, before apktool build. */
const BUILD_CAR_APK_REL = 'android-car/scripts/build-car-apk.sh';
const BUILD_WIRE_MARKER = 'patch-wallpaper-plugin-bridge.js';

/**
 * Task 4 Interfaces — frozen JS bridge method surface (local Mineradio names).
 * Spec §3.2 / Task 4 Interfaces (not invented).
 */
const WP04_JS_BRIDGE_METHODS = Object.freeze([
  'ping',
  'status',
  'renewAction',
  'importMpkg',
  'installPlugin',
  'confirmUserAction',
  'openLibrary',
  'applyCurrent',
  'next',
  'previous',
  'stop',
  'diagnostics',
]);

/**
 * wallpaper-plugin-contract.js frozen exports from Task 4 (must match when GREEN).
 */
const WP04_CONTRACT_METHODS = Object.freeze([
  'ping',
  'status',
  'renew_action',
  'import_mpkg',
  'open_library',
  'apply_current',
  'next',
  'previous',
  'stop',
  'diagnostics',
]);

/** WP-01/WP-02 inputs WP-04 consumes (plugin protocol authority + package). */
const WP04_REQUIRED_PLUGIN_INPUTS = Object.freeze([
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

const TASK_ID = 'WP-04';
/** Progress table: WP-00(4)+WP-01(6)+WP-02(8)+WP-03(8)=26; WP-04 +10 → 36 when DONE. */
const EXPECTED_CURRENT_CORE_PROGRESS = 26;
const EXPECTED_WEIGHT_FROM_PROGRESS_TABLE = 10;
const EXPECTED_PROGRESS_WHEN_DONE = 36;

const FailureReason = Object.freeze({
  WP04_CATALOG_ENTRY_MISSING: 'WP04_CATALOG_ENTRY_MISSING',
  WP04_CATALOG_FIELD_MISSING: 'WP04_CATALOG_FIELD_MISSING',
  WP04_PRODUCTION_SURFACE_MISSING: 'WP04_PRODUCTION_SURFACE_MISSING',
  WP04_UNIT_TEST_MISSING: 'WP04_UNIT_TEST_MISSING',
  WP04_CONTRACT_SURFACE_MISSING: 'WP04_CONTRACT_SURFACE_MISSING',
  WP04_SMALI_BRIDGE_MISSING: 'WP04_SMALI_BRIDGE_MISSING',
  WP04_PATCHER_MISSING: 'WP04_PATCHER_MISSING',
  WP04_BUILD_WIRE_MISSING: 'WP04_BUILD_WIRE_MISSING',
  WP04_TOKEN_REGISTRY_MISSING: 'WP04_TOKEN_REGISTRY_MISSING',
  WP04_TRUSTED_BRIDGE_POLICY_MISSING: 'WP04_TRUSTED_BRIDGE_POLICY_MISSING',
  WP04_INPUT_MISSING: 'WP04_INPUT_MISSING',
  WP04_PREREQUISITE_NOT_DONE: 'WP04_PREREQUISITE_NOT_DONE',
  WP04_RECEIPT_MISSING: 'WP04_RECEIPT_MISSING',
  WP04_EFFECTIVE_DONE_FORGED: 'WP04_EFFECTIVE_DONE_FORGED',
  WP04_PROGRESS_FORGED: 'WP04_PROGRESS_FORGED',
  WP04_GATE_SKIPPED: 'WP04_GATE_SKIPPED',
  CALLER_DECLARED_DONE: 'CALLER_DECLARED_DONE',
  CALLER_FORGED_IDENTITY: 'CALLER_FORGED_IDENTITY',
  FAIL_CLOSED: 'FAIL_CLOSED',
});

/**
 * Spec-derived acceptance tokens for GREEN (not invented catalog fields).
 * Progress table weight 10% / E1; Task 4 registry + trusted WebView policy.
 */
const WP04_SPEC_ACCEPTANCE = Object.freeze({
  weightPercentFromProgressTable: EXPECTED_WEIGHT_FROM_PROGRESS_TABLE,
  evidenceLevelFromProgressTable: 'E1',
  milestone:
    'Mineradio Smali bridge、action-token registry、trusted local WebView；token 不等于 user-gesture proof',
  productionRelPaths: WP04_PRODUCTION_REL_PATHS,
  unitTestRelPaths: WP04_UNIT_TEST_REL_PATHS,
  jsBridgeMethods: WP04_JS_BRIDGE_METHODS,
  contractMethods: WP04_CONTRACT_METHODS,
  jsInterfaceName: 'WallpaperPlugin',
  protocolVersion: 1,
  authority: 'com.motif.wallpaperengine.control',
  pluginPackage: 'com.motif.wallpaperengine',
  enginePackage: 'io.wallpaperengine.weclient',
  actionRegistryMaxEntries: 16,
  actionTokenTtlMinutes: 10,
  actionTokenIsNotUserGestureProof: true,
  pendingIntentMustNotJsonSerialize: true,
  statusMustNotImplicitRenew: true,
  smaliClassPath: 'com/mineradio/app/car/CarWallpaperPluginBridge.smali',
  landscapeWebActivityFixture: 'LandscapeWebActivity.smali',
  requiredEffectiveDone: Object.freeze([
    'WP-INFRA',
    'WP-00',
    'WP-01',
    'WP-02',
    'WP-03',
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

function contractPath(cwd = repoRoot) {
  return absFromRepo('android-car/scripts/wallpaper-plugin-contract.js', cwd);
}

function patcherPath(cwd = repoRoot) {
  return absFromRepo('android-car/scripts/patch-wallpaper-plugin-bridge.js', cwd);
}

function smaliBridgePath(cwd = repoRoot) {
  return absFromRepo(
    'android-car/scripts/smali/com/mineradio/app/car/CarWallpaperPluginBridge.smali',
    cwd,
  );
}

function bridgeUnitTestPath(cwd = repoRoot) {
  return absFromRepo('android-car/tests/wallpaper-plugin-bridge.test.js', cwd);
}

function buildCarApkPath(cwd = repoRoot) {
  return absFromRepo(BUILD_CAR_APK_REL, cwd);
}

function loadWp04CatalogEntry(catalogFile = catalogPath) {
  if (!pathExists(catalogFile)) {
    return {
      ok: false,
      failureReason: FailureReason.WP04_CATALOG_ENTRY_MISSING,
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
      failureReason: FailureReason.WP04_CATALOG_ENTRY_MISSING,
      message: `catalog must contain exactly one ${TASK_ID} entry (found ${matches.length})`,
      task: null,
      taskCount: tasks.length,
      taskIds: tasks.map((t) => t && t.taskId).filter(Boolean),
    };
  }
  return { ok: true, task: matches[0], catalog };
}

function parseWp04CatalogIdentity(catalogFile = catalogPath) {
  const loaded = loadWp04CatalogEntry(catalogFile);
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
      failureReason: FailureReason.WP04_CATALOG_FIELD_MISSING,
      message: `WP-04 catalog missing fields: ${missing.join(',')}`,
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
    wp03.taskId === 'WP-03';
  return {
    ok,
    failureReason: ok ? null : FailureReason.WP04_PREREQUISITE_NOT_DONE,
    WP_INFRA: {
      EffectiveGate: infra.EffectiveGate,
      EffectiveDone: infra.EffectiveDone,
      state: infra.state,
    },
    'WP-00': { EffectiveDone: wp00.EffectiveDone },
    'WP-01': { EffectiveDone: wp01.EffectiveDone, state: wp01.state },
    'WP-02': { EffectiveDone: wp02.EffectiveDone, state: wp02.state },
    'WP-03': { EffectiveDone: wp03.EffectiveDone, state: wp03.state },
  };
}

function liveWp04OperationalProgress() {
  if (!pathExists(wp04TxnReceipt)) {
    return {
      exists: false,
      EffectiveDone: false,
      state: null,
      receipt: null,
    };
  }
  const receipt = readJson(wp04TxnReceipt);
  return {
    exists: true,
    EffectiveDone: receipt.EffectiveDone === true,
    state: receipt.state || null,
    receipt,
  };
}

function listMissingProductionSources(cwd = repoRoot) {
  return WP04_PRODUCTION_REL_PATHS.filter((rel) => !pathExists(absFromRepo(rel, cwd)));
}

function listMissingUnitTests(cwd = repoRoot) {
  return WP04_UNIT_TEST_REL_PATHS.filter((rel) => !pathExists(absFromRepo(rel, cwd)));
}

function listMissingInputs(cwd = repoRoot) {
  return WP04_REQUIRED_PLUGIN_INPUTS.filter((rel) => !pathExists(absFromRepo(rel, cwd)));
}

function assertWp04ProductionSurfacesPresent(cwd = repoRoot) {
  const missing = listMissingProductionSources(cwd);
  if (missing.length) {
    return {
      ok: false,
      failureReason: FailureReason.WP04_PRODUCTION_SURFACE_MISSING,
      message: `WP-04 production sources not implemented: ${missing.join(', ')}`,
      missing,
      EffectiveDone: false,
    };
  }
  return { ok: true, missing: [], EffectiveDone: false };
}

function assertWp04UnitTestsPresent(cwd = repoRoot) {
  const missing = listMissingUnitTests(cwd);
  if (missing.length) {
    return {
      ok: false,
      failureReason: FailureReason.WP04_UNIT_TEST_MISSING,
      message: `WP-04 unit tests not present: ${missing.join(', ')}`,
      missing,
      EffectiveDone: false,
    };
  }
  return { ok: true, missing: [], EffectiveDone: false };
}

function assertWp04ContractPresent(cwd = repoRoot) {
  const p = contractPath(cwd);
  if (!pathExists(p)) {
    return {
      ok: false,
      failureReason: FailureReason.WP04_CONTRACT_SURFACE_MISSING,
      message: `WP-04 contract missing: ${p}`,
      EffectiveDone: false,
    };
  }
  return { ok: true, path: p, EffectiveDone: false };
}

function assertWp04PatcherPresent(cwd = repoRoot) {
  const p = patcherPath(cwd);
  if (!pathExists(p)) {
    return {
      ok: false,
      failureReason: FailureReason.WP04_PATCHER_MISSING,
      message: `WP-04 patcher missing: ${p}`,
      EffectiveDone: false,
    };
  }
  return { ok: true, path: p, EffectiveDone: false };
}

function assertWp04SmaliBridgePresent(cwd = repoRoot) {
  const p = smaliBridgePath(cwd);
  if (!pathExists(p)) {
    return {
      ok: false,
      failureReason: FailureReason.WP04_SMALI_BRIDGE_MISSING,
      message: `WP-04 Smali bridge missing: ${p}`,
      EffectiveDone: false,
    };
  }
  return { ok: true, path: p, EffectiveDone: false };
}

function assertWp04BuildWirePresent(cwd = repoRoot) {
  const p = buildCarApkPath(cwd);
  if (!pathExists(p)) {
    return {
      ok: false,
      failureReason: FailureReason.WP04_BUILD_WIRE_MISSING,
      message: `build-car-apk.sh missing: ${p}`,
      EffectiveDone: false,
    };
  }
  const text = readText(p);
  if (!text.includes(BUILD_WIRE_MARKER)) {
    return {
      ok: false,
      failureReason: FailureReason.WP04_BUILD_WIRE_MISSING,
      message:
        `build-car-apk.sh must invoke ${BUILD_WIRE_MARKER} after patch-audio-focus-bridge ` +
        'and before apktool build (Task 4 GREEN)',
      EffectiveDone: false,
    };
  }
  return { ok: true, path: p, EffectiveDone: false };
}

function assertWp04RequiredInputs(cwd = repoRoot) {
  const missing = listMissingInputs(cwd);
  if (missing.length) {
    return {
      ok: false,
      failureReason: FailureReason.WP04_INPUT_MISSING,
      message: `WP-04 required inputs missing: ${missing.join(', ')}`,
      missing,
    };
  }
  return { ok: true, missing: [] };
}

/**
 * Load production contract when present. RED: null → capacity gap.
 * Does not invent a second protocol surface.
 */
function loadPluginContract(cwd = repoRoot) {
  const p = contractPath(cwd);
  if (!pathExists(p)) return null;
  delete require.cache[require.resolve(p)];
  return require(p);
}

/**
 * Token registry / TTL / one-shot / concurrency fixtures (spec RED focus).
 * Without production patcher+registry, returns stable WP04_TOKEN_REGISTRY_MISSING.
 * GREEN must implement registry that satisfies these probes.
 */
function assertActionTokenRegistryFixtures(options = {}) {
  const cwd = options.cwd || repoRoot;
  const surface = options.surface || loadPluginContract(cwd);
  const patcher = pathExists(patcherPath(cwd));
  const smali = pathExists(smaliBridgePath(cwd));

  if (!surface || !patcher || !smali) {
    return {
      ok: false,
      failureReason: FailureReason.WP04_TOKEN_REGISTRY_MISSING,
      message:
        'WP-04 action-token registry capacity missing ' +
        '(contract/patcher/smali); cannot exercise TTL/one-shot/concurrency fixtures',
      EffectiveDone: false,
      expected: {
        maxEntries: WP04_SPEC_ACCEPTANCE.actionRegistryMaxEntries,
        ttlMinutes: WP04_SPEC_ACCEPTANCE.actionTokenTtlMinutes,
        oneShot: true,
        concurrentUnique: true,
        pendingIntentNotJson: true,
        notUserGestureProof: true,
      },
    };
  }

  // When GREEN provides surface.actionTokenRegistry fixtures, probe them.
  const registry = surface.actionTokenRegistry || surface.assertActionTokenRegistry;
  if (typeof registry !== 'function' && typeof registry !== 'object') {
    return {
      ok: false,
      failureReason: FailureReason.WP04_TOKEN_REGISTRY_MISSING,
      message:
        'WP-04 contract present but action-token registry fixture API missing ' +
        '(max 16 / TTL 10m / one-shot / concurrent uniqueness)',
      EffectiveDone: false,
    };
  }

  if (typeof surface.assertActionTokenRegistry === 'function') {
    const r = surface.assertActionTokenRegistry({
      maxEntries: WP04_SPEC_ACCEPTANCE.actionRegistryMaxEntries,
      ttlMinutes: WP04_SPEC_ACCEPTANCE.actionTokenTtlMinutes,
    });
    if (!r || r.ok !== true) {
      return {
        ok: false,
        failureReason: FailureReason.WP04_TOKEN_REGISTRY_MISSING,
        message: (r && r.message) || 'action token registry fixtures failed',
        EffectiveDone: false,
        detail: r,
      };
    }
    return { ok: true, EffectiveDone: false, detail: r };
  }

  return {
    ok: false,
    failureReason: FailureReason.WP04_TOKEN_REGISTRY_MISSING,
    message: 'actionTokenRegistry fixture not callable',
    EffectiveDone: false,
  };
}

/**
 * Trusted local WebView policy fixtures (Task 4 RED):
 * fixed local asset URL, top-level frame, page nonce; strip bridge on nav;
 * external login without high-privilege bridge; fail-closed non-allowlist.
 */
function assertTrustedBridgePolicyFixtures(options = {}) {
  const cwd = options.cwd || repoRoot;
  const patcher = pathExists(patcherPath(cwd));
  const smali = pathExists(smaliBridgePath(cwd));
  if (!patcher || !smali) {
    return {
      ok: false,
      failureReason: FailureReason.WP04_TRUSTED_BRIDGE_POLICY_MISSING,
      message:
        'WP-04 TrustedWallpaperBridgePolicy capacity missing; ' +
        'cannot assert allowlist/top-frame/nonce/strip-on-nav fail-closed fixtures',
      EffectiveDone: false,
      expected: {
        jsInterfaceName: WP04_SPEC_ACCEPTANCE.jsInterfaceName,
        stripOnNavigation: true,
        topLevelFrameOnly: true,
        externalLoginWithoutBridge: true,
        nonAllowlistFailClosed: true,
      },
    };
  }

  let surface = null;
  try {
    if (pathExists(patcherPath(cwd))) {
      delete require.cache[require.resolve(patcherPath(cwd))];
      surface = require(patcherPath(cwd));
    }
  } catch {
    surface = null;
  }

  if (!surface || typeof surface.assertTrustedWallpaperBridgePolicy !== 'function') {
    return {
      ok: false,
      failureReason: FailureReason.WP04_TRUSTED_BRIDGE_POLICY_MISSING,
      message:
        'patcher present but assertTrustedWallpaperBridgePolicy missing ' +
        '(GREEN must export policy fixtures)',
      EffectiveDone: false,
    };
  }

  const r = surface.assertTrustedWallpaperBridgePolicy({ cwd });
  if (!r || r.ok !== true) {
    return {
      ok: false,
      failureReason: FailureReason.WP04_TRUSTED_BRIDGE_POLICY_MISSING,
      message: (r && r.message) || 'trusted bridge policy fixtures failed',
      EffectiveDone: false,
      detail: r,
    };
  }
  return { ok: true, EffectiveDone: false, detail: r };
}

/**
 * Attempt caller forge of EffectiveDone / progress on a temp INIT receipt.
 * Prefer temp receipt so operational DONE state (if any) is not mutated wrongly.
 */
function attemptCallerForgeEffectiveDone(receiptPath) {
  const target = receiptPath || initTempWp04Receipt().receipt;
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

function defaultDoneReceiptsThroughWp03() {
  return {
    'WP-00': wp00MergeReceipt,
    'WP-01': wp01TxnReceipt,
    'WP-02': wp02TxnReceipt,
    'WP-03': wp03TxnReceipt,
  };
}

function defaultDoneReceiptsWithWp04() {
  return {
    ...defaultDoneReceiptsThroughWp03(),
    'WP-04': wp04TxnReceipt,
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

function initTempWp04Receipt(taskId = TASK_ID) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp04-red-'));
  const receipt = path.join(dir, `${taskId.toLowerCase()}.json`);
  const init = runRunner(['receipt-init', '--task', taskId, '--receipt', receipt]);
  return { receipt, init, dir };
}

function ensureOperationalWp04Receipt() {
  if (pathExists(wp04TxnReceipt)) {
    return { created: false, path: wp04TxnReceipt, receipt: readJson(wp04TxnReceipt) };
  }
  // cmd_init is a no-op identity fence; durable txn file requires receipt-init.
  const init = runRunner([
    'receipt-init',
    '--task',
    TASK_ID,
    '--receipt',
    wp04TxnReceipt,
  ]);
  return {
    created: true,
    path: wp04TxnReceipt,
    init,
    receipt: pathExists(wp04TxnReceipt) ? readJson(wp04TxnReceipt) : null,
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
  TASK_ID,
  EXPECTED_CURRENT_CORE_PROGRESS,
  EXPECTED_WEIGHT_FROM_PROGRESS_TABLE,
  EXPECTED_PROGRESS_WHEN_DONE,
  WP04_PRODUCTION_REL_PATHS,
  WP04_UNIT_TEST_REL_PATHS,
  WP04_JS_BRIDGE_METHODS,
  WP04_CONTRACT_METHODS,
  WP04_REQUIRED_PLUGIN_INPUTS,
  WP04_SPEC_ACCEPTANCE,
  BUILD_WIRE_MARKER,
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
  contractPath,
  patcherPath,
  smaliBridgePath,
  bridgeUnitTestPath,
  buildCarApkPath,
  loadWp04CatalogEntry,
  parseWp04CatalogIdentity,
  readPrerequisiteDone,
  liveWp04OperationalProgress,
  listMissingProductionSources,
  listMissingUnitTests,
  listMissingInputs,
  assertWp04ProductionSurfacesPresent,
  assertWp04UnitTestsPresent,
  assertWp04ContractPresent,
  assertWp04PatcherPresent,
  assertWp04SmaliBridgePresent,
  assertWp04BuildWirePresent,
  assertWp04RequiredInputs,
  loadPluginContract,
  assertActionTokenRegistryFixtures,
  assertTrustedBridgePolicyFixtures,
  attemptCallerForgeEffectiveDone,
  attemptSkipInfraGate,
  computeCoreProgress,
  defaultDoneReceiptsThroughWp03,
  defaultDoneReceiptsWithWp04,
  parseRunnerJson,
  initTempWp04Receipt,
  ensureOperationalWp04Receipt,
};
