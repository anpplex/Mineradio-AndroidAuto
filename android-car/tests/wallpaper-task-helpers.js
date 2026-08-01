'use strict';

/**
 * Helpers for wallpaper-task.py fail-closed contract tests (WP-INFRA).
 * Tests use isolated temp trees only — never the historical verification tree.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const runnerPath = path.join(repoRoot, 'android-car', 'scripts', 'wallpaper-task.py');

/** Canonical machine-readable failure tokens expected from the runner. */
const FailureReason = Object.freeze({
  UNKNOWN_TASK: 'UNKNOWN_TASK',
  CALLER_DECLARED_DONE: 'CALLER_DECLARED_DONE',
  MISSING_RECEIPT: 'MISSING_RECEIPT',
  ILLEGAL_STATE: 'ILLEGAL_STATE',
  CALLER_SUPPLIED_IDENTITY: 'CALLER_SUPPLIED_IDENTITY',
  EVIDENCE_PATH_ESCAPE: 'EVIDENCE_PATH_ESCAPE',
  EVIDENCE_PATH_EXISTS: 'EVIDENCE_PATH_EXISTS',
  EVIDENCE_PATH_NOT_TRANSACTION: 'EVIDENCE_PATH_NOT_TRANSACTION',
  WRITER_LEASE_REQUIRED: 'WRITER_LEASE_REQUIRED',
  WRITER_LEASE_INVALID: 'WRITER_LEASE_INVALID',
  PARENT_EVIDENCE_REQUIRED: 'PARENT_EVIDENCE_REQUIRED',
});

function ensureRunnerPresent() {
  if (!fs.existsSync(runnerPath)) {
    throw new Error(`runner entry missing (test framework path error): ${runnerPath}`);
  }
}

function makeSandbox(prefix = 'wp-infra-red-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const transactions = path.join(root, 'transactions');
  const evidenceRoot = path.join(root, 'evidence');
  fs.mkdirSync(transactions, { recursive: true, mode: 0o700 });
  fs.mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
  return { root, transactions, evidenceRoot };
}

function writeJson(filePath, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode });
}

function runRunner(args, options = {}) {
  ensureRunnerPresent();
  const env = { ...process.env, ...(options.env || {}) };
  // Strip any ambient evidence/identity injection unless the test opts in.
  if (!options.keepAmbientIdentity) {
    delete env.RUN_UUID;
    delete env.TRANSACTION_ID;
    delete env.EVIDENCE_DIR;
  }
  const result = spawnSync('python3', [runnerPath, ...args], {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
    env,
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

/**
 * RED/GREEN contract: fail-closed commands must exit non-zero and emit a
 * stable machine-readable failure reason token (not silent success).
 */
function assertFailClosed(result, expectedReason, label = '') {
  const prefix = label ? `${label}: ` : '';
  assertNonZero(result, `${prefix}expected fail-closed non-zero exit`);
  assertMachineReadableFailure(result, expectedReason, prefix);
}

function assertNonZero(result, message) {
  if (result.status === 0) {
    const detail = [
      message,
      `status=${result.status}`,
      `stdout=${JSON.stringify(result.stdout)}`,
      `stderr=${JSON.stringify(result.stderr)}`,
    ].join('\n');
    throw new Error(detail);
  }
}

function assertMachineReadableFailure(result, expectedReason, prefix = '') {
  const text = result.combined;
  // Accept either JSON {"failureReason":"..."} or plain token lines.
  const jsonMatch = text.match(/"failureReason"\s*:\s*"([A-Z0-9_]+)"/);
  const lineMatch = text.match(/(?:^|\n)\s*(?:failureReason|FAILURE_REASON|errorCode)\s*[=:]\s*([A-Z0-9_]+)/i);
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

function transactionFile(transactionsDir, taskId = 'WP-00') {
  return path.join(transactionsDir, `${taskId.toLowerCase()}.json`);
}

module.exports = {
  FailureReason,
  repoRoot,
  runnerPath,
  ensureRunnerPresent,
  makeSandbox,
  writeJson,
  runRunner,
  assertFailClosed,
  assertNonZero,
  assertMachineReadableFailure,
  transactionFile,
};
