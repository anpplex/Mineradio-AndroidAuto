'use strict';

/**
 * Helpers for WP-INFRA RED-06 exact push + origin ls-remote contracts.
 * Uses production wallpaper-task.py only. Temp receipts only — does not
 * mutate the live verification/bootstrap/WP-INFRA.json from VERIFY-05.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const base = require('./wallpaper-task-bootstrap-ledger-helpers');

const ExactSyncFailureReason = Object.freeze({
  ...base.LedgerFailureReason,
  EXACT_PUSH_REQUIRED: 'EXACT_PUSH_REQUIRED',
  EXACT_PUSH_NOT_AUTHORIZED: 'EXACT_PUSH_NOT_AUTHORIZED',
  LS_REMOTE_REQUIRED: 'LS_REMOTE_REQUIRED',
  LS_REMOTE_MISMATCH: 'LS_REMOTE_MISMATCH',
  CALLER_INJECTED_REMOTE_SHA: 'CALLER_INJECTED_REMOTE_SHA',
  PUSH_IN_FLIGHT_RECOVERY_REQUIRED: 'PUSH_IN_FLIGHT_RECOVERY_REQUIRED',
  UNKNOWN_TASK: 'UNKNOWN_TASK',
});

function runExact(args, options = {}) {
  return base.runRunner(args, options);
}

/**
 * Populate a temp receipt to the post-ledger, pre-exact-push layer so RED-06
 * can isolate exact-sync gaps without going through full RED-04/05 setup.
 */
function seedPreExactSyncReceipt(file) {
  const infra = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  base.writeJson(
    file,
    base.red04CompleteReceipt({
      catalogTestReceipt: { pass: true, command: 'node --test catalog' },
      schemaTestReceipt: { pass: true, command: 'node --test schema' },
      exactSync: null,
      syncState: null,
      prMerge: null,
      baseContainment: null,
      INFRA_SHA: infra,
      originReadback: {
        ref: 'refs/heads/codex/wallpaper-plugin-infra',
        expectedSha: infra,
        observedSha: infra,
      },
      state: 'INFRA_REMOTE_VERIFIED',
    }),
  );
  return infra;
}

module.exports = {
  ...base,
  ExactSyncFailureReason,
  runExact,
  seedPreExactSyncReceipt,
};
