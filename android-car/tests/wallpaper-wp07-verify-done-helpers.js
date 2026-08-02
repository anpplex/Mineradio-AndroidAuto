'use strict';

/**
 * Helpers for WP-07 verify-done / CLOSE-VERIFY contracts.
 *
 * Implementation proof (authoritative):
 *   PR #18 · head 35508b88… · merge/live tip 5e7bbfa9…
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
const EXPECTED_WEIGHT = 6;
/** WP-00…WP-06 = 50; +WP-07(6)=56 when EffectiveDone. */
const EXPECTED_PROGRESS_WHEN_DONE = 56;
const EXPECTED_PROGRESS_PRE_DONE = 50;
const IMPLEMENTATION_PR = 18;
const IMPLEMENTATION_HEAD = '35508b88ee187dbca2c6424faf9ea84e877e077b';
const IMPLEMENTATION_MERGE = '5e7bbfa9db0fc4ff502ee48a0bc446af34e3f7e6';
const IMPLEMENTATION_HEAD_REF = 'codex/wallpaper-plugin-wp07';

const FailureReason = Object.freeze({
  WP07_VERIFY_DONE_UNAVAILABLE: 'WP07_VERIFY_DONE_UNAVAILABLE',
  WP06_VERIFY_DONE_UNAVAILABLE: 'WP06_VERIFY_DONE_UNAVAILABLE',
  WP05_VERIFY_DONE_UNAVAILABLE: 'WP05_VERIFY_DONE_UNAVAILABLE',
  WP07_VERIFY_DONE_PROOF_MISSING: 'WP07_VERIFY_DONE_PROOF_MISSING',
  WP07_VERIFY_DONE_CALLER_FORGERY: 'WP07_VERIFY_DONE_CALLER_FORGERY',
  WP07_PR_PROOF_INVALID: 'WP07_PR_PROOF_INVALID',
  WP07_SUITE_RECEIPT_INVALID: 'WP07_SUITE_RECEIPT_INVALID',
  WP07_REQUIRED_DONE_MISSING: 'WP07_REQUIRED_DONE_MISSING',
  WP07_CATALOG_ENTRY_MISSING: 'WP07_CATALOG_ENTRY_MISSING',
});

const MISTAG_RE = /WP0[3-6]_VERIFY_DONE_UNAVAILABLE|WP0[3-6]_VERIFY_DONE_PROOF/;

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

function isAncestor(a, d, cwd = repoRoot) {
  return git(['merge-base', '--is-ancestor', a, d], cwd).status === 0;
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

function loadWp07CatalogTask() {
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
    };
  }
  return { ok: true, task: matches[0], catalog };
}

function readPrerequisiteDone() {
  const paths = {
    WP_INFRA: finalInfraReceipt,
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
      return { ok: false, missing: id };
    }
    const data = readJson(p);
    const done = data.EffectiveDone === true;
    out[id] = { EffectiveDone: done, state: data.state, path: p };
    if (id === 'WP_INFRA') {
      out.WP_INFRA.EffectiveGate = data.EffectiveGate === true;
      if (!done || data.EffectiveGate !== true) out.ok = false;
    } else if (!(done && (id === 'WP-00' || data.state === 'DONE'))) {
      if (id === 'WP-00' && done) {
        // merge receipt may not use state DONE
      } else if (!done || (id !== 'WP-00' && data.state !== 'DONE')) {
        out.ok = false;
      }
    }
  }
  return out;
}

function initTempReceipt() {
  const receipt = path.join(
    os.tmpdir(),
    `wp07-vd-${process.pid}-${Date.now()}.json`,
  );
  const init = runRunner(['receipt-init', '--task', TASK_ID, '--receipt', receipt]);
  return { receipt, init };
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
    wp07RuntimeTest: options.wp07RuntimeTest || {
      pass: true,
      sha256: 'c'.repeat(64),
      tests: 45,
    },
    monorepoImportTest: options.monorepoImportTest || {
      pass: true,
      sha256: 'd'.repeat(64),
      tests: 18,
    },
    fullNodeTest: options.fullNodeTest || {
      pass: true,
      sha256: 'e'.repeat(64),
      historicalOnly: true,
    },
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

function defaultDoneReceipts() {
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
      expectedCoreProgressPercent: EXPECTED_PROGRESS_PRE_DONE,
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
      : EXPECTED_PROGRESS_PRE_DONE,
  };
}

function productionHasWp07VerifyDonePath() {
  const src = fs.readFileSync(runnerPath, 'utf8');
  const hasEval = /evaluate_wp07_verify_done/.test(src);
  const hasDispatch = /task_id == ["']WP-07["']/.test(src);
  const hasNamespace =
    /WP07_VERIFY_DONE_UNAVAILABLE/.test(src) &&
    /WP07_VERIFY_DONE_PROOF_MISSING/.test(src) &&
    /WP07_VERIFY_DONE_CALLER_FORGERY/.test(src);
  return hasEval && hasDispatch && hasNamespace;
}

module.exports = {
  repoRoot,
  runnerPath,
  catalogPath,
  schemaPath,
  runtimePath,
  hmiPatcherPath,
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
  loadWp07CatalogTask,
  readPrerequisiteDone,
  initTempReceipt,
  suiteProofs,
  identityProofs,
  runVerifyDone,
  computeCoreProgress,
  defaultDoneReceiptsThroughWp06,
  defaultDoneReceipts,
  liveWp07OperationalProgress,
  productionHasWp07VerifyDonePath,
};
