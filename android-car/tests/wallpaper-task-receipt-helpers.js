'use strict';

/**
 * Helpers for WP-INFRA receipt atomic write / revision CAS / recovery tests.
 * All fixtures use isolated temp trees — never historical verification receipts.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const runnerPath = path.join(repoRoot, 'android-car', 'scripts', 'wallpaper-task.py');

/** Machine-readable failure tokens for receipt operations. */
const ReceiptFailureReason = Object.freeze({
  RECEIPT_EXISTS: 'RECEIPT_EXISTS',
  RECEIPT_MODE_INVALID: 'RECEIPT_MODE_INVALID',
  RECEIPT_REVISION_CAS: 'RECEIPT_REVISION_CAS',
  RECEIPT_STATE_CAS: 'RECEIPT_STATE_CAS',
  ONLY_VERIFY_DONE_MAY_ENABLE_EFFECTIVE_DONE: 'ONLY_VERIFY_DONE_MAY_ENABLE_EFFECTIVE_DONE',
  RECEIPT_READBACK_MISMATCH: 'RECEIPT_READBACK_MISMATCH',
  RECEIPT_IN_FLIGHT_RECOVERY_REQUIRED: 'RECEIPT_IN_FLIGHT_RECOVERY_REQUIRED',
  ATTEMPT_APPEND_ONLY: 'ATTEMPT_APPEND_ONLY',
  RECEIPT_CORRUPT: 'RECEIPT_CORRUPT',
  MISSING_RECEIPT: 'MISSING_RECEIPT',
  RECEIPT_PATH_ESCAPE: 'RECEIPT_PATH_ESCAPE',
});

const RECEIPT_SCHEMA = 'wallpaper-task-receipt/v1';

function ensureRunnerPresent() {
  if (!fs.existsSync(runnerPath)) {
    throw new Error(`runner missing (test framework path error): ${runnerPath}`);
  }
}

function makeReceiptSandbox(prefix = 'wp-infra-receipt-red-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const receipts = path.join(root, 'receipts');
  fs.mkdirSync(receipts, { recursive: true, mode: 0o700 });
  return { root, receipts };
}

function receiptPath(receiptsDir, name = 'WP-INFRA.json') {
  return path.join(receiptsDir, name);
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

function minimalReceipt(overrides = {}) {
  return {
    schema: RECEIPT_SCHEMA,
    taskId: 'WP-INFRA',
    state: 'INIT',
    revision: 1,
    EffectiveDone: false,
    attempts: [],
    phaseEvents: [],
    ...overrides,
  };
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

function receiptInit(receiptFile, options = {}) {
  const args = [
    'receipt-init',
    '--receipt',
    receiptFile,
    '--task',
    options.taskId || 'WP-INFRA',
  ];
  if (options.schema) {
    args.push('--schema', options.schema);
  }
  return runRunner(args);
}

function receiptCas(receiptFile, options = {}) {
  const args = [
    'receipt-cas',
    '--receipt',
    receiptFile,
    '--expected-revision',
    String(options.expectedRevision),
    '--expected-state',
    options.expectedState,
    '--state',
    options.state,
  ];
  if (options.setJson !== undefined) {
    args.push(
      '--set-json',
      typeof options.setJson === 'string' ? options.setJson : JSON.stringify(options.setJson),
    );
  }
  return runRunner(args);
}

function receiptRead(receiptFile, field = null) {
  const args = ['receipt-read', '--receipt', receiptFile];
  if (field) args.push('--field', field);
  return runRunner(args);
}

function receiptReadback(receiptFile) {
  return runRunner(['receipt-readback', '--receipt', receiptFile]);
}

function receiptAppendAttempt(receiptFile, options = {}) {
  const args = [
    'receipt-append-attempt',
    '--receipt',
    receiptFile,
    '--expected-revision',
    String(options.expectedRevision),
  ];
  if (options.attemptJson !== undefined) {
    args.push(
      '--attempt-json',
      typeof options.attemptJson === 'string'
        ? options.attemptJson
        : JSON.stringify(options.attemptJson),
    );
  }
  return runRunner(args);
}

function receiptResume(receiptFile) {
  return runRunner(['receipt-resume', '--receipt', receiptFile]);
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
  ReceiptFailureReason,
  RECEIPT_SCHEMA,
  repoRoot,
  runnerPath,
  ensureRunnerPresent,
  makeReceiptSandbox,
  receiptPath,
  writeJson,
  readJson,
  fileMode,
  minimalReceipt,
  runRunner,
  receiptInit,
  receiptCas,
  receiptRead,
  receiptReadback,
  receiptAppendAttempt,
  receiptResume,
  assertFailClosed,
};
