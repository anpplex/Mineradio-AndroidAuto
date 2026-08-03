'use strict';

/** WP-11A / RED-01 — recovery fault matrix capacity (weight 3, stay E5). */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  runnerPath,
  catalogPath,
  wp10cTxnReceipt,
  wp11aTxnReceipt,
  TASK_ID,
  EXPECTED_CURRENT_CORE_PROGRESS,
  EXPECTED_WEIGHT_FROM_PROGRESS_TABLE,
  EXPECTED_PROGRESS_WHEN_DONE,
  pathExists,
  readJson,
  loadWp11aCatalogEntry,
  assertRecoveryVerifierSurface,
  assertRecoveryFixturesPresent,
  assertEvaluateSurface,
  assertWp11aFullProductionCapacity,
  readWp10cDone,
} = require('./wallpaper-wp11a-red-helpers');

const {
  buildRecoveryFixture,
  verifyRecoveryEvidence,
  assertRecoveryFixtures,
  RECOVERY_MAX_MS,
} = require('../scripts/verify-wallpaper-plugin.js');

test('WP-11A RED: paths exist', () => {
  assert.equal(pathExists(runnerPath), true);
  assert.equal(pathExists(catalogPath), true);
  assert.equal(pathExists(wp10cTxnReceipt), true);
});

test('WP-11A RED: WP-10C EffectiveDone prerequisite', () => {
  assert.equal(readWp10cDone().ok, true);
});

test('WP-11A RED: catalog weight 3 E5', () => {
  const loaded = loadWp11aCatalogEntry();
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  assert.equal(loaded.entry.taskId, TASK_ID);
  assert.equal(loaded.entry.weight, EXPECTED_WEIGHT_FROM_PROGRESS_TABLE);
  assert.equal(loaded.entry.evidenceLevel, 'E5');
  assert.equal((loaded.entry.requiredEffectiveDone || []).includes('WP-10C'), true);
});

test('WP-11A RED: recovery verifier + fixtures', () => {
  assert.equal(assertRecoveryVerifierSurface().ok, true);
  assert.equal(assertRecoveryFixturesPresent().ok, true);
  assert.equal(assertRecoveryFixtures().ok, true);
  assert.equal(RECOVERY_MAX_MS, 10000);
  assert.equal(verifyRecoveryEvidence(buildRecoveryFixture('recoveryTooSlow')).ok, false);
  assert.equal(verifyRecoveryEvidence(buildRecoveryFixture('wrongCallerCertificate')).ok, false);
  assert.equal(
    verifyRecoveryEvidence(buildRecoveryFixture('packagePresenceDemandsIdle')).ok,
    false,
  );
  assert.equal(
    verifyRecoveryEvidence(buildRecoveryFixture('correctRecoveryMatrix')).ok,
    true,
  );
});

test('WP-11A RED: evaluate surface present', () => {
  assert.equal(assertEvaluateSurface().ok, true);
});

test('WP-11A RED: full production capacity', () => {
  const r = assertWp11aFullProductionCapacity();
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('WP-11A RED: progress table pins remain authoritative after DONE', () => {
  // Post-DONE hygiene: receipt may later be DONE@93; pins document RED-era expectations only.
  if (pathExists(wp11aTxnReceipt)) {
    const r = readJson(wp11aTxnReceipt);
    if (r.EffectiveDone === true) {
      assert.equal(r.state, 'DONE');
      assert.ok(r.verifyDone);
    } else {
      assert.notEqual(r.state, 'DONE');
    }
  }
  assert.equal(EXPECTED_CURRENT_CORE_PROGRESS, 90);
  assert.equal(EXPECTED_PROGRESS_WHEN_DONE, 93);
});
