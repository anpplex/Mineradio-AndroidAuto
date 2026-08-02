'use strict';

/**
 * Helpers for WP-10A / RED-01 — user 12 install, real Mineradio caller, PID isolation (E3).
 *
 * RED only: catalog + E3 fixture / device-context capacity gaps.
 * Does not install packages, does not claim EffectiveDone, does not raise Core above 70%.
 *
 * Spec: Task 10 WP-10A weight 6 E3; prereqs INFRA…WP-09; progress 70 → 76 when DONE.
 * Device Gate: SERIAL LD249H019625, user 12, Android 12 / API 31, arm64-v8a.
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
const verifyJsPath = path.join(
  repoRoot,
  'android-car',
  'scripts',
  'verify-wallpaper-plugin.js',
);
const verifyTestPath = path.join(
  repoRoot,
  'android-car',
  'tests',
  'verify-wallpaper-plugin.test.js',
);

const TARGET_SERIAL = 'LD249H019625';
const TARGET_USER = '12';
const TARGET_ANDROID_RELEASE = '12';
const TARGET_API_LEVEL = 31;
const TARGET_ABI = 'arm64-v8a';

/** Task 10 / WP-10A E3 fixture names (must fail until GREEN implements verifyE3Evidence). */
const WP10A_E3_FAIL_FIXTURES = Object.freeze([
  'missingUser12',
  'shellCallerOnly',
  'actionTokenMissing',
  'actionTokenReplay',
  'confirmUserActionSkipped',
  'sourceConsumedMissing',
  'sourceUriNotRevoked',
  'runtimePidEmpty',
  'runtimePidDuplicate',
  'runtimePidEqualsMineradio',
]);

const WP10A_E3_MARKERS = Object.freeze([
  'callId',
  'operationId',
  'actionEpoch',
  'actionToken',
  'runtimePid',
  'sourceConsumed',
  'confirmUserAction',
  'importMpkg',
  'user 12',
  'we_runtime',
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
const wp10aTxnReceipt = path.join(transactionsRoot, 'wp-10a.json');

const TASK_ID = 'WP-10A';
/** WP-00…WP-09 = 70; +WP-10A(6)=76 when DONE. */
const EXPECTED_CURRENT_CORE_PROGRESS = 70;
const EXPECTED_WEIGHT_FROM_PROGRESS_TABLE = 6;
const EXPECTED_PROGRESS_WHEN_DONE = 76;

const FailureReason = Object.freeze({
  WP10A_CATALOG_ENTRY_MISSING: 'WP10A_CATALOG_ENTRY_MISSING',
  WP10A_CATALOG_FIELD_MISSING: 'WP10A_CATALOG_FIELD_MISSING',
  WP10A_E3_FIXTURES_MISSING: 'WP10A_E3_FIXTURES_MISSING',
  WP10A_E3_VERIFIER_MISSING: 'WP10A_E3_VERIFIER_MISSING',
  WP10A_BUNDLE_PARSER_MISSING: 'WP10A_BUNDLE_PARSER_MISSING',
  WP10A_DEVICE_CONTEXT_CMD_MISSING: 'WP10A_DEVICE_CONTEXT_CMD_MISSING',
  WP10A_DEVICE_OFFLINE: 'WP10A_DEVICE_OFFLINE',
  WP10A_BLOCKED_DEVICE: 'WP10A_BLOCKED_DEVICE',
  WP10A_RECEIPT_MISSING: 'WP10A_RECEIPT_MISSING',
  WP10A_EFFECTIVE_DONE_FORGED: 'WP10A_EFFECTIVE_DONE_FORGED',
  WP10A_REQUIRED_DONE_MISSING: 'WP10A_REQUIRED_DONE_MISSING',
});

function git(args, cwd = repoRoot) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    status: r.status === null ? 1 : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    combined: `${r.stdout || ''}${r.stderr || ''}`,
  };
}

function runRunner(argv) {
  const r = spawnSync('python3', [runnerPath, ...argv], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    status: r.status === null ? 1 : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    combined: `${r.stdout || ''}${r.stderr || ''}`,
  };
}

function parseRunnerJson(result) {
  const text = (result.stdout || '').trim();
  if (!text) return null;
  try {
    const lines = text.split(/\n/).filter(Boolean);
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function readText(p) {
  return fs.readFileSync(p, 'utf8');
}

function pathExists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function liveAuthoritativeBaseSha() {
  const r = git(['ls-remote', 'origin', 'refs/heads/huawei-android12-car']);
  if (r.status !== 0) {
    throw new Error(`ls-remote failed: ${r.combined}`);
  }
  const sha = (r.stdout || '').trim().split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`invalid live base sha: ${sha}`);
  }
  return sha;
}

function isGitAncestor(ancestor, descendant) {
  const r = git(['merge-base', '--is-ancestor', ancestor, descendant]);
  return r.status === 0;
}

function readTaskWorktreeIdentity() {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = git(['rev-parse', 'HEAD']);
  if (branch.status !== 0 || head.status !== 0) {
    return { ok: false, message: branch.combined || head.combined };
  }
  const b = branch.stdout.trim();
  const h = head.stdout.trim().toLowerCase();
  let liveBaseSha;
  try {
    liveBaseSha = liveAuthoritativeBaseSha();
  } catch (e) {
    return { ok: false, message: String(e.message || e) };
  }
  let relation = 'unknown';
  if (h === liveBaseSha) relation = 'equal';
  else if (isGitAncestor(liveBaseSha, h)) relation = 'ahead';
  else if (isGitAncestor(h, liveBaseSha)) relation = 'behind';
  return {
    ok: true,
    branch: b,
    head: h,
    liveBaseSha,
    relation,
  };
}

function loadWp10aCatalogEntry() {
  if (!pathExists(catalogPath)) {
    return { ok: false, failureReason: FailureReason.WP10A_CATALOG_ENTRY_MISSING };
  }
  const catalog = readJson(catalogPath);
  const matches = (catalog.tasks || []).filter((t) => t && t.taskId === TASK_ID);
  if (matches.length !== 1) {
    return {
      ok: false,
      failureReason: FailureReason.WP10A_CATALOG_ENTRY_MISSING,
      count: matches.length,
    };
  }
  return { ok: true, task: matches[0], catalog };
}

function parseWp10aCatalogIdentity(task) {
  const missing = [];
  if (task.weight !== EXPECTED_WEIGHT_FROM_PROGRESS_TABLE) missing.push('weight');
  if (task.evidenceLevel !== 'E3') missing.push('evidenceLevel');
  const req = task.requiredEffectiveDone || [];
  for (const id of [
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
    'WP-09',
  ]) {
    if (!req.includes(id)) missing.push(`requiredEffectiveDone:${id}`);
  }
  if (!task.phaseCommands || !task.phaseCommands.RED) missing.push('phaseCommands.RED');
  if (missing.length) {
    return {
      ok: false,
      failureReason: FailureReason.WP10A_CATALOG_FIELD_MISSING,
      missing,
    };
  }
  return { ok: true };
}

function readPrerequisiteDone() {
  const map = {
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
    'WP-09': wp09TxnReceipt,
  };
  const out = { ok: true };
  for (const [id, p] of Object.entries(map)) {
    if (!pathExists(p)) {
      out.ok = false;
      out.failureReason = FailureReason.WP10A_REQUIRED_DONE_MISSING;
      out.missing = id;
      return out;
    }
    const data = readJson(p);
    // INFRA/00 may use EffectiveGate or merge receipts
    const done =
      data.EffectiveDone === true ||
      data.EffectiveGate === true ||
      (data.state === 'DONE' && data.verifyDone);
    out[id] = {
      path: p,
      EffectiveDone: data.EffectiveDone === true || done,
      state: data.state,
      hasVerifyDone: Boolean(data.verifyDone),
    };
    if (id.startsWith('WP-0') && id !== 'WP-00' && id !== 'WP-INFRA') {
      if (!(data.EffectiveDone === true && data.state === 'DONE' && data.verifyDone)) {
        out.ok = false;
        out.failureReason = FailureReason.WP10A_REQUIRED_DONE_MISSING;
        out.missing = id;
      }
    }
  }
  // WP-09 hard requirement
  if (
    !(
      out['WP-09'] &&
      out['WP-09'].EffectiveDone === true &&
      readJson(wp09TxnReceipt).state === 'DONE' &&
      readJson(wp09TxnReceipt).verifyDone
    )
  ) {
    out.ok = false;
    out.failureReason = FailureReason.WP10A_REQUIRED_DONE_MISSING;
    out.missing = 'WP-09';
  }
  return out;
}

function runnerHasCommand(name) {
  const help = runRunner(['--help']);
  // COMMANDS are positional; probe by invoking unknown/known
  const r = runRunner([name, '--help']);
  // Missing commands fail with illegal command or similar
  const text = `${help.combined}\n${r.combined}`;
  // Prefer source scan of runner
  if (!pathExists(runnerPath)) return false;
  const src = readText(runnerPath);
  return (
    src.includes(`"${name}"`) ||
    src.includes(`'${name}'`) ||
    new RegExp(`def cmd_.*${name.replace(/-/g, '_')}`).test(src)
  );
}

function assertDeviceContextCommandPresent() {
  if (!runnerHasCommand('assert-device-context')) {
    return {
      ok: false,
      failureReason: FailureReason.WP10A_DEVICE_CONTEXT_CMD_MISSING,
      message: 'wallpaper-task.py missing assert-device-context command',
    };
  }
  return { ok: true };
}

function probeTargetDevice() {
  const r = spawnSync('adb', ['-s', TARGET_SERIAL, 'get-state'], {
    encoding: 'utf8',
  });
  const state = (r.stdout || '').trim();
  if (r.status !== 0 || state !== 'device') {
    return {
      ok: false,
      failureReason: FailureReason.WP10A_DEVICE_OFFLINE,
      blocked: FailureReason.WP10A_BLOCKED_DEVICE,
      message: `device ${TARGET_SERIAL} not online (state=${state || 'missing'})`,
      serial: TARGET_SERIAL,
      state: state || null,
    };
  }
  return { ok: true, serial: TARGET_SERIAL, state };
}

function assertE3VerifierSurface() {
  if (!pathExists(verifyJsPath)) {
    return {
      ok: false,
      failureReason: FailureReason.WP10A_E3_VERIFIER_MISSING,
      message: 'verify-wallpaper-plugin.js missing',
    };
  }
  let mod;
  try {
    // eslint-disable-next-line import/no-dynamic-require, global-require
    mod = require(verifyJsPath);
  } catch (e) {
    return {
      ok: false,
      failureReason: FailureReason.WP10A_E3_VERIFIER_MISSING,
      message: String(e.message || e),
    };
  }
  if (typeof mod.verifyE3Evidence !== 'function' && typeof mod.verifyE3 !== 'function') {
    return {
      ok: false,
      failureReason: FailureReason.WP10A_E3_VERIFIER_MISSING,
      message: 'verifyE3Evidence/verifyE3 export missing',
    };
  }
  return { ok: true, mod };
}

function assertBundleParserSurface() {
  if (!pathExists(verifyJsPath)) {
    return {
      ok: false,
      failureReason: FailureReason.WP10A_BUNDLE_PARSER_MISSING,
      message: 'verify-wallpaper-plugin.js missing',
    };
  }
  // eslint-disable-next-line import/no-dynamic-require, global-require
  const mod = require(verifyJsPath);
  if (
    typeof mod.parseContentCallBundle !== 'function' &&
    typeof mod.parseProviderBundle !== 'function'
  ) {
    return {
      ok: false,
      failureReason: FailureReason.WP10A_BUNDLE_PARSER_MISSING,
      message: 'parseContentCallBundle/parseProviderBundle export missing',
    };
  }
  return { ok: true };
}

function assertE3FixturesPresent() {
  if (!pathExists(verifyJsPath)) {
    return {
      ok: false,
      failureReason: FailureReason.WP10A_E3_FIXTURES_MISSING,
      message: 'verifier missing',
    };
  }
  // eslint-disable-next-line import/no-dynamic-require, global-require
  const mod = require(verifyJsPath);
  const names = mod.E3_FIXTURE_NAMES || mod.WP10A_E3_FAIL_FIXTURES || [];
  const missing = WP10A_E3_FAIL_FIXTURES.filter((n) => !names.includes(n));
  if (missing.length || typeof mod.buildE3Fixture !== 'function') {
    return {
      ok: false,
      failureReason: FailureReason.WP10A_E3_FIXTURES_MISSING,
      message: missing.length
        ? `missing fixtures: ${missing.join(',')}`
        : 'buildE3Fixture missing',
      missing,
    };
  }
  return { ok: true };
}

function assertWp10aFullProductionCapacity() {
  const checks = [
    assertDeviceContextCommandPresent(),
    assertE3VerifierSurface(),
    assertBundleParserSurface(),
    assertE3FixturesPresent(),
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

function defaultDoneReceiptsThroughWp09() {
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
    'WP-09': wp09TxnReceipt,
  };
}

function defaultDoneReceiptsWithWp10a() {
  return {
    ...defaultDoneReceiptsThroughWp09(),
    'WP-10A': wp10aTxnReceipt,
  };
}

function liveWp10aOperationalProgress() {
  if (!pathExists(wp10aTxnReceipt)) {
    return {
      exists: false,
      EffectiveDone: false,
      expectedCoreProgressPercent: EXPECTED_CURRENT_CORE_PROGRESS,
    };
  }
  const receipt = readJson(wp10aTxnReceipt);
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

function initTempWp10aReceipt() {
  const receipt = path.join(os.tmpdir(), `wp10a-red-${process.pid}-${Date.now()}.json`);
  const init = runRunner(['receipt-init', '--task', TASK_ID, '--receipt', receipt]);
  return { receipt, init };
}

module.exports = {
  repoRoot,
  runnerPath,
  catalogPath,
  schemaPath,
  verifyJsPath,
  verifyTestPath,
  TARGET_SERIAL,
  TARGET_USER,
  TARGET_ANDROID_RELEASE,
  TARGET_API_LEVEL,
  TARGET_ABI,
  WP10A_E3_FAIL_FIXTURES,
  WP10A_E3_MARKERS,
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
  wp10aTxnReceipt,
  TASK_ID,
  EXPECTED_CURRENT_CORE_PROGRESS,
  EXPECTED_WEIGHT_FROM_PROGRESS_TABLE,
  EXPECTED_PROGRESS_WHEN_DONE,
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
  loadWp10aCatalogEntry,
  parseWp10aCatalogIdentity,
  readPrerequisiteDone,
  runnerHasCommand,
  assertDeviceContextCommandPresent,
  probeTargetDevice,
  assertE3VerifierSurface,
  assertBundleParserSurface,
  assertE3FixturesPresent,
  assertWp10aFullProductionCapacity,
  computeCoreProgress,
  defaultDoneReceiptsThroughWp09,
  defaultDoneReceiptsWithWp10a,
  liveWp10aOperationalProgress,
  initTempWp10aReceipt,
};
