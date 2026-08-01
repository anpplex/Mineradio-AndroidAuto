'use strict';

/**
 * Helpers for WP-INFRA RED-10 blob SHA + test receipt + phase ledger gate contracts.
 * Production wallpaper-task.py only. Temp receipts only.
 */

const base = require('./wallpaper-task-bootstrap-ledger-helpers');

const BlobGateFailureReason = Object.freeze({
  ...base.LedgerFailureReason,
  BOOTSTRAP_MISSING_FIELD: 'BOOTSTRAP_MISSING_FIELD',
  BOOTSTRAP_SHA_MISMATCH: 'BOOTSTRAP_SHA_MISMATCH',
  MISSING_TEST_RECEIPT: 'MISSING_TEST_RECEIPT',
  CALLER_INJECTED_BLOB_SHA: 'CALLER_INJECTED_BLOB_SHA',
  CALLER_INJECTED_TEST_RECEIPT: 'CALLER_INJECTED_TEST_RECEIPT',
  PATH_REQUIRED: 'PATH_REQUIRED',
  PHASE_LEDGER_INCOMPLETE: 'PHASE_LEDGER_INCOMPLETE',
  PHASE_LEDGER_APPEND_ONLY: 'PHASE_LEDGER_APPEND_ONLY',
});

const FROZEN_RUNNER = base.runnerSrc;
const FROZEN_CATALOG = base.catalogSrc;
const FROZEN_SCHEMA = base.schemaSrc;

const INFRA_TIP = '2d57ddf9aa8d5d7887b0f3bf74b7cf095261171b';
const MERGE_SHA = 'ea2c9b82637558888ecf7a20d990b6007c93d82d';

/**
 * Receipt that is complete for later gate layers (exactSync/PR/base/phases)
 * so RED-10 can isolate blob SHA + test-receipt gaps.
 */
function nearGateReceipt(overrides = {}) {
  return base.red04CompleteReceipt({
    state: 'INFRA_AUTHORITATIVE_BASE_VERIFIED',
    INFRA_SHA: INFRA_TIP,
    originReadback: {
      ref: 'refs/heads/codex/wallpaper-plugin-infra',
      expectedSha: INFRA_TIP,
      observedSha: INFRA_TIP,
      source: 'git-ls-remote',
    },
    exactSync: {
      status: 'VERIFIED',
      expectedSha: INFRA_TIP,
      observedSha: INFRA_TIP,
      source: 'ls-remote',
    },
    prMerge: {
      merged: true,
      mergeSha: MERGE_SHA,
      source: 'gh-pr-api',
      prNumber: 2,
    },
    baseContainment: {
      containsMerge: true,
      baseSha: MERGE_SHA,
      mergeSha: MERGE_SHA,
      source: 'git-merge-base-is-ancestor',
    },
    catalogTestReceipt: { pass: true, command: 'forged-caller', source: 'caller' },
    schemaTestReceipt: { pass: true, command: 'forged-caller', source: 'caller' },
    runnerSha256: base.sha256File(FROZEN_RUNNER),
    catalogSha256: base.sha256File(FROZEN_CATALOG),
    schemaSha256: base.sha256File(FROZEN_SCHEMA),
    EffectiveDone: false,
    EffectiveGate: false,
    ...overrides,
  });
}

function runBlob(args, options = {}) {
  return base.runRunner(args, options);
}

function evaluateGate(receiptFile, options = {}) {
  const args = ['evaluate-effective-gate', '--receipt', receiptFile];
  if (options.recompute) {
    args.push(
      '--recompute-paths',
      '--runner-path',
      FROZEN_RUNNER,
      '--catalog-path',
      FROZEN_CATALOG,
      '--schema-path',
      FROZEN_SCHEMA,
    );
  }
  return runBlob(args);
}

function assertGate(receiptFile, expected) {
  return base.assertEffectiveGate(receiptFile, expected);
}

module.exports = {
  ...base,
  BlobGateFailureReason,
  FROZEN_RUNNER,
  FROZEN_CATALOG,
  FROZEN_SCHEMA,
  INFRA_TIP,
  MERGE_SHA,
  nearGateReceipt,
  runBlob,
  evaluateGate,
  assertGate,
};
