'use strict';

/**
 * Helpers for WP-06 verify-done / CLOSE-VERIFY RED-01 contracts.
 *
 * RED-01: production evaluate_wp06_verify_done is absent — GREEN implements it.
 * Unavailable signature must be WP06_VERIFY_DONE_UNAVAILABLE (never WP05_/WP04_/WP03_).
 *
 * Implementation proof (authoritative):
 *   PR #16 · head 3996ec27… · merge/live tip 0461f423…
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
const installerTestPath = path.join(
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

const AUTHORITATIVE_BASE_REF = 'refs/heads/huawei-android12-car';
const APPROVED_REPO = 'anpplex/Mineradio-AndroidAuto';
const TASK_ID = 'WP-06';
const EXPECTED_WEIGHT = 6;
/** WP-00…WP-05 = 44; +WP-06(6)=50 when EffectiveDone. */
const EXPECTED_PROGRESS_WHEN_DONE = 50;
const EXPECTED_PROGRESS_PRE_DONE = 44;
const IMPLEMENTATION_PR = 16;
const IMPLEMENTATION_HEAD = '3996ec276c3ae30217504e1ee57343f50ee5b147';
const IMPLEMENTATION_MERGE = '0461f423f298bd00d9b6b340198d71abf48ee198';
const IMPLEMENTATION_HEAD_REF = 'codex/wallpaper-plugin-wp06';

const FailureReason = Object.freeze({
  WP06_VERIFY_DONE_UNAVAILABLE: 'WP06_VERIFY_DONE_UNAVAILABLE',
  WP05_VERIFY_DONE_UNAVAILABLE: 'WP05_VERIFY_DONE_UNAVAILABLE',
  WP04_VERIFY_DONE_UNAVAILABLE: 'WP04_VERIFY_DONE_UNAVAILABLE',
  WP03_VERIFY_DONE_UNAVAILABLE: 'WP03_VERIFY_DONE_UNAVAILABLE',
  WP06_VERIFY_DONE_PROOF_MISSING: 'WP06_VERIFY_DONE_PROOF_MISSING',
  WP06_VERIFY_DONE_CALLER_FORGERY: 'WP06_VERIFY_DONE_CALLER_FORGERY',
  WP06_PREREQUISITE_NOT_DONE: 'WP06_PREREQUISITE_NOT_DONE',
  WP06_CATALOG_ENTRY_MISSING: 'WP06_CATALOG_ENTRY_MISSING',
  WP06_CATALOG_PROOF_INVALID: 'WP06_CATALOG_PROOF_INVALID',
  WP06_SUITE_RECEIPT_INVALID: 'WP06_SUITE_RECEIPT_INVALID',
  WP06_PR_PROOF_INVALID: 'WP06_PR_PROOF_INVALID',
  ONLY_VERIFY_DONE_MAY_ENABLE_EFFECTIVE_DONE: 'ONLY_VERIFY_DONE_MAY_ENABLE_EFFECTIVE_DONE',
});

const MISTAG_RE =
  /WP05_VERIFY_DONE_UNAVAILABLE|WP04_VERIFY_DONE_UNAVAILABLE|WP03_VERIFY_DONE_UNAVAILABLE/;

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
  if (r.status !== 0) throw new Error(`ls-remote failed: ${r.stderr || r.stdout}`);
  const sha = (r.stdout.split(/\s+/)[0] || '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`invalid ls-remote base: ${r.stdout}`);
  return sha;
}

function isAncestor(ancestor, descendant, cwd = repoRoot) {
  return git(['merge-base', '--is-ancestor', ancestor, descendant], cwd).status === 0;
}

function readTaskWorktreeIdentity() {
  const branch = git(['branch', '--show-current']).stdout;
  const head = git(['rev-parse', 'HEAD']).stdout.toLowerCase();
  const live = liveAuthoritativeBaseSha();
  const equal = head === live;
  const liveIsAncestorOfHead = equal || isAncestor(live, head);
  return {
    ok: /^codex\/wallpaper-plugin-/.test(branch) && liveIsAncestorOfHead,
    branch,
    head,
    liveBaseSha: live,
    relation: equal ? 'equal' : liveIsAncestorOfHead ? 'ahead' : 'diverged',
  };
}

function loadWp06CatalogTask() {
  if (!pathExists(catalogPath)) {
    return { ok: false, failureReason: FailureReason.WP06_CATALOG_ENTRY_MISSING };
  }
  const catalog = readJson(catalogPath);
  const matches = (catalog.tasks || []).filter((t) => t && t.taskId === TASK_ID);
  if (matches.length !== 1) {
    return {
      ok: false,
      failureReason: FailureReason.WP06_CATALOG_ENTRY_MISSING,
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
  const wp05 = readJson(wp05TxnReceipt);
  const ok =
    infra.EffectiveGate === true &&
    infra.EffectiveDone === true &&
    wp00.EffectiveDone === true &&
    wp01.EffectiveDone === true &&
    wp01.state === 'DONE' &&
    wp02.EffectiveDone === true &&
    wp02.state === 'DONE' &&
    wp03.EffectiveDone === true &&
    wp03.state === 'DONE' &&
    wp04.EffectiveDone === true &&
    wp04.state === 'DONE' &&
    wp05.EffectiveDone === true &&
    wp05.state === 'DONE';
  return {
    ok,
    failureReason: ok ? null : FailureReason.WP06_PREREQUISITE_NOT_DONE,
    WP_INFRA: {
      EffectiveDone: infra.EffectiveDone,
      EffectiveGate: infra.EffectiveGate,
    },
    'WP-00': { EffectiveDone: wp00.EffectiveDone },
    'WP-01': { EffectiveDone: wp01.EffectiveDone, state: wp01.state },
    'WP-02': { EffectiveDone: wp02.EffectiveDone, state: wp02.state },
    'WP-03': { EffectiveDone: wp03.EffectiveDone, state: wp03.state },
    'WP-04': { EffectiveDone: wp04.EffectiveDone, state: wp04.state },
    'WP-05': { EffectiveDone: wp05.EffectiveDone, state: wp05.state },
  };
}

function assertWp06ProductionSurfacesPresent() {
  const missing = [];
  for (const p of [
    contractPath,
    installerSmaliPath,
    smaliBridgePath,
    installerTestPath,
  ]) {
    if (!pathExists(p)) missing.push(p);
  }
  if (pathExists(installerSmaliPath)) {
    const text = fs.readFileSync(installerSmaliPath, 'utf8');
    for (const m of ['CarWallpaperPluginInstaller', 'PackageInstaller', 'content://']) {
      if (!text.includes(m)) missing.push(`installer:${m}`);
    }
  }
  if (pathExists(smaliBridgePath)) {
    const text = fs.readFileSync(smaliBridgePath, 'utf8');
    for (const m of ['isInstalled', 'getPluginVersion', 'installPlugin', 'CarWallpaperPluginInstaller']) {
      if (!text.includes(m)) missing.push(`bridge:${m}`);
    }
  }
  return {
    ok: missing.length === 0,
    missing,
    failureReason: missing.length ? 'WP06_PRODUCTION_SURFACE_MISSING' : null,
  };
}

function initTempReceipt(taskId = TASK_ID) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp06-vdone-'));
  const receipt = path.join(dir, `${taskId.toLowerCase()}.json`);
  const init = runRunner(['receipt-init', '--task', taskId, '--receipt', receipt]);
  return { receipt, init };
}

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
      failureReason: 'PR_READBACK_REQUIRED',
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
    wp06InstallerTest: options.wp06InstallerTest || {
      pass: true,
      sha256: 'c'.repeat(64),
      tests: 31,
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
  const args = ['verify-done', '--task', TASK_ID, '--receipt', receiptPath, ...extraArgs];
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

function defaultDoneReceipts() {
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
      expectedCoreProgressPercent: EXPECTED_PROGRESS_PRE_DONE,
    };
  }
  const receipt = readJson(wp06TxnReceipt);
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

function productionHasWp06VerifyDonePath() {
  const src = fs.readFileSync(runnerPath, 'utf8');
  const hasEval = /evaluate_wp06_verify_done/.test(src);
  const hasDispatch =
    /elif task_id == ["']WP-06["']/.test(src) || /task_id == ["']WP-06["']/.test(src);
  const hasNamespace =
    /WP06_VERIFY_DONE_UNAVAILABLE/.test(src) &&
    /WP06_VERIFY_DONE_PROOF_MISSING/.test(src) &&
    /WP06_VERIFY_DONE_CALLER_FORGERY/.test(src);
  return hasEval && hasDispatch && hasNamespace;
}

module.exports = {
  repoRoot,
  runnerPath,
  catalogPath,
  schemaPath,
  contractPath,
  installerSmaliPath,
  smaliBridgePath,
  installerTestPath,
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
  EXPECTED_WEIGHT,
  EXPECTED_PROGRESS_WHEN_DONE,
  EXPECTED_PROGRESS_PRE_DONE,
  IMPLEMENTATION_PR,
  IMPLEMENTATION_HEAD,
  IMPLEMENTATION_MERGE,
  IMPLEMENTATION_HEAD_REF,
  FailureReason,
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
  loadWp06CatalogTask,
  readPrerequisiteDone,
  assertWp06ProductionSurfacesPresent,
  initTempReceipt,
  discoverImplementationIdentity,
  suiteProofs,
  identityProofs,
  runVerifyDone,
  computeCoreProgress,
  defaultDoneReceiptsThroughWp05,
  defaultDoneReceipts,
  liveWp06OperationalProgress,
  productionHasWp06VerifyDonePath,
};
