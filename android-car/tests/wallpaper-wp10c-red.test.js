'use strict';

/** WP-10C / RED-01 — E5 system wallpaper binding capacity (weight 6). */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  runnerPath,
  catalogPath,
  wp10bTxnReceipt,
  wp10cTxnReceipt,
  TASK_ID,
  EXPECTED_CURRENT_CORE_PROGRESS,
  EXPECTED_WEIGHT_FROM_PROGRESS_TABLE,
  EXPECTED_PROGRESS_WHEN_DONE,
  pathExists,
  readJson,
  loadWp10cCatalogEntry,
  assertE5VerifierSurface,
  assertE5FixturesPresent,
  assertEvaluateSurface,
  assertWp10cFullProductionCapacity,
  readWp10bDone,
} = require('./wallpaper-wp10c-red-helpers');

const {
  buildE5Fixture,
  verifyE5Evidence,
  assertE5Fixtures,
} = require('../scripts/verify-wallpaper-plugin.js');

test('WP-10C RED: paths exist', () => {
  assert.equal(pathExists(runnerPath), true);
  assert.equal(pathExists(catalogPath), true);
  assert.equal(pathExists(wp10bTxnReceipt), true);
});

test('WP-10C RED: WP-10B EffectiveDone prerequisite', () => {
  assert.equal(readWp10bDone().ok, true);
});

test('WP-10C RED: catalog weight 6 E5', () => {
  const loaded = loadWp10cCatalogEntry();
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  assert.equal(loaded.entry.taskId, TASK_ID);
  assert.equal(loaded.entry.weight, EXPECTED_WEIGHT_FROM_PROGRESS_TABLE);
  assert.equal(loaded.entry.evidenceLevel, 'E5');
});

test('WP-10C RED: E5 verifier + fixtures', () => {
  assert.equal(assertE5VerifierSurface().ok, true);
  assert.equal(assertE5FixturesPresent().ok, true);
  assert.equal(assertE5Fixtures().ok, true);
  assert.equal(verifyE5Evidence(buildE5Fixture('wrongUser')).ok, false);
  assert.equal(verifyE5Evidence(buildE5Fixture('shellCallerOnly')).ok, false);
  assert.equal(verifyE5Evidence(buildE5Fixture('correctE5')).ok, true);
});

test('WP-10C RED: evaluate surface present', () => {
  assert.equal(assertEvaluateSurface().ok, true);
});

test('WP-10C RED: full production capacity', () => {
  const r = assertWp10cFullProductionCapacity();
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('WP-10C RED: not DONE; progress stays 84 until E5 sealed', () => {
  if (pathExists(wp10cTxnReceipt)) {
    const r = readJson(wp10cTxnReceipt);
    assert.notEqual(r.EffectiveDone, true);
  }
  assert.equal(EXPECTED_CURRENT_CORE_PROGRESS, 84);
  assert.equal(EXPECTED_PROGRESS_WHEN_DONE, 90);
});
