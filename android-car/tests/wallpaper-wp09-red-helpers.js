'use strict';

/**
 * Helpers for WP-09 / RED-01 — 双仓签名闭环、三包 APK 静态 verifier.
 *
 * RED only: catalog + production capacity gaps. Does not implement verifier
 * or elevate EffectiveDone. Weight 6 E2; progress 64 → 70 when DONE.
 *
 * Spec: Task 9 Files / static checks / cert mismatch fixtures.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const runnerPath = path.join(repoRoot, 'android-car', 'scripts', 'wallpaper-task.py');
const catalogPath = path.join(repoRoot, 'android-car', 'scripts', 'wallpaper-plugin-tasks.json');
const schemaPath = path.join(repoRoot, 'android-car', 'scripts', 'wallpaper-task.schema.json');

const verifyJsPath = path.join(repoRoot, 'android-car', 'scripts', 'verify-wallpaper-plugin.js');
const verifyShPath = path.join(repoRoot, 'android-car', 'scripts', 'verify-wallpaper-plugin.sh');
const verifyTestPath = path.join(repoRoot, 'android-car', 'tests', 'verify-wallpaper-plugin.test.js');
const wp09TxnToolPath = path.join(repoRoot, 'android-car', 'scripts', 'wp09-transaction.py');
const wp09TxnTestPath = path.join(repoRoot, 'android-car', 'tests', 'wp09-transaction.test.js');

const WP09_CREATE_REL = Object.freeze([
  'android-car/scripts/verify-wallpaper-plugin.js',
  'android-car/scripts/verify-wallpaper-plugin.sh',
  'android-car/tests/verify-wallpaper-plugin.test.js',
]);

const WP09_MODIFY_REL = Object.freeze([
  'android-car/scripts/wp09-transaction.py',
  'android-car/tests/wp09-transaction.test.js',
]);

/** Static check contract tokens (Task 9). */
const WP09_STATIC_MARKERS = Object.freeze([
  'com.mineradio.app',
  'com.motif.wallpaperengine',
  'io.wallpaperengine.weclient',
  'we_runtime',
  'apksigner',
  'zipalign',
  'aapt',
  'arm64-v8a',
  'certificate',
  'sha256',
  'split',
  'BrowseActivity',
  'WEWallpaperService',
  'mineradioCallerCertSha256',
]);

const WP09_MISMATCH_FIXTURES = Object.freeze([
  'wrongPackage',
  'missingProvider',
  'missingWeRuntime',
  'certMismatch',
  'splitSignerMismatch',
  'officialMissing',
  'apkPathMissing',
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
const wp09TxnReceipt = path.join(transactionsRoot, 'wp-09.json');

const TASK_ID = 'WP-09';
/** WP-00…WP-08 = 64; +WP-09(6)=70 when DONE. */
const EXPECTED_CURRENT_CORE_PROGRESS = 64;
const EXPECTED_WEIGHT_FROM_PROGRESS_TABLE = 6;
const EXPECTED_PROGRESS_WHEN_DONE = 70;

const FailureReason = Object.freeze({
  WP09_CATALOG_ENTRY_MISSING: 'WP09_CATALOG_ENTRY_MISSING',
  WP09_CATALOG_FIELD_MISSING: 'WP09_CATALOG_FIELD_MISSING',
  WP09_PRODUCTION_SURFACE_MISSING: 'WP09_PRODUCTION_SURFACE_MISSING',
  WP09_VERIFIER_JS_MISSING: 'WP09_VERIFIER_JS_MISSING',
  WP09_VERIFIER_SH_MISSING: 'WP09_VERIFIER_SH_MISSING',
  WP09_UNIT_TEST_MISSING: 'WP09_UNIT_TEST_MISSING',
  WP09_TRANSACTION_TOOL_MISSING: 'WP09_TRANSACTION_TOOL_MISSING',
  WP09_TRANSACTION_TEST_MISSING: 'WP09_TRANSACTION_TEST_MISSING',
  WP09_STATIC_CONTRACT_MISSING: 'WP09_STATIC_CONTRACT_MISSING',
  WP09_MISMATCH_FIXTURES_MISSING: 'WP09_MISMATCH_FIXTURES_MISSING',
  WP09_PREREQUISITE_NOT_DONE: 'WP09_PREREQUISITE_NOT_DONE',
  WP09_RECEIPT_MISSING: 'WP09_RECEIPT_MISSING',
  WP09_EFFECTIVE_DONE_FORGED: 'WP09_EFFECTIVE_DONE_FORGED',
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

function loadWp09CatalogEntry() {
  if (!pathExists(catalogPath)) {
    return { ok: false, failureReason: FailureReason.WP09_CATALOG_ENTRY_MISSING };
  }
  const catalog = readJson(catalogPath);
  const matches = (catalog.tasks || []).filter((t) => t && t.taskId === TASK_ID);
  if (matches.length !== 1) {
    return {
      ok: false,
      failureReason: FailureReason.WP09_CATALOG_ENTRY_MISSING,
      count: matches.length,
    };
  }
  return { ok: true, task: matches[0], catalog };
}

function parseWp09CatalogIdentity(task) {
  const missing = [];
  if (task.weight !== EXPECTED_WEIGHT_FROM_PROGRESS_TABLE) missing.push('weight');
  if (task.evidenceLevel !== 'E2') missing.push('evidenceLevel');
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
    'WP-08',
  ]) {
    if (!req.includes(dep)) missing.push(`requiredEffectiveDone:${dep}`);
  }
  if (missing.length) {
    return {
      ok: false,
      failureReason: FailureReason.WP09_CATALOG_FIELD_MISSING,
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
    'WP-08': wp08TxnReceipt,
  };
  const out = { ok: true };
  for (const [id, p] of Object.entries(paths)) {
    if (!pathExists(p)) {
      return {
        ok: false,
        failureReason: FailureReason.WP09_PREREQUISITE_NOT_DONE,
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
  if (!out.ok) out.failureReason = FailureReason.WP09_PREREQUISITE_NOT_DONE;
  return out;
}

function listMissingCreates() {
  return WP09_CREATE_REL.filter((rel) => !pathExists(path.join(repoRoot, rel)));
}

function assertWp09ProductionSurfacesPresent() {
  const missing = listMissingCreates();
  if (missing.length) {
    return {
      ok: false,
      failureReason: FailureReason.WP09_PRODUCTION_SURFACE_MISSING,
      message: `missing Create surfaces: ${missing.join(', ')}`,
      missing,
      EffectiveDone: false,
    };
  }
  return { ok: true, EffectiveDone: false };
}

function assertWp09VerifierJsPresent() {
  if (!pathExists(verifyJsPath)) {
    return {
      ok: false,
      failureReason: FailureReason.WP09_VERIFIER_JS_MISSING,
      message: `missing ${verifyJsPath}`,
      EffectiveDone: false,
    };
  }
  return { ok: true, path: verifyJsPath, EffectiveDone: false };
}

function assertWp09VerifierShPresent() {
  if (!pathExists(verifyShPath)) {
    return {
      ok: false,
      failureReason: FailureReason.WP09_VERIFIER_SH_MISSING,
      message: `missing ${verifyShPath}`,
      EffectiveDone: false,
    };
  }
  return { ok: true, path: verifyShPath, EffectiveDone: false };
}

function assertWp09UnitTestPresent() {
  if (!pathExists(verifyTestPath)) {
    return {
      ok: false,
      failureReason: FailureReason.WP09_UNIT_TEST_MISSING,
      message: `missing ${verifyTestPath}`,
      EffectiveDone: false,
    };
  }
  return { ok: true, path: verifyTestPath, EffectiveDone: false };
}

function assertWp09TransactionToolPresent() {
  if (!pathExists(wp09TxnToolPath)) {
    return {
      ok: false,
      failureReason: FailureReason.WP09_TRANSACTION_TOOL_MISSING,
      message: `missing ${wp09TxnToolPath}`,
      EffectiveDone: false,
    };
  }
  return { ok: true, path: wp09TxnToolPath, EffectiveDone: false };
}

function assertWp09TransactionTestPresent() {
  if (!pathExists(wp09TxnTestPath)) {
    return {
      ok: false,
      failureReason: FailureReason.WP09_TRANSACTION_TEST_MISSING,
      message: `missing ${wp09TxnTestPath}`,
      EffectiveDone: false,
    };
  }
  return { ok: true, path: wp09TxnTestPath, EffectiveDone: false };
}

function assertWp09StaticContract() {
  const files = [verifyJsPath, verifyShPath, wp09TxnToolPath].filter((p) => pathExists(p));
  if (!files.length) {
    return {
      ok: false,
      failureReason: FailureReason.WP09_STATIC_CONTRACT_MISSING,
      message: 'no verifier/transaction surfaces to scan',
      missing: WP09_STATIC_MARKERS.slice(),
      EffectiveDone: false,
    };
  }
  const text = files.map((f) => readText(f)).join('\n');
  const missing = WP09_STATIC_MARKERS.filter((m) => !text.includes(m));
  if (missing.length) {
    return {
      ok: false,
      failureReason: FailureReason.WP09_STATIC_CONTRACT_MISSING,
      message: `static contract missing: ${missing.join(',')}`,
      missing,
      EffectiveDone: false,
    };
  }
  return { ok: true, EffectiveDone: false };
}

function assertWp09MismatchFixtures() {
  const files = [verifyTestPath, wp09TxnTestPath, verifyJsPath].filter((p) => pathExists(p));
  if (!files.length) {
    return {
      ok: false,
      failureReason: FailureReason.WP09_MISMATCH_FIXTURES_MISSING,
      message: 'no test/verifier surfaces for mismatch fixtures',
      missing: WP09_MISMATCH_FIXTURES.slice(),
      EffectiveDone: false,
    };
  }
  const text = files.map((f) => readText(f)).join('\n');
  const missing = WP09_MISMATCH_FIXTURES.filter((m) => !text.includes(m));
  if (missing.length) {
    return {
      ok: false,
      failureReason: FailureReason.WP09_MISMATCH_FIXTURES_MISSING,
      message: `mismatch fixtures missing: ${missing.join(',')}`,
      missing,
      EffectiveDone: false,
    };
  }
  return { ok: true, EffectiveDone: false };
}

function assertWp09FullProductionCapacity() {
  const checks = [
    assertWp09ProductionSurfacesPresent(),
    assertWp09VerifierJsPresent(),
    assertWp09VerifierShPresent(),
    assertWp09UnitTestPresent(),
    assertWp09TransactionToolPresent(),
    assertWp09TransactionTestPresent(),
    assertWp09StaticContract(),
    assertWp09MismatchFixtures(),
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

function defaultDoneReceiptsThroughWp08() {
  return {
    'WP-00': wp00MergeReceipt,
    'WP-01': wp01TxnReceipt,
    'WP-02': wp02TxnReceipt,
    'WP-03': wp03TxnReceipt,
    'WP-04': wp04TxnReceipt,
    'WP-05': wp05TxnReceipt,
    'WP-06': wp06TxnReceipt,
    'WP-07': wp07TxnReceipt,
    'WP-08': wp08TxnReceipt,
  };
}

function defaultDoneReceiptsWithWp09() {
  return {
    ...defaultDoneReceiptsThroughWp08(),
    'WP-09': wp09TxnReceipt,
  };
}

function liveWp09OperationalProgress() {
  if (!pathExists(wp09TxnReceipt)) {
    return {
      exists: false,
      EffectiveDone: false,
      expectedCoreProgressPercent: EXPECTED_CURRENT_CORE_PROGRESS,
    };
  }
  const receipt = readJson(wp09TxnReceipt);
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
  if (!pathExists(wp09TxnReceipt)) {
    return { ok: false, failureReason: FailureReason.WP09_RECEIPT_MISSING };
  }
  const before = readJson(wp09TxnReceipt);
  const cas = runRunner([
    'receipt-cas',
    '--receipt',
    wp09TxnReceipt,
    '--expected-revision',
    String(before.revision || 1),
    '--expected-state',
    String(before.state || 'INIT'),
    '--state',
    'DONE',
    '--set-json',
    JSON.stringify({ EffectiveDone: true, coreProgressPercent: 70 }),
  ]);
  const after = pathExists(wp09TxnReceipt) ? readJson(wp09TxnReceipt) : null;
  return {
    ok: cas.status !== 0 && after && after.EffectiveDone !== true,
    status: cas.status,
    combined: cas.combined,
    after,
    failureReason:
      cas.status === 0 || (after && after.EffectiveDone === true)
        ? FailureReason.WP09_EFFECTIVE_DONE_FORGED
        : null,
  };
}

function initTempWp09Receipt() {
  const receipt = path.join(os.tmpdir(), `wp09-red-${process.pid}-${Date.now()}.json`);
  const init = runRunner(['receipt-init', '--task', TASK_ID, '--receipt', receipt]);
  return { receipt, init };
}

module.exports = {
  repoRoot,
  runnerPath,
  catalogPath,
  schemaPath,
  verifyJsPath,
  verifyShPath,
  verifyTestPath,
  wp09TxnToolPath,
  wp09TxnTestPath,
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
  wp09TxnReceipt,
  TASK_ID,
  EXPECTED_CURRENT_CORE_PROGRESS,
  EXPECTED_WEIGHT_FROM_PROGRESS_TABLE,
  EXPECTED_PROGRESS_WHEN_DONE,
  WP09_CREATE_REL,
  WP09_MODIFY_REL,
  WP09_STATIC_MARKERS,
  WP09_MISMATCH_FIXTURES,
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
  loadWp09CatalogEntry,
  parseWp09CatalogIdentity,
  readPrerequisiteDone,
  listMissingCreates,
  assertWp09ProductionSurfacesPresent,
  assertWp09VerifierJsPresent,
  assertWp09VerifierShPresent,
  assertWp09UnitTestPresent,
  assertWp09TransactionToolPresent,
  assertWp09TransactionTestPresent,
  assertWp09StaticContract,
  assertWp09MismatchFixtures,
  assertWp09FullProductionCapacity,
  computeCoreProgress,
  defaultDoneReceiptsThroughWp08,
  defaultDoneReceiptsWithWp09,
  liveWp09OperationalProgress,
  attemptCallerForgeEffectiveDone,
  initTempWp09Receipt,
};
