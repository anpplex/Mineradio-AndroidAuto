'use strict';

/**
 * WP-INFRA bootstrap ledger contracts (canonical receipt + EffectiveGate layers).
 * Originally RED-05 fail-closed tests; GREEN-05 implements the production surface.
 *
 * Calls production `wallpaper-task.py` only. Temp isolation; no production leftovers.
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
  fileMode,
  runRunner,
  bootstrapInit,
  bootstrapRecordSha,
  bootstrapRecordPhase,
  bootstrapReadback,
  assertEffectiveGate,
  evaluateEffectiveGate,
  bootstrapClaimDone,
  bootstrapSyncInFlight,
  bootstrapSyncResume,
  runnerSrc,
  catalogSrc,
  schemaSrc,
  LedgerFailureReason,
  CANONICAL_BOOTSTRAP_RECEIPT,
  cleanupCanonicalBootstrapArtifacts,
  red04CompleteReceipt,
  assertFailClosed,
  assertProductionFailed,
  sha256File,
} = require('./wallpaper-task-bootstrap-ledger-helpers');

test.afterEach(() => {
  cleanupCanonicalBootstrapArtifacts();
});

test('WP-INFRA RED-05: production runner is invokable (framework path)', () => {
  ensureRunnerPresent();
  const result = runRunner(['bootstrap-init', '--help-or-probe']);
  assert.equal(typeof result.status, 'number');
});

test('RED-05.1 bootstrap-init must write the canonical verification path', () => {
  cleanupCanonicalBootstrapArtifacts();
  // Production must support canonical bootstrap without a free-form --receipt.
  const result = runRunner([
    'bootstrap-init',
    '--task',
    'WP-INFRA',
    '--use-canonical-bootstrap',
  ]);
  try {
    assert.equal(
      result.status,
      0,
      `canonical bootstrap-init must succeed\n${result.stdout}\n${result.stderr}`,
    );
    assert.equal(
      fs.existsSync(CANONICAL_BOOTSTRAP_RECEIPT),
      true,
      `expected receipt at ${CANONICAL_BOOTSTRAP_RECEIPT}`,
    );
    const data = readJson(CANONICAL_BOOTSTRAP_RECEIPT);
    assert.equal(data.taskId, 'WP-INFRA');
  } finally {
    cleanupCanonicalBootstrapArtifacts();
  }
});

test('RED-05.2 receipt must carry canonical transaction identity', () => {
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  const init = bootstrapInit(file);
  assert.equal(init.status, 0, init.combined);
  const data = readJson(file);
  // GREEN-05 must mint and freeze identity (not caller-supplied).
  assert.equal(typeof data.transactionId, 'string', 'missing transactionId');
  assert.match(data.transactionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(typeof data.runUuid, 'string', 'missing runUuid');
  assert.match(data.runUuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.notEqual(data.transactionId, data.runUuid);
});

test('RED-05.3 receipt must record runner SHA (and reject missing runner SHA for gate)', () => {
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  writeJson(
    file,
    red04CompleteReceipt({
      runnerSha256: null,
    }),
  );
  const result = assertEffectiveGate(file, true);
  assertFailClosed(result, LedgerFailureReason.BOOTSTRAP_MISSING_FIELD, 'runner SHA required');
  assert.match(result.combined, /runnerSha256/);
});

test('RED-05.4 receipt must record catalog/schema test receipts (not only file digests)', () => {
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  // File digests alone are insufficient for EffectiveGate under RED-05.
  writeJson(file, red04CompleteReceipt());
  const result = assertEffectiveGate(file, true);
  // Must fail until catalogTestReceipt + schemaTestReceipt (+ runner tests) freeze.
  assertProductionFailed(
    result,
    'RED-05.4',
    'Expected fail-closed without catalog/schema test receipts',
  );
  assert.match(
    result.combined,
    /MISSING_TEST_RECEIPT|catalogTestReceipt|schemaTestReceipt|test receipt/i,
  );
});

test('RED-05.5 receipt must record exact-SHA sync state', () => {
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  writeJson(
    file,
    red04CompleteReceipt({
      catalogTestReceipt: { pass: true, command: 'node --test catalog' },
      schemaTestReceipt: { pass: true, command: 'node --test schema' },
      // origin readback present but no durable exactSync ledger
      exactSync: null,
      syncState: null,
    }),
  );
  const result = assertEffectiveGate(file, true);
  assertProductionFailed(
    result,
    'RED-05.5',
    'Expected fail-closed without exactSync/exact-SHA sync state',
  );
  assert.match(result.combined, /MISSING_EXACT_SYNC_STATE|exactSync|SYNC_/);
});

test('RED-05.6 receipt must expose a complete phase ledger structure', () => {
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  assert.equal(bootstrapInit(file).status, 0);
  for (const phase of ['RED', 'GREEN', 'REFACTOR', 'VERIFY', 'COMMIT']) {
    const r = bootstrapRecordPhase(file, phase, 'PASS');
    assert.equal(r.status, 0, r.combined);
  }
  const data = readJson(file);
  assert.ok(Array.isArray(data.phaseEvents));
  assert.equal(data.phaseEvents.length, 5);
  // Each event must be durable ledger entries with identity (GREEN-05).
  for (const event of data.phaseEvents) {
    assert.equal(typeof event.phase, 'string');
    assert.equal(typeof event.status, 'string');
    assert.equal(
      typeof event.phaseAttemptId,
      'string',
      'phaseAttemptId required on ledger events',
    );
    assert.equal(typeof event.completedAt, 'string', 'completedAt required');
  }
});

test('RED-05.7 receipt initial state must be incomplete (not DONE / not EffectiveGate)', () => {
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  assert.equal(bootstrapInit(file).status, 0);
  const data = readJson(file);
  assert.notEqual(data.state, 'DONE');
  assert.equal(data.EffectiveDone, false);
  assert.equal(data.EffectiveGate, false);
});

test('RED-05.8 missing origin exact readback keeps EffectiveGate false', () => {
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  writeJson(file, red04CompleteReceipt({ originReadback: null }));
  const result = assertEffectiveGate(file, true);
  assertFailClosed(result, LedgerFailureReason.BOOTSTRAP_MISSING_FIELD, 'origin required');
});

test('RED-05.9 missing PR merge / base containment keeps EffectiveGate false', () => {
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  // RED-04-complete receipt currently yields EffectiveGate=true — RED-05 forbids that
  // without prMerge + baseContainment evidence.
  const infra = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  writeJson(
    file,
    red04CompleteReceipt({
      catalogTestReceipt: { pass: true, command: 'node --test catalog' },
      schemaTestReceipt: { pass: true, command: 'node --test schema' },
      exactSync: {
        status: 'VERIFIED',
        expectedSha: infra,
        observedSha: infra,
      },
      prMerge: null,
      baseContainment: null,
      infraPr: null,
    }),
  );
  const result = assertEffectiveGate(file, true);
  assertProductionFailed(
    result,
    'RED-05.9',
    'Expected fail-closed without PR merge / base containment',
  );
  assert.match(
    result.combined,
    /PR_MERGE_REQUIRED|BASE_CONTAINMENT_REQUIRED|prMerge|baseContainment|mergeSha/i,
  );
});

test('RED-05.10 caller cannot inject EffectiveGate=true', () => {
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  writeJson(
    file,
    red04CompleteReceipt({
      EffectiveGate: true,
      EffectiveDone: true,
      state: 'DONE',
      prMerge: null,
      baseContainment: null,
    }),
  );
  const claim = bootstrapClaimDone(file);
  assertProductionFailed(
    claim,
    'RED-05.10 claim',
    'forged EffectiveGate/Done must not claim-done',
  );
  const force = assertEffectiveGate(file, true);
  assertProductionFailed(
    force,
    'RED-05.10 assert',
    'forged EffectiveGate must not evaluate true without full gate',
  );
});

test('RED-05.11 exclusive-create / no-clobber on real writer', () => {
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  writeJson(file, red04CompleteReceipt({ state: 'INIT', revision: 1 }));
  const result = bootstrapInit(file);
  assertFailClosed(result, LedgerFailureReason.BOOTSTRAP_RECEIPT_EXISTS, 'no-clobber');
});

test('RED-05.12 existing receipt must not be silently overwritten', () => {
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  const original = red04CompleteReceipt({
    state: 'INFRA_REMOTE_VERIFIED',
    revision: 9,
    note: 'do-not-clobber',
  });
  writeJson(file, original);
  const result = bootstrapInit(file);
  assert.notEqual(result.status, 0);
  const after = readJson(file);
  assert.equal(after.revision, 9);
  assert.equal(after.note, 'do-not-clobber');
  assert.equal(after.state, 'INFRA_REMOTE_VERIFIED');
});

test('RED-05.13 mode 0600 + atomic write constraints on real init', () => {
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  assert.equal(bootstrapInit(file).status, 0);
  assert.equal(fileMode(file), 0o600);
  // No leftover temp siblings from atomic replace.
  const temps = fs.readdirSync(bootstrap).filter((n) => n.startsWith('.WP-INFRA.json.'));
  assert.equal(temps.length, 0, `leftover atomic temps: ${temps.join(',')}`);
  // Lock file may exist but must not replace receipt content.
  assert.equal(fs.existsSync(file), true);
});

test('RED-05.14 response-loss recovery must detect whether receipt write completed', () => {
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  assert.equal(bootstrapInit(file).status, 0);

  // Begin sync then "lose" the response — resume without readback must fail.
  const begin = bootstrapSyncInFlight(file, {
    expectedSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });
  assert.equal(begin.status, 0, begin.combined);
  const resume = bootstrapSyncResume(file);
  assertFailClosed(
    resume,
    LedgerFailureReason.SYNC_IN_FLIGHT_RECOVERY_REQUIRED,
    'resume without readback',
  );

  // Durable readback probe: bootstrap-write-status must report written=true.
  const status = runRunner(['bootstrap-write-status', '--receipt', file]);
  assert.equal(
    status.status,
    0,
    `bootstrap-write-status must exist and succeed\n${status.combined}`,
  );
  assert.match(status.combined, /"written"\s*:\s*true/);
});

test('RED-05.15 phase ledger is append-only (no history wipe)', () => {
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  assert.equal(bootstrapInit(file).status, 0);
  assert.equal(bootstrapRecordPhase(file, 'RED', 'PASS').status, 0);
  assert.equal(bootstrapRecordPhase(file, 'GREEN', 'PASS').status, 0);
  const before = readJson(file).phaseEvents.length;
  assert.ok(before >= 2);

  // Any API that would replace/truncate the ledger must fail-closed.
  const wipe = runRunner([
    'bootstrap-record-phase',
    '--receipt',
    file,
    '--phase',
    'RED',
    '--status',
    'PASS',
    '--replace-ledger',
  ]);
  assertFailClosed(wipe, LedgerFailureReason.PHASE_LEDGER_APPEND_ONLY, 'replace-ledger');

  const after = readJson(file);
  assert.equal(after.phaseEvents.length, before, 'ledger history must be preserved');
});

test('RED-05.16 invalid fields / SHA / state fail-closed', () => {
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  assert.equal(bootstrapInit(file).status, 0);

  const badSha = bootstrapRecordSha(file, 'runner', 'not-hex');
  assert.notEqual(badSha.status, 0);
  assert.match(badSha.combined, /BOOTSTRAP_SHA_MISMATCH|INVALID_SHA|sha256/i);

  writeJson(
    file,
    red04CompleteReceipt({
      state: 'NOT_A_REAL_STATE',
      revision: 2,
    }),
  );
  const badState = evaluateEffectiveGate(file);
  // Illegal runtime/bootstrap state must not silently evaluate green.
  assertProductionFailed(badState, 'RED-05.16 illegal state');

  const missing = assertEffectiveGate(
    (() => {
      const f = bootstrapReceiptPath(bootstrap, 'missing-fields.json');
      writeJson(f, { schema: 'wallpaper-infra-bootstrap/v1', taskId: 'WP-INFRA' });
      return f;
    })(),
    true,
  );
  assert.notEqual(missing.status, 0);
  assert.match(missing.combined, /BOOTSTRAP_MISSING_FIELD|failureReason/);
});

test('RED-05.17 red04-complete receipt alone must NOT claim EffectiveGate under RED-05', () => {
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  writeJson(file, red04CompleteReceipt());
  // Explicit contract: GREEN-04 completeness is insufficient for WP-INFRA EffectiveGate.
  const gate = assertEffectiveGate(file, true);
  assertProductionFailed(
    gate,
    'RED-05.17',
    'EffectiveGate requires test receipts + exactSync + PR merge/base containment',
  );
});
