'use strict';

/**
 * WP-INFRA receipt contract tests: atomic write, revision/state CAS, recovery.
 * Originally RED-03 fail-closed contracts; GREEN-03 implements the runner surface.
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ReceiptFailureReason,
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
  receiptReadback,
  receiptAppendAttempt,
  receiptResume,
  assertFailClosed,
} = require('./wallpaper-task-receipt-helpers');

test('WP-INFRA RED-03: runner is invokable for receipt surface (framework path)', () => {
  ensureRunnerPresent();
  const result = runRunner(['receipt-init', '--help-or-probe']);
  assert.equal(typeof result.status, 'number');
});

test('RED-03.1 receipt-init is exclusive-create / no-clobber', () => {
  const { receipts } = makeReceiptSandbox();
  const file = receiptPath(receipts);
  writeJson(file, minimalReceipt({ state: 'INIT', revision: 1 }));

  // Second init against existing path must fail closed (no overwrite).
  const result = receiptInit(file);
  assertFailClosed(result, ReceiptFailureReason.RECEIPT_EXISTS, 'no-clobber init');
});

test('RED-03.2 receipt files must be mode 0600', () => {
  const { receipts } = makeReceiptSandbox();
  const file = receiptPath(receipts);

  // Production init must create 0600; for RED we plant a world-readable file
  // and require readback/assert to reject invalid mode.
  writeJson(file, minimalReceipt(), 0o644);
  assert.equal(fileMode(file), 0o644);

  const result = receiptReadback(file);
  assertFailClosed(result, ReceiptFailureReason.RECEIPT_MODE_INVALID, 'mode 0600 gate');
});

test('RED-03.3 revision CAS rejects stale expected-revision', () => {
  const { receipts } = makeReceiptSandbox();
  const file = receiptPath(receipts);
  writeJson(file, minimalReceipt({ state: 'INIT', revision: 3 }));

  const result = receiptCas(file, {
    expectedRevision: 1,
    expectedState: 'INIT',
    state: 'RED_RECORDED',
    setJson: { note: 'stale' },
  });
  assertFailClosed(result, ReceiptFailureReason.RECEIPT_REVISION_CAS, 'stale revision');
});

test('RED-03.4 state CAS rejects unexpected current state', () => {
  const { receipts } = makeReceiptSandbox();
  const file = receiptPath(receipts);
  writeJson(file, minimalReceipt({ state: 'GREEN_RECORDED', revision: 2 }));

  const result = receiptCas(file, {
    expectedRevision: 2,
    expectedState: 'INIT',
    state: 'RED_RECORDED',
  });
  assertFailClosed(result, ReceiptFailureReason.RECEIPT_STATE_CAS, 'state CAS');
});

test('RED-03.5 only verify-done may set EffectiveDone=true', () => {
  const { receipts } = makeReceiptSandbox();
  const file = receiptPath(receipts);
  writeJson(file, minimalReceipt({ state: 'VERIFIED', revision: 4, EffectiveDone: false }));

  const viaCas = receiptCas(file, {
    expectedRevision: 4,
    expectedState: 'VERIFIED',
    state: 'DONE',
    setJson: { EffectiveDone: true },
  });
  assertFailClosed(
    viaCas,
    ReceiptFailureReason.ONLY_VERIFY_DONE_MAY_ENABLE_EFFECTIVE_DONE,
    'caller EffectiveDone via cas',
  );
});

test('RED-03.6 independent readback detects corruption / mismatch', () => {
  const { receipts } = makeReceiptSandbox();
  const file = receiptPath(receipts);
  writeJson(file, minimalReceipt({ state: 'INIT', revision: 1 }));

  // Corrupt payload after "write" — readback must not silently accept.
  fs.writeFileSync(file, '{not-json', { mode: 0o600 });

  const result = receiptReadback(file);
  assertFailClosed(result, ReceiptFailureReason.RECEIPT_CORRUPT, 'corrupt readback');
});

test('RED-03.7 IN_FLIGHT requires recovery readback before further mutation', () => {
  const { receipts } = makeReceiptSandbox();
  const file = receiptPath(receipts);
  writeJson(
    file,
    minimalReceipt({
      state: 'PUSH_IN_FLIGHT',
      revision: 5,
      resumeState: 'REQUIRED_ORIGINS_VERIFIED',
      EffectiveDone: false,
    }),
  );

  // Blind CAS while IN_FLIGHT without resume/readback is forbidden.
  const result = receiptCas(file, {
    expectedRevision: 5,
    expectedState: 'PUSH_IN_FLIGHT',
    state: 'DONE',
    setJson: { EffectiveDone: true },
  });
  assertFailClosed(
    result,
    ReceiptFailureReason.RECEIPT_IN_FLIGHT_RECOVERY_REQUIRED,
    'IN_FLIGHT blind cas',
  );
});

test('RED-03.8 attempts[] is append-only (no overwrite / delete of old attempts)', () => {
  const { receipts } = makeReceiptSandbox();
  const file = receiptPath(receipts);
  writeJson(
    file,
    minimalReceipt({
      state: 'EVIDENCE_ATTEMPT_OPEN',
      revision: 2,
      attempts: [
        {
          attemptNo: 1,
          attemptEpoch: 1,
          status: 'ATTEMPT_FAILED',
          leaseClosed: true,
        },
      ],
    }),
  );

  // Attempting to replace attempt 1 instead of appending must fail closed.
  const result = receiptAppendAttempt(file, {
    expectedRevision: 2,
    attemptJson: {
      attemptNo: 1,
      attemptEpoch: 1,
      status: 'EVIDENCE_ATTEMPT_OPEN',
      leaseClosed: false,
      overwrite: true,
    },
  });
  assertFailClosed(result, ReceiptFailureReason.ATTEMPT_APPEND_ONLY, 'append-only attempts');
});

test('RED-03.9 receipt path must stay inside the receipts sandbox root', () => {
  const { root, receipts } = makeReceiptSandbox();
  const escaped = path.join(root, '..', 'escape-receipt.json');

  const result = runRunner([
    'receipt-init',
    '--receipt',
    escaped,
    '--task',
    'WP-INFRA',
    '--require-contained',
    '--receipts-root',
    receipts,
  ]);
  assertFailClosed(result, ReceiptFailureReason.RECEIPT_PATH_ESCAPE, 'path escape');
});

test('RED-03.10 missing receipt cannot be cas/read without init', () => {
  const { receipts } = makeReceiptSandbox();
  const file = receiptPath(receipts, 'missing.json');
  assert.equal(fs.existsSync(file), false);

  const result = receiptCas(file, {
    expectedRevision: 1,
    expectedState: 'INIT',
    state: 'RED_RECORDED',
  });
  assertFailClosed(result, ReceiptFailureReason.MISSING_RECEIPT, 'missing receipt cas');
});

test('RED-03.11 resume after response-loss must readback before replaying mutation', () => {
  const { receipts } = makeReceiptSandbox();
  const file = receiptPath(receipts);
  writeJson(
    file,
    minimalReceipt({
      state: 'SYNC_IN_FLIGHT',
      revision: 7,
      resumeState: 'CHECKPOINT_COMMITTED',
      lastExternalOp: {
        kind: 'push',
        expectedSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        attempt: 1,
      },
    }),
  );

  // Resume without independent readback of remote/receipt identity must fail.
  const result = receiptResume(file);
  assertFailClosed(
    result,
    ReceiptFailureReason.RECEIPT_IN_FLIGHT_RECOVERY_REQUIRED,
    'resume without readback',
  );
});

test('RED-03.12 failures are machine-readable and never silently swallowed', () => {
  const { receipts } = makeReceiptSandbox();
  const file = receiptPath(receipts);
  writeJson(file, minimalReceipt({ state: 'INIT', revision: 1 }));

  const result = receiptCas(file, {
    expectedRevision: 99,
    expectedState: 'INIT',
    state: 'RED_RECORDED',
  });

  assert.notEqual(result.status, 0, 'silent success is forbidden');
  assert.ok(
    result.stdout.length + result.stderr.length > 0,
    'failure output must not be empty',
  );
  assert.match(
    result.combined,
    /"failureReason"\s*:\s*"[A-Z0-9_]+"|failureReason\s*[=:]\s*[A-Z0-9_]+|RECEIPT_REVISION_CAS|BLOCKED_[A-Z0-9_]+/,
    `expected machine-readable failure, got:\n${result.combined}`,
  );

  // Original receipt must remain intact after failed CAS (no partial clobber).
  const after = readJson(file);
  assert.equal(after.revision, 1);
  assert.equal(after.state, 'INIT');
});
