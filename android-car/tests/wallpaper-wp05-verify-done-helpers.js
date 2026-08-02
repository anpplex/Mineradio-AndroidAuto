'use strict';

/**
 * Helpers for WP-05 verify-done / CLOSE-VERIFY RED-01 contracts.
 *
 * Dynamic facts only: origin ls-remote, gh PR API, catalog/receipts on disk.
 * Caller-forged EffectiveDone / progress / merged / REMOTE_VERIFIED are never truth.
 *
 * RED-01: production evaluate_wp05_verify_done is absent — GREEN implements it.
 * Unavailable signature must be WP05_VERIFY_DONE_UNAVAILABLE (never WP04_, WP03_, or WP02_ tags).
 *
 * Implementation proof (authoritative):
 *   PR #14 · head b173d9c4… · merge/live tip cf5b4b0c…
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
const smaliStagerPath = path.join(
  repoRoot,
  'android-car',
  'scripts',
  'smali',
  'com',
  'mineradio',
  'app',
  'car',
  'CarWallpaperMpkgStager.smali',
);
const pathsXmlPath = path.join(
  repoRoot,
  'android-car',
  'scripts',
  'resources',
  'xml',
  'wallpaper_plugin_paths.xml',
);
const fileProviderTestPath = path.join(
  repoRoot,
  'android-car',
  'tests',
  'wallpaper-plugin-file-provider.test.js',
);
const bridgeUnitTestPath = path.join(
  repoRoot,
  'android-car',
  'tests',
  'wallpaper-plugin-bridge.test.js',
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

const AUTHORITATIVE_BASE_REF = 'refs/heads/huawei-android12-car';
const AUTHORITATIVE_BASE_BRANCH = 'huawei-android12-car';
const APPROVED_REPO = 'anpplex/Mineradio-AndroidAuto';
const TASK_ID = 'WP-05';
const EXPECTED_WEIGHT = 8;
/** WP-00…WP-04 = 36; +WP-05(8)=44 when EffectiveDone. */
const EXPECTED_PROGRESS_WHEN_DONE = 44;
const EXPECTED_PROGRESS_PRE_DONE = 36;
const IMPLEMENTATION_PR = 14;
const IMPLEMENTATION_HEAD =
  'b173d9c4a8d83f39057d6f1d90316b85bd276fcf';
const IMPLEMENTATION_MERGE =
  'cf5b4b0cb505ad05443188a5a4771f87e42dcb3d';
const IMPLEMENTATION_HEAD_REF = 'codex/wallpaper-plugin-wp05';

const FailureReason = Object.freeze({
  WP05_VERIFY_DONE_UNAVAILABLE: 'WP05_VERIFY_DONE_UNAVAILABLE',
  /** Mis-tags that must never apply to WP-05. */
  WP04_VERIFY_DONE_UNAVAILABLE: 'WP04_VERIFY_DONE_UNAVAILABLE',
  WP03_VERIFY_DONE_UNAVAILABLE: 'WP03_VERIFY_DONE_UNAVAILABLE',
  WP02_VERIFY_DONE_UNAVAILABLE: 'WP02_VERIFY_DONE_UNAVAILABLE',
  WP05_VERIFY_DONE_PROOF_MISSING: 'WP05_VERIFY_DONE_PROOF_MISSING',
  WP05_VERIFY_DONE_CALLER_FORGERY: 'WP05_VERIFY_DONE_CALLER_FORGERY',
  WP05_PREREQUISITE_NOT_DONE: 'WP05_PREREQUISITE_NOT_DONE',
  WP05_CATALOG_ENTRY_MISSING: 'WP05_CATALOG_ENTRY_MISSING',
  WP05_CATALOG_PROOF_INVALID: 'WP05_CATALOG_PROOF_INVALID',
  WP05_SUITE_RECEIPT_INVALID: 'WP05_SUITE_RECEIPT_INVALID',
  WP05_PR_PROOF_INVALID: 'WP05_PR_PROOF_INVALID',
  PR_READBACK_REQUIRED: 'PR_READBACK_REQUIRED',
  BASE_CONTAINMENT_REQUIRED: 'BASE_CONTAINMENT_REQUIRED',
  ONLY_VERIFY_DONE_MAY_ENABLE_EFFECTIVE_DONE: 'ONLY_VERIFY_DONE_MAY_ENABLE_EFFECTIVE_DONE',
});

const UNAVAILABLE_RE = /WP05_VERIFY_DONE_UNAVAILABLE/;
const MISTAG_RE =
  /WP04_VERIFY_DONE_UNAVAILABLE|WP03_VERIFY_DONE_UNAVAILABLE|WP02_VERIFY_DONE_UNAVAILABLE/;

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
  const r = git(['ls-remote', '--refs', 'origin', AUTHORITATIVE_BASE_REF], cwd);
  if (r.status !== 0) {
    throw new Error(`ls-remote failed: ${r.stderr || r.stdout}`);
  }
  const sha = (r.stdout.split(/\s+/)[0] || '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`invalid ls-remote base: ${r.stdout}`);
  }
  return sha;
}

function isAncestor(ancestor, descendant, cwd = repoRoot) {
  const r = git(['merge-base', '--is-ancestor', ancestor, descendant], cwd);
  return r.status === 0;
}

const TASK_BRANCH_RE = /^codex\/wallpaper-plugin-/;

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
      failureReason: 'CALLER_FORGED_IDENTITY',
      message: 'caller cannot inject base/HEAD/REMOTE_VERIFIED/merged',
    };
  }
  const branchResult = git(['branch', '--show-current']);
  if (branchResult.status !== 0) {
    return { ok: false, failureReason: 'BRANCH_READ_FAILED' };
  }
  const branch = branchResult.stdout;
  if (!TASK_BRANCH_RE.test(branch)) {
    return { ok: false, failureReason: 'TASK_BRANCH_REJECTED', branch };
  }
  const headResult = git(['rev-parse', 'HEAD']);
  const head = (headResult.stdout || '').toLowerCase();
  const live = liveAuthoritativeBaseSha();
  const equal = head === live;
  const liveIsAncestorOfHead = equal || isAncestor(live, head);
  return {
    ok: liveIsAncestorOfHead,
    branch,
    head,
    liveBaseSha: live,
    relation: equal ? 'equal' : liveIsAncestorOfHead ? 'ahead' : 'diverged',
  };
}

function loadWp05CatalogTask(catalogFile = catalogPath) {
  if (!pathExists(catalogFile)) {
    return { ok: false, failureReason: FailureReason.WP05_CATALOG_ENTRY_MISSING };
  }
  const catalog = readJson(catalogFile);
  const matches = (catalog.tasks || []).filter((t) => t && t.taskId === TASK_ID);
  if (matches.length !== 1) {
    return {
      ok: false,
      failureReason: FailureReason.WP05_CATALOG_ENTRY_MISSING,
      found: matches.length,
    };
  }
  return { ok: true, task: matches[0], catalog };
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
      EffectiveDone: infra.EffectiveDone,
      EffectiveGate: infra.EffectiveGate,
      state: infra.state,
    },
    'WP-00': { EffectiveDone: wp00.EffectiveDone },
    'WP-01': { EffectiveDone: wp01.EffectiveDone, state: wp01.state },
    'WP-02': { EffectiveDone: wp02.EffectiveDone, state: wp02.state },
    'WP-03': { EffectiveDone: wp03.EffectiveDone, state: wp03.state },
    'WP-04': { EffectiveDone: wp04.EffectiveDone, state: wp04.state },
  };
}

function assertWp05ProductionSurfacesPresent() {
  const missing = [];
  for (const p of [
    contractPath,
    patcherPath,
    smaliBridgePath,
    smaliStagerPath,
    pathsXmlPath,
    fileProviderTestPath,
    bridgeUnitTestPath,
  ]) {
    if (!pathExists(p)) missing.push(p);
  }
  return {
    ok: missing.length === 0,
    missing,
    failureReason: missing.length ? 'WP05_PRODUCTION_SURFACE_MISSING' : null,
  };
}

function tempReceipt(taskId = TASK_ID) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp05-vdone-'));
  return path.join(dir, `${taskId.toLowerCase()}.json`);
}

function initTempReceipt(taskId = TASK_ID) {
  const receipt = tempReceipt(taskId);
  const r = runRunner(['receipt-init', '--task', taskId, '--receipt', receipt]);
  return { receipt, init: r };
}

/**
 * Dynamic PR #14 identity from gh API (not caller merged/REMOTE_VERIFIED).
 */
function discoverImplementationIdentity(options = {}) {
  const prNumber = options.prNumber != null ? options.prNumber : IMPLEMENTATION_PR;
  const view = spawnSync(
    'gh',
    [
      'pr',
      'view',
      String(prNumber),
      '--repo',
      APPROVED_REPO,
      '--json',
      'number,state,mergedAt,mergeCommit,baseRefName,headRefName,headRefOid,url,headRepository',
    ],
    { encoding: 'utf8' },
  );
  if ((view.status === null ? 1 : view.status) !== 0) {
    return {
      ok: false,
      failureReason: FailureReason.PR_READBACK_REQUIRED,
      message: view.stderr || view.stdout,
    };
  }
  const pr = JSON.parse(view.stdout || '{}');
  const mergeSha =
    pr.mergeCommit && typeof pr.mergeCommit === 'object'
      ? pr.mergeCommit.oid
      : pr.mergeCommit || null;
  const liveBaseSha = liveAuthoritativeBaseSha();
  const headRepo =
    pr.headRepository && typeof pr.headRepository === 'object'
      ? pr.headRepository.nameWithOwner
      : null;
  return {
    ok: true,
    prNumber: pr.number,
    state: pr.state,
    merged: pr.state === 'MERGED',
    mergedAt: pr.mergedAt,
    mergeSha,
    headRefOid: pr.headRefOid,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    headRepo,
    url: pr.url,
    liveBaseSha,
    mergeIsAncestorOfLiveBase:
      mergeSha && /^[0-9a-f]{40}$/i.test(mergeSha)
        ? isAncestor(mergeSha, liveBaseSha)
        : false,
    headIsAncestorOfLiveBase:
      pr.headRefOid && /^[0-9a-f]{40}$/i.test(pr.headRefOid)
        ? isAncestor(pr.headRefOid, liveBaseSha)
        : false,
    mergeEqualsLiveTip:
      mergeSha && liveBaseSha
        ? String(mergeSha).toLowerCase() === liveBaseSha
        : false,
  };
}

/**
 * Suite digests GREEN must require (identity + local receipt digests).
 * Structural placeholders until CLOSE-VERIFY supplies live log SHAs.
 */
function suiteProofs(options = {}) {
  return {
    androidUnitTest: options.androidUnitTest || {
      pass: true,
      sha256: 'a'.repeat(64),
      tests: 70,
    },
    bridgeUnitTest: options.bridgeUnitTest || {
      pass: true,
      sha256: 'b'.repeat(64),
      tests: 15,
    },
    wp05FileProviderTest: options.wp05FileProviderTest || {
      pass: true,
      sha256: 'c'.repeat(64),
    },
    monorepoImportTest: options.monorepoImportTest || {
      pass: true,
      sha256: 'd'.repeat(64),
      tests: 18,
    },
    fullNodeTest: options.fullNodeTest || { pass: true, sha256: 'e'.repeat(64) },
    catalogSha256: options.catalogSha256 || sha256File(catalogPath),
    schemaSha256: options.schemaSha256 || sha256File(schemaPath),
  };
}

/** Identity-only: prNumber locates PR; remote facts from API/git. */
function identityProofs(prNumber = IMPLEMENTATION_PR, extra = {}) {
  return {
    proofChain: {
      implementation: { prNumber },
    },
    ...suiteProofs(extra),
    ...extra,
  };
}

function runVerifyDone(receiptPath, proofs, extraArgs = []) {
  const args = [
    'verify-done',
    '--task',
    TASK_ID,
    '--receipt',
    receiptPath,
    ...extraArgs,
  ];
  if (proofs != null) {
    args.push('--proofs-json', JSON.stringify(proofs));
  }
  return runRunner(args);
}

function computeCoreProgress(doneMap) {
  return runRunner([
    'compute-core-progress',
    '--done-receipts-json',
    JSON.stringify(doneMap),
  ]);
}

/** Baseline through WP-04 only (36%). */
function defaultDoneReceiptsThroughWp04() {
  return {
    'WP-00': wp00MergeReceipt,
    'WP-01': wp01TxnReceipt,
    'WP-02': wp02TxnReceipt,
    'WP-03': wp03TxnReceipt,
    'WP-04': wp04TxnReceipt,
  };
}

/** Include live WP-05 receipt (elevates only when EffectiveDone truly true). */
function defaultDoneReceipts() {
  return {
    ...defaultDoneReceiptsThroughWp04(),
    'WP-05': wp05TxnReceipt,
  };
}

/**
 * Live operational WP-05 progress from transaction receipt.
 * Through WP-04 = 36%; +WP-05(8)=44 when EffectiveDone.
 */
function liveWp05OperationalProgress() {
  if (!pathExists(wp05TxnReceipt)) {
    return {
      exists: false,
      receipt: null,
      EffectiveDone: false,
      expectedCoreProgressPercent: EXPECTED_PROGRESS_PRE_DONE,
    };
  }
  const receipt = readJson(wp05TxnReceipt);
  const done = receipt && receipt.EffectiveDone === true && receipt.state === 'DONE';
  return {
    exists: true,
    receipt,
    EffectiveDone: done,
    expectedCoreProgressPercent: done
      ? EXPECTED_PROGRESS_WHEN_DONE
      : EXPECTED_PROGRESS_PRE_DONE,
  };
}

/**
 * True only when production has explicit WP-05 evaluate path + WP05_* namespace.
 * WP04_ or WP03_ unavailable tags alone are NOT sufficient (mis-tag if returned for WP-05).
 */
function productionHasWp05VerifyDonePath() {
  const src = fs.readFileSync(runnerPath, 'utf8');
  const hasEval = /evaluate_wp05_verify_done/.test(src);
  const hasDispatch =
    /elif task_id == ["']WP-05["']/.test(src) ||
    /task_id == ["']WP-05["']/.test(src);
  const hasNamespace =
    /WP05_VERIFY_DONE_UNAVAILABLE/.test(src) &&
    /WP05_VERIFY_DONE_PROOF_MISSING/.test(src) &&
    /WP05_VERIFY_DONE_CALLER_FORGERY/.test(src);
  return hasEval && hasDispatch && hasNamespace;
}

function lastFailureReason(result) {
  const body = parseRunnerJson(result);
  return (body && body.failureReason) || '';
}

module.exports = {
  repoRoot,
  runnerPath,
  catalogPath,
  schemaPath,
  contractPath,
  patcherPath,
  smaliBridgePath,
  smaliStagerPath,
  pathsXmlPath,
  fileProviderTestPath,
  bridgeUnitTestPath,
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
  AUTHORITATIVE_BASE_REF,
  AUTHORITATIVE_BASE_BRANCH,
  APPROVED_REPO,
  TASK_ID,
  EXPECTED_WEIGHT,
  EXPECTED_PROGRESS_WHEN_DONE,
  EXPECTED_PROGRESS_PRE_DONE,
  IMPLEMENTATION_PR,
  IMPLEMENTATION_HEAD,
  IMPLEMENTATION_MERGE,
  IMPLEMENTATION_HEAD_REF,
  FailureReason,
  UNAVAILABLE_RE,
  MISTAG_RE,
  git,
  runRunner,
  parseRunnerJson,
  readJson,
  pathExists,
  sha256File,
  liveAuthoritativeBaseSha,
  isAncestor,
  readTaskWorktreeIdentity,
  loadWp05CatalogTask,
  readPrerequisiteDone,
  assertWp05ProductionSurfacesPresent,
  tempReceipt,
  initTempReceipt,
  discoverImplementationIdentity,
  suiteProofs,
  identityProofs,
  runVerifyDone,
  computeCoreProgress,
  defaultDoneReceiptsThroughWp04,
  defaultDoneReceipts,
  liveWp05OperationalProgress,
  productionHasWp05VerifyDonePath,
  lastFailureReason,
};
