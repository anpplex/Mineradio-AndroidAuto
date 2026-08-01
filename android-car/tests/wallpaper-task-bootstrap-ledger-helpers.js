'use strict';

/**
 * Helpers for WP-INFRA bootstrap ledger contracts (RED-05 / GREEN-05).
 * Calls production wallpaper-task.py only; uses temp trees; never leaves
 * production bootstrap artifacts.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const base = require('./wallpaper-task-bootstrap-helpers');

const CANONICAL_BOOTSTRAP_DIR = path.join(
  base.repoRoot,
  'android-car',
  'verification',
  'wallpaper-plugin',
  'bootstrap',
);
const CANONICAL_BOOTSTRAP_RECEIPT = path.join(CANONICAL_BOOTSTRAP_DIR, 'WP-INFRA.json');
const CANONICAL_BOOTSTRAP_LOCK = `${CANONICAL_BOOTSTRAP_RECEIPT}.lock`;

const LedgerFailureReason = Object.freeze({
  ...base.BootstrapFailureReason,
  CANONICAL_PATH_REQUIRED: 'CANONICAL_PATH_REQUIRED',
  MISSING_TRANSACTION_IDENTITY: 'MISSING_TRANSACTION_IDENTITY',
  MISSING_RUNNER_SHA: 'MISSING_RUNNER_SHA',
  MISSING_TEST_RECEIPT: 'MISSING_TEST_RECEIPT',
  MISSING_EXACT_SYNC_STATE: 'MISSING_EXACT_SYNC_STATE',
  PR_MERGE_REQUIRED: 'PR_MERGE_REQUIRED',
  BASE_CONTAINMENT_REQUIRED: 'BASE_CONTAINMENT_REQUIRED',
  PHASE_LEDGER_APPEND_ONLY: 'PHASE_LEDGER_APPEND_ONLY',
  BOOTSTRAP_WRITE_INCOMPLETE: 'BOOTSTRAP_WRITE_INCOMPLETE',
  INVALID_SHA_FORMAT: 'INVALID_SHA_FORMAT',
  ILLEGAL_BOOTSTRAP_STATE: 'ILLEGAL_BOOTSTRAP_STATE',
});

function cleanupCanonicalBootstrapArtifacts() {
  for (const p of [CANONICAL_BOOTSTRAP_RECEIPT, CANONICAL_BOOTSTRAP_LOCK]) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      // best-effort cleanup only
    }
  }
  // remove stray temp files from interrupted atomic writes
  if (fs.existsSync(CANONICAL_BOOTSTRAP_DIR)) {
    for (const name of fs.readdirSync(CANONICAL_BOOTSTRAP_DIR)) {
      if (name.startsWith('.WP-INFRA.json.')) {
        try {
          fs.unlinkSync(path.join(CANONICAL_BOOTSTRAP_DIR, name));
        } catch {
          // ignore
        }
      }
    }
  }
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * RED-04-complete fields that today's evaluate-effective-gate treats as enough
 * for EffectiveGate=true. RED-05 requires additional PR/base/sync/test receipts.
 */
function red04CompleteReceipt(overrides = {}) {
  const infra = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  return base.minimalBootstrapReceipt({
    state: 'INFRA_REMOTE_VERIFIED',
    revision: 5,
    phaseEvents: base.completePhaseEvents(),
    INFRA_SHA: infra,
    runnerSha256: sha256File(base.runnerSrc),
    catalogSha256: sha256File(base.catalogSrc),
    schemaSha256: sha256File(base.schemaSrc),
    originReadback: {
      ref: 'refs/heads/codex/wallpaper-plugin-infra',
      expectedSha: infra,
      observedSha: infra,
    },
    EffectiveDone: false,
    EffectiveGate: false,
    ...overrides,
  });
}

function assertFailClosed(result, expectedReason, label = '') {
  return base.assertFailClosed(result, expectedReason, label);
}

function assertProductionFailed(result, label, hint = '') {
  if (result.status === 0) {
    throw new Error(
      `${label}: expected production bootstrap/ledger surface to fail-closed ` +
        `(implementation gap).\n${hint}\n` +
        `stdout=${JSON.stringify(result.stdout)}\n` +
        `stderr=${JSON.stringify(result.stderr)}`,
    );
  }
}

module.exports = {
  ...base,
  LedgerFailureReason,
  CANONICAL_BOOTSTRAP_DIR,
  CANONICAL_BOOTSTRAP_RECEIPT,
  CANONICAL_BOOTSTRAP_LOCK,
  cleanupCanonicalBootstrapArtifacts,
  sha256File,
  red04CompleteReceipt,
  assertFailClosed,
  assertProductionFailed,
};
