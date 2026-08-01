'use strict';

/**
 * Helpers for WP-03 verify-done / CLOSE-VERIFY RED-01 contracts.
 *
 * Dynamic facts only: origin ls-remote, gh PR API, catalog/receipts on disk.
 * Caller-forged EffectiveDone / progress / merged / REMOTE_VERIFIED are never truth.
 *
 * RED-01: production evaluate_wp03_verify_done is absent — GREEN implements it.
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
const stagingContractPath = path.join(
  repoRoot,
  'android-car',
  'scripts',
  'wp03-staging-contract.js',
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

const AUTHORITATIVE_BASE_REF = 'refs/heads/huawei-android12-car';
const AUTHORITATIVE_BASE_BRANCH = 'huawei-android12-car';
const APPROVED_REPO = 'anpplex/Mineradio-AndroidAuto';
const TASK_ID = 'WP-03';
const EXPECTED_WEIGHT = 8;
/** WP-00(4)+WP-01(6)+WP-02(8)=18; +WP-03(8)=26 when EffectiveDone. */
const EXPECTED_PROGRESS_WHEN_DONE = 26;
const IMPLEMENTATION_PR = 10;
const IMPLEMENTATION_HEAD =
  '4c3a358b80e3710def01dc3f5b84af6c583d47ea';
const IMPLEMENTATION_MERGE =
  '8d15b07c79fb026eb9ce75d50e698b248546dac5';

const FailureReason = Object.freeze({
  WP03_VERIFY_DONE_UNAVAILABLE: 'WP03_VERIFY_DONE_UNAVAILABLE',
  /** Legacy mis-tag until GREEN renames production unavailable reason. */
  WP02_VERIFY_DONE_UNAVAILABLE: 'WP02_VERIFY_DONE_UNAVAILABLE',
  WP03_VERIFY_DONE_PROOF_MISSING: 'WP03_VERIFY_DONE_PROOF_MISSING',
  WP03_VERIFY_DONE_CALLER_FORGERY: 'WP03_VERIFY_DONE_CALLER_FORGERY',
  WP03_PREREQUISITE_NOT_DONE: 'WP03_PREREQUISITE_NOT_DONE',
  WP03_CATALOG_ENTRY_MISSING: 'WP03_CATALOG_ENTRY_MISSING',
  PR_READBACK_REQUIRED: 'PR_READBACK_REQUIRED',
  BASE_CONTAINMENT_REQUIRED: 'BASE_CONTAINMENT_REQUIRED',
  ONLY_VERIFY_DONE_MAY_ENABLE_EFFECTIVE_DONE: 'ONLY_VERIFY_DONE_MAY_ENABLE_EFFECTIVE_DONE',
});

/** GREEN must emit WP03_VERIFY_DONE_UNAVAILABLE when path missing (not WP02_...). */
const UNAVAILABLE_RE = /WP03_VERIFY_DONE_UNAVAILABLE/;

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

function loadWp03CatalogTask(catalogFile = catalogPath) {
  if (!pathExists(catalogFile)) {
    return { ok: false, failureReason: FailureReason.WP03_CATALOG_ENTRY_MISSING };
  }
  const catalog = readJson(catalogFile);
  const matches = (catalog.tasks || []).filter((t) => t && t.taskId === TASK_ID);
  if (matches.length !== 1) {
    return {
      ok: false,
      failureReason: FailureReason.WP03_CATALOG_ENTRY_MISSING,
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
  const ok =
    infra.EffectiveGate === true &&
    infra.EffectiveDone === true &&
    infra.state === 'DONE' &&
    wp00.EffectiveDone === true &&
    wp01.EffectiveDone === true &&
    wp01.state === 'DONE' &&
    wp02.EffectiveDone === true &&
    wp02.state === 'DONE' &&
    wp02.taskId === 'WP-02';
  return {
    ok,
    failureReason: ok ? null : FailureReason.WP03_PREREQUISITE_NOT_DONE,
    WP_INFRA: {
      EffectiveDone: infra.EffectiveDone,
      EffectiveGate: infra.EffectiveGate,
      state: infra.state,
    },
    'WP-00': { EffectiveDone: wp00.EffectiveDone },
    'WP-01': { EffectiveDone: wp01.EffectiveDone, state: wp01.state },
    'WP-02': { EffectiveDone: wp02.EffectiveDone, state: wp02.state },
  };
}

function tempReceipt(taskId = TASK_ID) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp03-vdone-'));
  return path.join(dir, `${taskId.toLowerCase()}.json`);
}

function initTempReceipt(taskId = TASK_ID) {
  const receipt = tempReceipt(taskId);
  const r = runRunner(['receipt-init', '--task', taskId, '--receipt', receipt]);
  return { receipt, init: r };
}

/**
 * Dynamic PR #10 identity from gh API (not caller merged/REMOTE_VERIFIED).
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
      'number,state,mergedAt,mergeCommit,baseRefName,headRefName,headRefOid,url',
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
    // Contract: merge may equal tip after merge, but must not be *required* by gate.
    mergeEqualsLiveTip:
      mergeSha && liveBaseSha
        ? String(mergeSha).toLowerCase() === liveBaseSha
        : false,
  };
}

/**
 * Suite digests for GREEN success path structure.
 * RED uses real catalog/schema digests; suite digests are structural placeholders
 * until CLOSE-VERIFY supplies live receipts.
 */
function suiteProofs(options = {}) {
  return {
    androidUnitTest: options.androidUnitTest || {
      pass: true,
      sha256: 'a'.repeat(64),
      tests: 70,
    },
    wp03ContractTest: options.wp03ContractTest || {
      pass: true,
      sha256: 'b'.repeat(64),
    },
    fullNodeTest: options.fullNodeTest || { pass: true, sha256: 'c'.repeat(64) },
    stagingContractTest: options.stagingContractTest || {
      pass: true,
      sha256: 'd'.repeat(64),
    },
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

function defaultDoneReceipts() {
  return {
    'WP-00': wp00MergeReceipt,
    'WP-01': wp01TxnReceipt,
    'WP-02': wp02TxnReceipt,
    'WP-03': wp03TxnReceipt,
  };
}

/**
 * True only when production has an explicit WP-03 evaluate path.
 * Presence of WP02_VERIFY_DONE_UNAVAILABLE mis-tag alone is NOT sufficient.
 */
function productionHasWp03VerifyDonePath() {
  const src = fs.readFileSync(runnerPath, 'utf8');
  return (
    /evaluate_wp03_verify_done/.test(src) &&
    (/task_id\s*==\s*["']WP-03["']/.test(src) ||
      /taskId\s*==\s*["']WP-03["']/.test(src) ||
      /["']WP-03["']\s*:/.test(src))
  );
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
  stagingContractPath,
  verificationRoot,
  bootstrapRoot,
  transactionsRoot,
  finalInfraReceipt,
  wp00MergeReceipt,
  wp01TxnReceipt,
  wp02TxnReceipt,
  wp03TxnReceipt,
  AUTHORITATIVE_BASE_REF,
  AUTHORITATIVE_BASE_BRANCH,
  APPROVED_REPO,
  TASK_ID,
  EXPECTED_WEIGHT,
  EXPECTED_PROGRESS_WHEN_DONE,
  IMPLEMENTATION_PR,
  IMPLEMENTATION_HEAD,
  IMPLEMENTATION_MERGE,
  FailureReason,
  UNAVAILABLE_RE,
  git,
  runRunner,
  parseRunnerJson,
  readJson,
  pathExists,
  sha256File,
  liveAuthoritativeBaseSha,
  isAncestor,
  readTaskWorktreeIdentity,
  loadWp03CatalogTask,
  readPrerequisiteDone,
  tempReceipt,
  initTempReceipt,
  discoverImplementationIdentity,
  suiteProofs,
  identityProofs,
  runVerifyDone,
  computeCoreProgress,
  defaultDoneReceipts,
  productionHasWp03VerifyDonePath,
  lastFailureReason,
};
