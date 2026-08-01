'use strict';

/**
 * Helpers for WP-02 verify-done / CLOSE-VERIFY RED-01 contracts.
 *
 * Dynamic facts only: origin ls-remote, gh PR API, catalog/receipts on disk.
 * Caller-forged EffectiveDone / progress / merged / REMOTE_VERIFIED are never truth.
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
const runtimeContractPath = path.join(
  repoRoot,
  'android-car',
  'scripts',
  'wp02-runtime-contract.js',
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

const AUTHORITATIVE_BASE_REF = 'refs/heads/huawei-android12-car';
const AUTHORITATIVE_BASE_BRANCH = 'huawei-android12-car';
const APPROVED_REPO = 'anpplex/Mineradio-AndroidAuto';
const TASK_ID = 'WP-02';
const EXPECTED_WEIGHT = 8;
const EXPECTED_PROGRESS_WHEN_DONE = 18; // 4+6+8 from catalog weights + receipts

/** Failure signatures the RED contract pins (GREEN must implement / preserve). */
const FailureReason = Object.freeze({
  WP02_VERIFY_DONE_UNAVAILABLE: 'WP02_VERIFY_DONE_UNAVAILABLE',
  /** Current production emits this until WP-02 path exists — accepted equivalent. */
  WP01_VERIFY_DONE_UNAVAILABLE: 'WP01_VERIFY_DONE_UNAVAILABLE',
  WP02_VERIFY_DONE_PROOF_MISSING: 'WP02_VERIFY_DONE_PROOF_MISSING',
  WP02_VERIFY_DONE_CALLER_FORGERY: 'WP02_VERIFY_DONE_CALLER_FORGERY',
  WP02_PREREQUISITE_NOT_DONE: 'WP02_PREREQUISITE_NOT_DONE',
  WP02_CATALOG_ENTRY_MISSING: 'WP02_CATALOG_ENTRY_MISSING',
  PR_READBACK_REQUIRED: 'PR_READBACK_REQUIRED',
  BASE_CONTAINMENT_REQUIRED: 'BASE_CONTAINMENT_REQUIRED',
  ONLY_VERIFY_DONE_MAY_ENABLE_EFFECTIVE_DONE: 'ONLY_VERIFY_DONE_MAY_ENABLE_EFFECTIVE_DONE',
});

/** Match production unavailable for WP-02 (current or future explicit reason). */
const UNAVAILABLE_RE =
  /WP02_VERIFY_DONE_UNAVAILABLE|WP01_VERIFY_DONE_UNAVAILABLE|verify-done production path currently implemented for WP-01 only/i;

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

/** Independent live base tip — never caller-forged. */
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

function loadWp02CatalogTask(catalogFile = catalogPath) {
  if (!pathExists(catalogFile)) {
    return { ok: false, failureReason: FailureReason.WP02_CATALOG_ENTRY_MISSING };
  }
  const catalog = readJson(catalogFile);
  const matches = (catalog.tasks || []).filter((t) => t && t.taskId === TASK_ID);
  if (matches.length !== 1) {
    return {
      ok: false,
      failureReason: FailureReason.WP02_CATALOG_ENTRY_MISSING,
      found: matches.length,
    };
  }
  return { ok: true, task: matches[0], catalog };
}

function readPrerequisiteDone() {
  const infra = readJson(finalInfraReceipt);
  const wp00 = readJson(wp00MergeReceipt);
  const wp01 = readJson(wp01TxnReceipt);
  const ok =
    infra.EffectiveGate === true &&
    infra.EffectiveDone === true &&
    infra.state === 'DONE' &&
    wp00.EffectiveDone === true &&
    wp01.EffectiveDone === true &&
    wp01.state === 'DONE' &&
    wp01.taskId === 'WP-01';
  return {
    ok,
    failureReason: ok ? null : FailureReason.WP02_PREREQUISITE_NOT_DONE,
    WP_INFRA: {
      EffectiveDone: infra.EffectiveDone,
      EffectiveGate: infra.EffectiveGate,
      state: infra.state,
    },
    'WP-00': { EffectiveDone: wp00.EffectiveDone },
    'WP-01': { EffectiveDone: wp01.EffectiveDone, state: wp01.state },
  };
}

function tempReceipt(taskId = TASK_ID) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp02-vdone-'));
  return path.join(dir, `${taskId.toLowerCase()}.json`);
}

function initTempReceipt(taskId = TASK_ID) {
  const receipt = tempReceipt(taskId);
  const r = runRunner(['receipt-init', '--task', taskId, '--receipt', receipt]);
  return { receipt, init: r };
}

/**
 * Dynamic implementation identity from live PR API (not production-hardcoded).
 * Uses gh pr list/view against merged branch head when available.
 */
function discoverImplementationIdentity(options = {}) {
  const headSha =
    options.headSha ||
    (() => {
      // Prefer explicit identity from environment facts: commit message on base.
      const live = liveAuthoritativeBaseSha();
      const log = git([
        'log',
        '-1',
        '--merges',
        '--grep=Merge pull request #8',
        '--format=%H',
        live,
      ]);
      return live;
    })();

  // PR number is caller identity only when provided; remote facts from gh.
  const prNumber = options.prNumber;
  if (prNumber == null) {
    return {
      ok: true,
      liveBaseSha: liveAuthoritativeBaseSha(),
      headSha,
      prNumber: null,
      note: 'prNumber optional for identity-only probes',
    };
  }

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
  };
}

/**
 * Suite digests: GREEN will require real receipt SHAs.
 * RED uses live catalog/schema digests + placeholder suite digests for structure.
 */
function suiteProofs(options = {}) {
  return {
    pluginContractTest: options.pluginContractTest || {
      pass: true,
      sha256: 'c'.repeat(64),
    },
    monorepoImportTest: options.monorepoImportTest || {
      pass: true,
      sha256: 'd'.repeat(64),
    },
    fullNodeTest: options.fullNodeTest || { pass: true, sha256: 'e'.repeat(64) },
    wp02ContractTest: options.wp02ContractTest || {
      pass: true,
      sha256: 'f'.repeat(64),
    },
    catalogSha256: sha256File(catalogPath),
    schemaSha256: sha256File(schemaPath),
  };
}

/**
 * Identity-only proofs for WP-02 implementation PR (caller may supply prNumber).
 * Remote facts must come from API/git — not from caller merged/REMOTE_VERIFIED.
 */
function identityProofs(prNumber, extra = {}) {
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
  };
}

function productionHasWp02VerifyDonePath() {
  const src = fs.readFileSync(runnerPath, 'utf8');
  return (
    /evaluate_wp02_verify_done/.test(src) ||
    /WP02_VERIFY_DONE_UNAVAILABLE/.test(src) ||
    /task_id\s*==\s*["']WP-02["']/.test(src) && /evaluate_wp02/.test(src)
  );
}

module.exports = {
  repoRoot,
  runnerPath,
  catalogPath,
  schemaPath,
  runtimeContractPath,
  verificationRoot,
  bootstrapRoot,
  transactionsRoot,
  finalInfraReceipt,
  wp00MergeReceipt,
  wp01TxnReceipt,
  wp02TxnReceipt,
  AUTHORITATIVE_BASE_REF,
  AUTHORITATIVE_BASE_BRANCH,
  APPROVED_REPO,
  TASK_ID,
  EXPECTED_WEIGHT,
  EXPECTED_PROGRESS_WHEN_DONE,
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
  loadWp02CatalogTask,
  readPrerequisiteDone,
  tempReceipt,
  initTempReceipt,
  discoverImplementationIdentity,
  suiteProofs,
  identityProofs,
  runVerifyDone,
  computeCoreProgress,
  defaultDoneReceipts,
  productionHasWp02VerifyDonePath,
};
