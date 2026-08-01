'use strict';

/**
 * WP-INFRA bootstrap / EffectiveGate contract tests.
 * Originally RED-04 fail-closed contracts; GREEN-04 implements the runner surface.
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BootstrapFailureReason,
  REQUIRED_BOOTSTRAP_FIELDS,
  ensureRunnerPresent,
  makeBootstrapSandbox,
  bootstrapReceiptPath,
  writeJson,
  fileMode,
  sha256File,
  minimalBootstrapReceipt,
  completePhaseEvents,
  runnerSrc,
  catalogSrc,
  schemaSrc,
  runRunner,
  bootstrapInit,
  bootstrapRecordSha,
  bootstrapRecordOrigin,
  bootstrapReadback,
  assertEffectiveGate,
  evaluateEffectiveGate,
  bootstrapClaimDone,
  bootstrapSyncInFlight,
  bootstrapSyncResume,
  assertFailClosed,
} = require('./wallpaper-task-bootstrap-helpers');

test('WP-INFRA RED-04: runner bootstrap surface is invokable (framework path)', () => {
  ensureRunnerPresent();
  const result = runRunner(['bootstrap-init', '--help-or-probe']);
  assert.equal(typeof result.status, 'number');
});

test('RED-04.1 bootstrap receipt init is exclusive-create / no-clobber', () => {
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  writeJson(file, minimalBootstrapReceipt());

  const result = bootstrapInit(file);
  assertFailClosed(result, BootstrapFailureReason.BOOTSTRAP_RECEIPT_EXISTS, 'no-clobber');
});

test('RED-04.2 bootstrap receipt must be mode 0600', () => {
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  writeJson(file, minimalBootstrapReceipt(), 0o644);
  assert.equal(fileMode(file), 0o644);

  const result = evaluateEffectiveGate(file);
  assertFailClosed(result, BootstrapFailureReason.BOOTSTRAP_MODE_INVALID, 'mode 0600');
});

test('RED-04.3 missing required bootstrap fields reject EffectiveGate', () => {
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  const incomplete = minimalBootstrapReceipt({
    // deliberately omit runner/catalog/schema SHAs and origin
    phaseEvents: completePhaseEvents(),
    INFRA_SHA: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });
  for (const field of ['runnerSha256', 'catalogSha256', 'schemaSha256', 'originReadback']) {
    assert.equal(incomplete[field], null, `fixture must leave ${field} null`);
  }
  writeJson(file, incomplete);

  const result = assertEffectiveGate(file, true);
  assertFailClosed(result, BootstrapFailureReason.BOOTSTRAP_MISSING_FIELD, 'missing fields');
});

test('RED-04.4 recorded blob SHA must match recomputed file digest', () => {
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  writeJson(
    file,
    minimalBootstrapReceipt({
      phaseEvents: completePhaseEvents(),
      INFRA_SHA: 'cccccccccccccccccccccccccccccccccccccccc',
      runnerSha256: '0'.repeat(64), // wrong on purpose
      catalogSha256: sha256File(catalogSrc),
      schemaSha256: sha256File(schemaSrc),
      originReadback: {
        ref: 'refs/heads/codex/wallpaper-plugin-infra',
        expectedSha: 'cccccccccccccccccccccccccccccccccccccccc',
        observedSha: 'cccccccccccccccccccccccccccccccccccccccc',
      },
    }),
  );

  const recompute = runRunner([
    'evaluate-effective-gate',
    '--receipt',
    file,
    '--recompute-paths',
    '--runner-path',
    runnerSrc,
    '--catalog-path',
    catalogSrc,
    '--schema-path',
    schemaSrc,
  ]);
  assertFailClosed(recompute, BootstrapFailureReason.BOOTSTRAP_SHA_MISMATCH, 'sha recompute');
});

test('RED-04.5 exact origin readback rejects local/remote SHA mismatch', () => {
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  const infra = 'dddddddddddddddddddddddddddddddddddddddd';
  writeJson(
    file,
    minimalBootstrapReceipt({
      phaseEvents: completePhaseEvents(),
      INFRA_SHA: infra,
      runnerSha256: sha256File(runnerSrc),
      catalogSha256: sha256File(catalogSrc),
      schemaSha256: sha256File(schemaSrc),
    }),
  );

  const result = bootstrapReadback(file, {
    infraSha: infra,
    remoteSha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  });
  assertFailClosed(result, BootstrapFailureReason.ORIGIN_SHA_MISMATCH, 'origin mismatch');
});

test('RED-04.6 incomplete phase ledger blocks EffectiveGate', () => {
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  const infra = 'ffffffffffffffffffffffffffffffffffffffff';
  writeJson(
    file,
    minimalBootstrapReceipt({
      phaseEvents: [
        { phase: 'RED', status: 'PASS' },
        { phase: 'GREEN', status: 'PASS' },
        // missing REFACTOR / VERIFY / COMMIT
      ],
      INFRA_SHA: infra,
      runnerSha256: sha256File(runnerSrc),
      catalogSha256: sha256File(catalogSrc),
      schemaSha256: sha256File(schemaSrc),
      originReadback: {
        ref: 'refs/heads/codex/wallpaper-plugin-infra',
        expectedSha: infra,
        observedSha: infra,
      },
    }),
  );

  const result = assertEffectiveGate(file, true);
  assertFailClosed(result, BootstrapFailureReason.PHASE_LEDGER_INCOMPLETE, 'phase ledger');
});

test('RED-04.7 surface EffectiveDone without origin readback is rejected', () => {
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  writeJson(
    file,
    minimalBootstrapReceipt({
      phaseEvents: completePhaseEvents(),
      INFRA_SHA: '1111111111111111111111111111111111111111',
      runnerSha256: sha256File(runnerSrc),
      catalogSha256: sha256File(catalogSrc),
      schemaSha256: sha256File(schemaSrc),
      originReadback: null,
      EffectiveDone: true, // forged
      EffectiveGate: true, // forged
    }),
  );

  const result = bootstrapClaimDone(file);
  assertFailClosed(
    result,
    BootstrapFailureReason.EFFECTIVE_GATE_CLAIM_REJECTED,
    'forged EffectiveDone',
  );
});

test('RED-04.8 SYNC_IN_FLIGHT requires recovery readback before further mutation', () => {
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  writeJson(
    file,
    minimalBootstrapReceipt({
      state: 'SYNC_IN_FLIGHT',
      revision: 3,
      resumeState: 'INFRA_REMOTE_VERIFIED',
      phaseEvents: completePhaseEvents(),
    }),
  );

  const resume = bootstrapSyncResume(file);
  assertFailClosed(
    resume,
    BootstrapFailureReason.SYNC_IN_FLIGHT_RECOVERY_REQUIRED,
    'sync resume without readback',
  );

  const beginAgain = bootstrapSyncInFlight(file, {
    expectedSha: '2222222222222222222222222222222222222222',
  });
  assertFailClosed(
    beginAgain,
    BootstrapFailureReason.SYNC_IN_FLIGHT_RECOVERY_REQUIRED,
    'sync begin while in-flight',
  );
});

test('RED-04.9 EffectiveGate is false when any required component is missing', () => {
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  const infra = '3333333333333333333333333333333333333333';
  writeJson(
    file,
    minimalBootstrapReceipt({
      phaseEvents: completePhaseEvents(),
      INFRA_SHA: infra,
      runnerSha256: sha256File(runnerSrc),
      catalogSha256: sha256File(catalogSrc),
      schemaSha256: sha256File(schemaSrc),
      // originReadback missing
      originReadback: null,
      EffectiveGate: false,
    }),
  );

  const result = assertEffectiveGate(file, false);
  // Gate must evaluate false (exit 0 with expected=false). Forcing true must
  // fail-closed with a specific reason for the missing component.
  assert.equal(result.status, 0, `expected false gate to assert cleanly:\n${result.combined}`);
  const forceTrue = assertEffectiveGate(file, true);
  assertFailClosed(
    forceTrue,
    BootstrapFailureReason.BOOTSTRAP_MISSING_FIELD,
    'force true with missing origin',
  );
});

test('RED-04.10 EffectiveGate true only when SHA + phases + bootstrap + origin all hold', () => {
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  const infra = '4444444444444444444444444444444444444444';
  // Almost complete but origin observed != expected → must NOT yield true.
  writeJson(
    file,
    minimalBootstrapReceipt({
      phaseEvents: completePhaseEvents(),
      INFRA_SHA: infra,
      runnerSha256: sha256File(runnerSrc),
      catalogSha256: sha256File(catalogSrc),
      schemaSha256: sha256File(schemaSrc),
      originReadback: {
        ref: 'refs/heads/codex/wallpaper-plugin-infra',
        expectedSha: infra,
        observedSha: '5555555555555555555555555555555555555555',
      },
    }),
  );

  const result = assertEffectiveGate(file, true);
  assertFailClosed(result, BootstrapFailureReason.ORIGIN_SHA_MISMATCH, 'almost complete');
});

test('RED-04.11 WP-00 cannot start while EffectiveGate is false', () => {
  const { bootstrap } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(bootstrap);
  writeJson(
    file,
    minimalBootstrapReceipt({
      EffectiveGate: false,
      EffectiveDone: false,
      phaseEvents: [],
    }),
  );

  const result = runRunner([
    'assert-ready',
    '--task',
    'WP-00',
    '--infra-effective-gate',
    'from-receipt',
    '--receipt',
    file,
  ]);
  // Catalog tool used EFFECTIVE_GATE_REQUIRED; bootstrap surface may reuse it
  // or EFFECTIVE_GATE_FALSE. Pin EFFECTIVE_GATE_FALSE for receipt-derived gate.
  assertFailClosed(result, BootstrapFailureReason.EFFECTIVE_GATE_FALSE, 'WP-00 blocked');
});

test('RED-04.12 bootstrap path containment and machine-readable failures', () => {
  const { root, bootstrap } = makeBootstrapSandbox();
  const escaped = path.join(root, '..', 'escape-bootstrap.json');

  const escapeResult = bootstrapInit(escaped, {
    requireContained: true,
    bootstrapRoot: bootstrap,
  });
  assertFailClosed(escapeResult, BootstrapFailureReason.BOOTSTRAP_PATH_ESCAPE, 'path escape');

  const { bootstrap: b2 } = makeBootstrapSandbox();
  const file = bootstrapReceiptPath(b2);
  writeJson(file, minimalBootstrapReceipt());
  const mismatch = bootstrapRecordOrigin(file, {
    expectedSha: '6666666666666666666666666666666666666666',
    observedSha: '7777777777777777777777777777777777777777',
  });
  assert.notEqual(mismatch.status, 0, 'silent success forbidden');
  assert.ok(mismatch.stdout.length + mismatch.stderr.length > 0, 'non-empty failure');
  assert.match(
    mismatch.combined,
    /"failureReason"\s*:\s*"[A-Z0-9_]+"|ORIGIN_SHA_MISMATCH|BOOTSTRAP_/,
    `machine-readable failure required, got:\n${mismatch.combined}`,
  );
});

test('RED-04.13 REQUIRED field list is frozen for bootstrap receipt schema', () => {
  // Structural documentation test: production evaluate must know these fields.
  for (const field of REQUIRED_BOOTSTRAP_FIELDS) {
    assert.equal(typeof field, 'string');
    assert.ok(field.length > 0);
  }
  assert.ok(REQUIRED_BOOTSTRAP_FIELDS.includes('runnerSha256'));
  assert.ok(REQUIRED_BOOTSTRAP_FIELDS.includes('catalogSha256'));
  assert.ok(REQUIRED_BOOTSTRAP_FIELDS.includes('schemaSha256'));
  assert.ok(REQUIRED_BOOTSTRAP_FIELDS.includes('originReadback'));
  assert.ok(REQUIRED_BOOTSTRAP_FIELDS.includes('EffectiveGate'));
});
