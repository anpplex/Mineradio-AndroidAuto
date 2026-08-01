'use strict';

/**
 * WP-INFRA / RED-01 contract tests for wallpaper-task.py fail-closed behavior.
 *
 * These tests assert production runner semantics. Against the RED stub they
 * must fail because of missing/incorrect behavior — not path or env errors.
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FailureReason,
  runnerPath,
  ensureRunnerPresent,
  makeSandbox,
  writeJson,
  runRunner,
  assertFailClosed,
  transactionFile,
} = require('./wallpaper-task-helpers');

test('WP-INFRA RED-01: runner entry is invokable (framework path)', () => {
  ensureRunnerPresent();
  assert.equal(fs.existsSync(runnerPath), true);
  const result = runRunner(['--help-or-unknown']);
  // Path/env must not throw; behavioral contracts are asserted below.
  assert.equal(typeof result.status, 'number');
});

test('RED-01.1 rejects unknown WP task id', () => {
  const { transactions } = makeSandbox();
  const result = runRunner([
    'reconcile',
    '--task',
    'WP-NOT-A-REAL-TASK',
    '--transactions',
    transactions,
  ]);
  assertFailClosed(result, FailureReason.UNKNOWN_TASK, 'unknown task id');
});

test('RED-01.2 rejects caller-declared DONE', () => {
  const { transactions } = makeSandbox();
  const txn = transactionFile(transactions, 'WP-00');
  writeJson(txn, {
    schemaVersion: 1,
    taskId: 'WP-00',
    state: 'INIT',
    revision: 1,
    transactionId: 'must-not-be-caller-owned',
    runUuid: 'must-not-be-caller-owned',
  });

  // Caller attempts to force DONE without verify-done / phase ledger.
  const viaAssert = runRunner([
    'assert-state',
    '--task',
    'WP-00',
    '--expected',
    'DONE',
    '--transactions',
    transactions,
    '--declare-done',
  ]);
  assertFailClosed(viaAssert, FailureReason.CALLER_DECLARED_DONE, 'assert-state declare DONE');

  const viaCas = runRunner([
    'cas-state',
    '--task',
    'WP-00',
    '--from',
    'INIT',
    '--to',
    'DONE',
    '--transactions',
    transactions,
  ]);
  assertFailClosed(viaCas, FailureReason.CALLER_DECLARED_DONE, 'cas-state to DONE');
});

test('RED-01.3 refuses to continue when receipt is missing', () => {
  const { transactions } = makeSandbox();
  // No transaction file created for WP-00.
  const result = runRunner([
    'begin-phase',
    '--task',
    'WP-00',
    '--phase',
    'RED',
    '--from-catalog',
    '--transactions',
    transactions,
  ]);
  assertFailClosed(result, FailureReason.MISSING_RECEIPT, 'missing receipt');
});

test('RED-01.4 fail-closes on illegal receipt state', () => {
  const { transactions } = makeSandbox();
  const txn = transactionFile(transactions, 'WP-00');
  writeJson(txn, {
    schemaVersion: 1,
    taskId: 'WP-00',
    // Illegal: DONE without prior phase ledger / verify-done chain.
    state: 'DONE',
    revision: 1,
    EffectiveDone: true,
  });

  const result = runRunner([
    'begin-phase',
    '--task',
    'WP-00',
    '--phase',
    'RED',
    '--from-catalog',
    '--transactions',
    transactions,
  ]);
  assertFailClosed(result, FailureReason.ILLEGAL_STATE, 'illegal DONE receipt');
});

test('RED-01.5 rejects transactionId/runUuid injection via CLI or env', () => {
  const { transactions } = makeSandbox();

  const viaCli = runRunner([
    'init',
    '--task',
    'WP-00',
    '--transactions',
    transactions,
    '--transaction-id',
    'attacker-txn-id',
    '--run-uuid',
    'attacker-run-uuid',
  ]);
  assertFailClosed(viaCli, FailureReason.CALLER_SUPPLIED_IDENTITY, 'CLI identity injection');

  const viaEnv = runRunner(
    ['init', '--task', 'WP-00', '--transactions', transactions],
    {
      keepAmbientIdentity: true,
      env: {
        TRANSACTION_ID: 'attacker-txn-id',
        RUN_UUID: 'attacker-run-uuid',
      },
    },
  );
  assertFailClosed(viaEnv, FailureReason.CALLER_SUPPLIED_IDENTITY, 'env identity injection');
});

test('RED-01.6 rejects evidence paths that escape the sandbox root', () => {
  const { transactions, root } = makeSandbox();
  const txn = transactionFile(transactions, 'WP-10A');
  writeJson(txn, {
    schemaVersion: 1,
    taskId: 'WP-10A',
    state: 'EVIDENCE_ATTEMPT_OPEN',
    revision: 1,
  });

  const escaped = path.join(root, '..', 'escape-evidence.bin');
  const result = runRunner([
    'assert-evidence-path',
    '--file',
    txn,
    '--path',
    escaped,
    '--contained',
    '--transactions',
    transactions,
  ]);
  assertFailClosed(result, FailureReason.EVIDENCE_PATH_ESCAPE, 'path escape');
});

test('RED-01.7 rejects evidence path that would clobber existing content', () => {
  const { transactions, evidenceRoot } = makeSandbox();
  const txn = transactionFile(transactions, 'WP-10A');
  writeJson(txn, {
    schemaVersion: 1,
    taskId: 'WP-10A',
    state: 'EVIDENCE_ATTEMPT_OPEN',
    revision: 1,
  });

  const target = path.join(evidenceRoot, 'raw-index.json');
  fs.writeFileSync(target, '{"existing":true}\n', { mode: 0o600 });

  const result = runRunner([
    'collect-raw',
    '--file',
    txn,
    '--path',
    target,
    '--transactions',
    transactions,
  ]);
  assertFailClosed(result, FailureReason.EVIDENCE_PATH_EXISTS, 'no-clobber');
});

test('RED-01.8 rejects evidence paths outside the transaction evidence tree', () => {
  const { transactions } = makeSandbox();
  const txn = transactionFile(transactions, 'WP-10A');
  writeJson(txn, {
    schemaVersion: 1,
    taskId: 'WP-10A',
    state: 'EVIDENCE_ATTEMPT_OPEN',
    revision: 1,
  });

  // Absolute non-transaction location (temp file, not under transactions/).
  const outside = path.join(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'wp-outside-')), 'raw.bin');
  fs.writeFileSync(outside, '');

  const result = runRunner([
    'assert-evidence-path',
    '--file',
    txn,
    '--path',
    outside,
    '--contained',
    '--transactions',
    transactions,
  ]);
  assertFailClosed(result, FailureReason.EVIDENCE_PATH_NOT_TRANSACTION, 'non-transaction path');
});

test('RED-01.9 rejects collector write without a valid writer lease', () => {
  const { transactions, evidenceRoot } = makeSandbox();
  const txn = transactionFile(transactions, 'WP-10A');
  writeJson(txn, {
    schemaVersion: 1,
    taskId: 'WP-10A',
    state: 'EVIDENCE_ATTEMPT_OPEN',
    revision: 1,
    // Intentionally no collectorPid / leaseNonce / leaseUntil.
  });

  const target = path.join(evidenceRoot, 'attempt-1', 'frame.png');
  const result = runRunner([
    'collector-write',
    '--file',
    txn,
    '--path',
    target,
    '--bytes-b64',
    Buffer.from('not-a-real-frame').toString('base64'),
    '--transactions',
    transactions,
  ]);
  assertFailClosed(result, FailureReason.WRITER_LEASE_REQUIRED, 'no lease');
});

test('RED-01.10 rejects writes from closed, failed, expired, or foreign attempt writers', () => {
  const { transactions, evidenceRoot } = makeSandbox();
  const txn = transactionFile(transactions, 'WP-10A');
  const now = Date.now();
  writeJson(txn, {
    schemaVersion: 1,
    taskId: 'WP-10A',
    state: 'EVIDENCE_ATTEMPT_OPEN',
    revision: 2,
    collectorPid: process.pid,
    leaseNonce: 'lease-current',
    leaseUntil: now + 60_000,
    attemptNo: 2,
    attemptEpoch: 2,
    attempts: [
      {
        attemptNo: 1,
        attemptEpoch: 1,
        status: 'ATTEMPT_FAILED',
        leaseNonce: 'lease-old',
        leaseClosed: true,
      },
      {
        attemptNo: 2,
        attemptEpoch: 2,
        status: 'EVIDENCE_ATTEMPT_OPEN',
        leaseNonce: 'lease-current',
        leaseClosed: false,
      },
    ],
  });

  const target = path.join(evidenceRoot, 'attempt-1', 'late-write.bin');

  const closedWriter = runRunner([
    'collector-write',
    '--file',
    txn,
    '--path',
    target,
    '--lease-nonce',
    'lease-old',
    '--attempt-no',
    '1',
    '--bytes-b64',
    Buffer.from('stale').toString('base64'),
    '--transactions',
    transactions,
  ]);
  assertFailClosed(closedWriter, FailureReason.WRITER_LEASE_INVALID, 'closed/failed attempt writer');

  const expiredWriter = runRunner([
    'collector-write',
    '--file',
    txn,
    '--path',
    target,
    '--lease-nonce',
    'lease-current',
    '--attempt-no',
    '2',
    '--lease-until',
    String(now - 1),
    '--bytes-b64',
    Buffer.from('expired').toString('base64'),
    '--transactions',
    transactions,
  ]);
  assertFailClosed(expiredWriter, FailureReason.WRITER_LEASE_INVALID, 'expired lease');

  const foreignAttempt = runRunner([
    'collector-write',
    '--file',
    txn,
    '--path',
    target,
    '--lease-nonce',
    'lease-current',
    '--attempt-no',
    '99',
    '--bytes-b64',
    Buffer.from('foreign').toString('base64'),
    '--transactions',
    transactions,
  ]);
  assertFailClosed(foreignAttempt, FailureReason.WRITER_LEASE_INVALID, 'foreign attempt');
});

test('RED-01.11 rejects skipping when upstream parent evidence is unsatisfied', () => {
  const { transactions } = makeSandbox();
  const txn = transactionFile(transactions, 'WP-10B');
  writeJson(txn, {
    schemaVersion: 1,
    taskId: 'WP-10B',
    state: 'INIT',
    revision: 1,
    // Parent WP-10A evidence not sealed / EffectiveDone false.
    parentTaskId: 'WP-10A',
    parentManifestSha256: null,
  });

  const result = runRunner([
    'open-attempt',
    '--task',
    'WP-10B',
    '--transactions',
    transactions,
    '--require-parent-effective-done',
  ]);
  assertFailClosed(result, FailureReason.PARENT_EVIDENCE_REQUIRED, 'parent evidence skip');
});

test('RED-01.12 emits machine-readable failure reasons and never silently swallows errors', () => {
  const { transactions } = makeSandbox();
  const result = runRunner([
    'reconcile',
    '--task',
    'WP-TOTALLY-INVALID',
    '--transactions',
    transactions,
  ]);

  // Must not look like success.
  assert.notEqual(result.status, 0, 'silent success is forbidden');
  // Must not be empty failure (swallowed).
  assert.ok(
    result.stdout.length + result.stderr.length > 0,
    'failure output must not be empty',
  );
  // Must include a machine-readable token (at least UNKNOWN_TASK for this case).
  assert.match(
    result.combined,
    /"failureReason"\s*:\s*"[A-Z0-9_]+"|failureReason\s*[=:]\s*[A-Z0-9_]+|UNKNOWN_TASK|BLOCKED_[A-Z0-9_]+/,
    `expected machine-readable failure, got:\n${result.combined}`,
  );
});
