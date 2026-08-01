'use strict';

/**
 * WP-INFRA / RED-10 — blob SHA freeze, authentic test receipts, phase ledger
 * completeness for EffectiveGate.
 *
 * Production wallpaper-task.py only. Temp receipts. No push / PR / device.
 *
 * Under HEAD 77fce52 these tests document remaining gate gaps and must FAIL
 * until GREEN-10 closes them (except cases already fail-closed).
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ensureRunnerPresent,
  makeBootstrapSandbox,
  bootstrapReceiptPath,
  writeJson,
  readJson,
  runBlob,
  evaluateGate,
  assertGate,
  nearGateReceipt,
  bootstrapInit,
  bootstrapRecordSha,
  bootstrapRecordPhase,
  sha256File,
  FROZEN_RUNNER,
  FROZEN_CATALOG,
  FROZEN_SCHEMA,
  BlobGateFailureReason,
  assertProductionFailed,
  assertFailClosed,
} = require('./wallpaper-task-blob-gate-helpers');

const FAKE_SHA = 'a'.repeat(64);
const FAKE_SHA_B = 'b'.repeat(64);
const FAKE_SHA_C = 'c'.repeat(64);

function sandboxNearGate(overrides = {}) {
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  writeJson(file, nearGateReceipt(overrides));
  return file;
}

// ---------------------------------------------------------------------------
// Framework
// ---------------------------------------------------------------------------

test('WP-INFRA RED-10: production runner invokable (framework path)', () => {
  ensureRunnerPresent();
  const result = runBlob(['evaluate-effective-gate', '--help-or-probe']);
  assert.equal(typeof result.status, 'number');
});

test('RED-10.0 frozen implementation files exist for SHA binding', () => {
  assert.equal(fs.existsSync(FROZEN_RUNNER), true);
  assert.equal(fs.existsSync(FROZEN_CATALOG), true);
  assert.equal(fs.existsSync(FROZEN_SCHEMA), true);
  assert.match(sha256File(FROZEN_RUNNER), /^[0-9a-f]{64}$/);
  assert.match(sha256File(FROZEN_CATALOG), /^[0-9a-f]{64}$/);
  assert.match(sha256File(FROZEN_SCHEMA), /^[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------------------
// 1–4. Blob SHA must come from actual frozen files
// ---------------------------------------------------------------------------

test('RED-10.1 bootstrap-record-sha must require --path (no caller-only sha256)', () => {
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  assert.equal(bootstrapInit(file).status, 0);
  // Caller invents a digest without binding to runner file.
  const result = runBlob([
    'bootstrap-record-sha',
    '--receipt',
    file,
    '--kind',
    'runner',
    '--sha256',
    FAKE_SHA,
    // deliberately no --path
  ]);
  assertProductionFailed(
    result,
    'RED-10.1',
    'record-sha without --path must fail-closed (caller-only blob SHA)',
  );
  assert.match(
    result.combined,
    /PATH_REQUIRED|CALLER_INJECTED_BLOB_SHA|BOOTSTRAP_SHA_MISMATCH|--path|file digest/i,
  );
  assert.equal(readJson(file).runnerSha256, null);
});

test('RED-10.2 bootstrap-record-sha must bind runner/catalog/schema to frozen file digests', () => {
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  assert.equal(bootstrapInit(file).status, 0);

  const cases = [
    ['runner', FROZEN_RUNNER],
    ['catalog', FROZEN_CATALOG],
    ['schema', FROZEN_SCHEMA],
  ];
  for (const [kind, filePath] of cases) {
    const wrong = runBlob([
      'bootstrap-record-sha',
      '--receipt',
      file,
      '--kind',
      kind,
      '--sha256',
      FAKE_SHA,
      '--path',
      filePath,
    ]);
    assertFailClosed(
      wrong,
      BlobGateFailureReason.BOOTSTRAP_SHA_MISMATCH,
      `RED-10.2 ${kind} mismatch`,
    );

    const actual = sha256File(filePath);
    const ok = runBlob([
      'bootstrap-record-sha',
      '--receipt',
      file,
      '--kind',
      kind,
      '--sha256',
      actual,
      '--path',
      filePath,
    ]);
    assert.equal(ok.status, 0, `RED-10.2 ${kind} match must succeed\n${ok.combined}`);
  }
  const data = readJson(file);
  assert.equal(data.runnerSha256, sha256File(FROZEN_RUNNER));
  assert.equal(data.catalogSha256, sha256File(FROZEN_CATALOG));
  assert.equal(data.schemaSha256, sha256File(FROZEN_SCHEMA));
});

test('RED-10.3 evaluate-effective-gate must reject fake blob SHAs without trusting writeJson', () => {
  const file = sandboxNearGate({
    runnerSha256: FAKE_SHA,
    catalogSha256: FAKE_SHA_B,
    schemaSha256: FAKE_SHA_C,
  });
  // GREEN-10: gate must recompute against frozen paths by default (or hard-require recompute).
  const result = evaluateGate(file, { recompute: false });
  // Must not evaluate EffectiveGate=true for invented digests.
  if (result.status === 0) {
    const body = result.stdout + result.stderr;
    assert.doesNotMatch(
      body,
      /"EffectiveGate"\s*:\s*true/,
      'RED-10.3 forged blob SHAs must not yield EffectiveGate=true',
    );
    // If status 0 with gate false, also acceptable only if failureReason present — prefer hard fail.
    assert.match(body, /EffectiveGate":false|BOOTSTRAP_SHA_MISMATCH|failureReason/i);
  } else {
    assertProductionFailed(result, 'RED-10.3', 'forged blob SHAs');
    assert.match(
      result.combined,
      /BOOTSTRAP_SHA_MISMATCH|CALLER_INJECTED_BLOB_SHA|recompute|SHA/i,
    );
  }
});

test('RED-10.4 evaluate-effective-gate with --recompute-paths must match frozen files', () => {
  const file = sandboxNearGate({
    runnerSha256: FAKE_SHA,
    catalogSha256: sha256File(FROZEN_CATALOG),
    schemaSha256: sha256File(FROZEN_SCHEMA),
  });
  const result = evaluateGate(file, { recompute: true });
  assertProductionFailed(result, 'RED-10.4 recompute', 'runner sha must mismatch file');
  assert.match(result.combined, /BOOTSTRAP_SHA_MISMATCH|runner/i);
});

// ---------------------------------------------------------------------------
// 5 / 9. Test receipts must not be caller-forged pass:true
// ---------------------------------------------------------------------------

test('RED-10.5 caller-forged catalog/schema test receipts must not unlock EffectiveGate', () => {
  // nearGateReceipt already uses source:caller forged pass:true + real blob SHAs.
  const file = sandboxNearGate();
  const result = evaluateGate(file, { recompute: true });
  // Even with correct file digests, forged test receipts must fail-closed.
  if (result.status === 0) {
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /"EffectiveGate"\s*:\s*true/,
      'RED-10.5 forged test receipts must not yield EffectiveGate=true',
    );
  }
  assertProductionFailed(
    result,
    'RED-10.5',
    'test receipts must come from authentic node --test runs, not caller pass:true',
  );
  assert.match(
    result.combined,
    /CALLER_INJECTED_TEST_RECEIPT|MISSING_TEST_RECEIPT|TEST_RECEIPT|provenance|source/i,
  );
});

test('RED-10.6 bootstrap-record-test-receipt surface must exist and reject caller-only pass', () => {
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  writeJson(file, nearGateReceipt({ catalogTestReceipt: null, schemaTestReceipt: null }));
  const result = runBlob([
    'bootstrap-record-test-receipt',
    '--receipt',
    file,
    '--kind',
    'catalog',
    '--pass',
    'true',
    '--command',
    'forged',
  ]);
  // GREEN-10 must implement authentic recorder; until then unknown command or reject inject.
  assertProductionFailed(result, 'RED-10.6', 'no caller-only test receipt inject');
  assert.match(
    result.combined,
    /CALLER_INJECTED_TEST_RECEIPT|UNKNOWN_TASK|bootstrap-record-test-receipt|not authorized|missing/i,
  );
});

// ---------------------------------------------------------------------------
// 6–7. Phase ledger append-only + incomplete keeps gate false
// ---------------------------------------------------------------------------

test('RED-10.7 phase ledger is append-only (replace forbidden)', () => {
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  assert.equal(bootstrapInit(file).status, 0);
  assert.equal(bootstrapRecordPhase(file, 'RED', 'PASS').status, 0);
  const result = runBlob([
    'bootstrap-record-phase',
    '--receipt',
    file,
    '--phase',
    'GREEN',
    '--status',
    'PASS',
    '--replace-ledger',
  ]);
  assertFailClosed(
    result,
    BlobGateFailureReason.PHASE_LEDGER_APPEND_ONLY,
    'RED-10.7 replace-ledger',
  );
  assert.equal(readJson(file).phaseEvents.length, 1);
});

test('RED-10.8 incomplete phase ledger keeps EffectiveGate false', () => {
  const file = sandboxNearGate({
    phaseEvents: [
      { phase: 'RED', status: 'PASS' },
      { phase: 'GREEN', status: 'PASS' },
      // missing REFACTOR/VERIFY/COMMIT
    ],
  });
  const result = assertGate(file, true);
  assertProductionFailed(result, 'RED-10.8', 'incomplete ledger');
  assert.match(result.combined, /PHASE_LEDGER_INCOMPLETE|phase/i);
  assert.equal(readJson(file).EffectiveGate, false);
});

// ---------------------------------------------------------------------------
// 8. Missing blob SHA / test receipt → BOOTSTRAP_MISSING_FIELD (or documented reason)
// ---------------------------------------------------------------------------

test('RED-10.9 missing runnerSha256 returns BOOTSTRAP_MISSING_FIELD', () => {
  const file = sandboxNearGate({ runnerSha256: null });
  const result = assertGate(file, true);
  assertFailClosed(
    result,
    BlobGateFailureReason.BOOTSTRAP_MISSING_FIELD,
    'RED-10.9 missing runner',
  );
});

test('RED-10.10 missing catalogSha256 returns BOOTSTRAP_MISSING_FIELD', () => {
  const file = sandboxNearGate({ catalogSha256: null });
  const result = assertGate(file, true);
  assertFailClosed(
    result,
    BlobGateFailureReason.BOOTSTRAP_MISSING_FIELD,
    'RED-10.10 missing catalog',
  );
});

test('RED-10.11 missing schemaSha256 returns BOOTSTRAP_MISSING_FIELD', () => {
  const file = sandboxNearGate({ schemaSha256: null });
  const result = assertGate(file, true);
  assertFailClosed(
    result,
    BlobGateFailureReason.BOOTSTRAP_MISSING_FIELD,
    'RED-10.11 missing schema',
  );
});

test('RED-10.12 missing test receipts must fail field-level (BOOTSTRAP_MISSING_FIELD preferred)', () => {
  const file = sandboxNearGate({
    catalogTestReceipt: null,
    schemaTestReceipt: null,
  });
  const result = assertGate(file, true);
  assertProductionFailed(result, 'RED-10.12 missing test receipts');
  // GREEN-10 should unify on BOOTSTRAP_MISSING_FIELD; today may be MISSING_TEST_RECEIPT.
  assert.match(
    result.combined,
    /BOOTSTRAP_MISSING_FIELD|MISSING_TEST_RECEIPT/,
  );
  // Prefer BOOTSTRAP_MISSING_FIELD as the stable contract for RED-10 item 8.
  if (!/"failureReason"\s*:\s*"BOOTSTRAP_MISSING_FIELD"/.test(result.combined)) {
    assert.fail(
      'RED-10.12: missing test receipts must use failureReason BOOTSTRAP_MISSING_FIELD\n' +
        result.combined,
    );
  }
});

// ---------------------------------------------------------------------------
// 9. Caller cannot overwrite frozen blob SHAs via record without path proof
// ---------------------------------------------------------------------------

test('RED-10.13 caller cannot overwrite runnerSha256 with unmatched digest', () => {
  const file = sandboxNearGate();
  const before = readJson(file).runnerSha256;
  const result = runBlob([
    'bootstrap-record-sha',
    '--receipt',
    file,
    '--kind',
    'runner',
    '--sha256',
    FAKE_SHA,
    // no --path: must not clobber
  ]);
  assertProductionFailed(result, 'RED-10.13 overwrite', 'no path inject');
  assert.equal(readJson(file).runnerSha256, before);
});

// ---------------------------------------------------------------------------
// 10. EffectiveGate only when ALL layers authentic (still false under RED-10 gaps)
// ---------------------------------------------------------------------------

test('RED-10.14 evaluate-effective-gate stays false for near-complete forged test layer', () => {
  const file = sandboxNearGate();
  const evalResult = evaluateGate(file, { recompute: true });
  // With real blob digests + forged test receipts, GREEN-10 must keep gate false.
  if (evalResult.status === 0) {
    assert.match(evalResult.combined, /"EffectiveGate"\s*:\s*false/);
  } else {
    assertProductionFailed(evalResult, 'RED-10.14', 'gate not fully closed');
  }
  const assertTrue = assertGate(file, true);
  assertProductionFailed(assertTrue, 'RED-10.14 assert true');
  assert.equal(readJson(file).EffectiveGate, false);
  assert.equal(readJson(file).EffectiveDone, false);
});

test('RED-10.15 WP-INFRA remains IN_PROGRESS semantics (no claim-done)', () => {
  const file = sandboxNearGate();
  const claim = runBlob(['bootstrap-claim-done', '--receipt', file]);
  assertProductionFailed(claim, 'RED-10.15 claim-done');
  assert.notEqual(readJson(file).state, 'DONE');
  assert.equal(readJson(file).EffectiveGate, false);
});
