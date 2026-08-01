'use strict';

/**
 * Helpers for WP-INFRA RED-04 bootstrap receipt / SHA / origin / EffectiveGate tests.
 * Fixtures use isolated temp trees only — never the historical bootstrap path.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const runnerPath = path.join(repoRoot, 'android-car', 'scripts', 'wallpaper-task.py');
const runnerSrc = path.join(repoRoot, 'android-car', 'scripts', 'wallpaper-task.py');
const catalogSrc = path.join(repoRoot, 'android-car', 'scripts', 'wallpaper-plugin-tasks.json');
const schemaSrc = path.join(repoRoot, 'android-car', 'scripts', 'wallpaper-task.schema.json');

const BootstrapFailureReason = Object.freeze({
  BOOTSTRAP_RECEIPT_EXISTS: 'BOOTSTRAP_RECEIPT_EXISTS',
  BOOTSTRAP_MODE_INVALID: 'BOOTSTRAP_MODE_INVALID',
  BOOTSTRAP_MISSING_FIELD: 'BOOTSTRAP_MISSING_FIELD',
  BOOTSTRAP_SHA_MISMATCH: 'BOOTSTRAP_SHA_MISMATCH',
  ORIGIN_SHA_MISMATCH: 'ORIGIN_SHA_MISMATCH',
  PHASE_LEDGER_INCOMPLETE: 'PHASE_LEDGER_INCOMPLETE',
  EFFECTIVE_GATE_FALSE: 'EFFECTIVE_GATE_FALSE',
  EFFECTIVE_GATE_CLAIM_REJECTED: 'EFFECTIVE_GATE_CLAIM_REJECTED',
  SYNC_IN_FLIGHT_RECOVERY_REQUIRED: 'SYNC_IN_FLIGHT_RECOVERY_REQUIRED',
  MISSING_RECEIPT: 'MISSING_RECEIPT',
  BOOTSTRAP_PATH_ESCAPE: 'BOOTSTRAP_PATH_ESCAPE',
});

const REQUIRED_BOOTSTRAP_FIELDS = Object.freeze([
  'revision',
  'taskId',
  'state',
  'phaseEvents',
  'INFRA_SHA',
  'runnerSha256',
  'catalogSha256',
  'schemaSha256',
  'originReadback',
  'EffectiveDone',
  'EffectiveGate',
]);

function ensureRunnerPresent() {
  if (!fs.existsSync(runnerPath)) {
    throw new Error(`runner missing (test framework path error): ${runnerPath}`);
  }
}

function makeBootstrapSandbox(prefix = 'wp-infra-bootstrap-red-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const bootstrap = path.join(root, 'bootstrap');
  fs.mkdirSync(bootstrap, { recursive: true, mode: 0o700 });
  return { root, bootstrap };
}

function bootstrapReceiptPath(bootstrapDir, name = 'WP-INFRA.json') {
  return path.join(bootstrapDir, name);
}

function writeJson(filePath, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function fileMode(filePath) {
  return fs.statSync(filePath).mode & 0o777;
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function minimalBootstrapReceipt(overrides = {}) {
  return {
    schema: 'wallpaper-infra-bootstrap/v1',
    taskId: 'WP-INFRA',
    state: 'INIT',
    revision: 1,
    phaseEvents: [],
    INFRA_SHA: null,
    runnerSha256: null,
    catalogSha256: null,
    schemaSha256: null,
    originReadback: null,
    EffectiveDone: false,
    EffectiveGate: false,
    ...overrides,
  };
}

function completePhaseEvents() {
  return [
    { phase: 'RED', status: 'PASS', failureSignature: 'RECEIPT_REVISION_CAS' },
    { phase: 'GREEN', status: 'PASS' },
    { phase: 'REFACTOR', status: 'PASS' },
    { phase: 'VERIFY', status: 'PASS' },
    { phase: 'COMMIT', status: 'PASS' },
  ];
}

function runRunner(args, options = {}) {
  ensureRunnerPresent();
  const result = spawnSync('python3', [runnerPath, ...args], {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...(options.env || {}) },
    timeout: options.timeout || 15_000,
  });
  if (result.error) {
    const err = result.error;
    err.message = `runner spawn failed (environment/path): ${err.message}`;
    throw err;
  }
  return {
    status: result.status === null ? 1 : result.status,
    signal: result.signal,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    combined: `${result.stdout || ''}\n${result.stderr || ''}`,
  };
}

function bootstrapInit(receiptFile, options = {}) {
  const args = ['bootstrap-init', '--receipt', receiptFile, '--task', options.taskId || 'WP-INFRA'];
  if (options.requireContained) {
    args.push('--require-contained', '--bootstrap-root', options.bootstrapRoot);
  }
  return runRunner(args);
}

function bootstrapRecordSha(receiptFile, kind, sha256, filePath = null) {
  const args = [
    'bootstrap-record-sha',
    '--receipt',
    receiptFile,
    '--kind',
    kind,
    '--sha256',
    sha256,
  ];
  if (filePath) args.push('--path', filePath);
  return runRunner(args);
}

function bootstrapRecordPhase(receiptFile, phase, status, signature = null) {
  const args = [
    'bootstrap-record-phase',
    '--receipt',
    receiptFile,
    '--phase',
    phase,
    '--status',
    status,
  ];
  if (signature) args.push('--failure-signature', signature);
  return runRunner(args);
}

function bootstrapRecordOrigin(receiptFile, options) {
  return runRunner([
    'bootstrap-record-origin',
    '--receipt',
    receiptFile,
    '--expected-sha',
    options.expectedSha,
    '--observed-sha',
    options.observedSha,
    '--ref',
    options.ref || 'refs/heads/codex/wallpaper-plugin-infra',
  ]);
}

function bootstrapReadback(receiptFile, options) {
  return runRunner([
    'bootstrap-readback',
    '--receipt',
    receiptFile,
    '--infra-sha',
    options.infraSha,
    '--remote-sha',
    options.remoteSha,
  ]);
}

function assertEffectiveGate(receiptFile, expected) {
  return runRunner([
    'assert-effective-gate',
    '--receipt',
    receiptFile,
    '--expected',
    String(expected),
  ]);
}

function evaluateEffectiveGate(receiptFile) {
  return runRunner(['evaluate-effective-gate', '--receipt', receiptFile]);
}

function bootstrapClaimDone(receiptFile) {
  return runRunner(['bootstrap-claim-done', '--receipt', receiptFile]);
}

function bootstrapSyncInFlight(receiptFile, options = {}) {
  return runRunner([
    'bootstrap-sync-begin',
    '--receipt',
    receiptFile,
    '--expected-sha',
    options.expectedSha || 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    '--ref',
    options.ref || 'refs/heads/codex/wallpaper-plugin-infra',
  ]);
}

function bootstrapSyncResume(receiptFile) {
  return runRunner(['bootstrap-sync-resume', '--receipt', receiptFile]);
}

function assertFailClosed(result, expectedReason, label = '') {
  const prefix = label ? `${label}: ` : '';
  if (result.status === 0) {
    throw new Error(
      `${prefix}expected fail-closed non-zero exit\n` +
        `status=${result.status}\n` +
        `stdout=${JSON.stringify(result.stdout)}\n` +
        `stderr=${JSON.stringify(result.stderr)}`,
    );
  }
  const text = result.combined;
  const jsonMatch = text.match(/"failureReason"\s*:\s*"([A-Z0-9_]+)"/);
  const lineMatch = text.match(
    /(?:^|\n)\s*(?:failureReason|FAILURE_REASON|errorCode)\s*[=:]\s*([A-Z0-9_]+)/i,
  );
  const tokenMatch = text.includes(expectedReason) ? expectedReason : null;
  const observed = (jsonMatch && jsonMatch[1]) || (lineMatch && lineMatch[1]) || tokenMatch;
  if (!observed) {
    throw new Error(
      `${prefix}missing machine-readable failure reason ${expectedReason}\n` +
        `stdout=${JSON.stringify(result.stdout)}\n` +
        `stderr=${JSON.stringify(result.stderr)}`,
    );
  }
  if (observed !== expectedReason) {
    throw new Error(
      `${prefix}failure reason mismatch: expected ${expectedReason}, got ${observed}\n` +
        `stdout=${JSON.stringify(result.stdout)}\n` +
        `stderr=${JSON.stringify(result.stderr)}`,
    );
  }
}

module.exports = {
  BootstrapFailureReason,
  REQUIRED_BOOTSTRAP_FIELDS,
  repoRoot,
  runnerPath,
  runnerSrc,
  catalogSrc,
  schemaSrc,
  ensureRunnerPresent,
  makeBootstrapSandbox,
  bootstrapReceiptPath,
  writeJson,
  readJson,
  fileMode,
  sha256File,
  minimalBootstrapReceipt,
  completePhaseEvents,
  runRunner,
  bootstrapInit,
  bootstrapRecordSha,
  bootstrapRecordPhase,
  bootstrapRecordOrigin,
  bootstrapReadback,
  assertEffectiveGate,
  evaluateEffectiveGate,
  bootstrapClaimDone,
  bootstrapSyncInFlight,
  bootstrapSyncResume,
  assertFailClosed,
};
