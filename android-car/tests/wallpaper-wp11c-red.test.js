'use strict';

/** WP-11C / RED-01 — E7 reboot/ACC/2h capacity (weight 4). */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  runnerPath,
  catalogPath,
  wp11bTxnReceipt,
  wp11cTxnReceipt,
  TASK_ID,
  EXPECTED_CURRENT_CORE_PROGRESS,
  EXPECTED_WEIGHT_FROM_PROGRESS_TABLE,
  EXPECTED_PROGRESS_WHEN_DONE,
  pathExists,
  readJson,
  loadWp11cCatalogEntry,
  assertE7VerifierSurface,
  assertE7FixturesPresent,
  assertEvaluateSurface,
  assertWp11cFullProductionCapacity,
  readWp11bDone,
} = require('./wallpaper-wp11c-red-helpers');

const {
  buildE7Fixture,
  verifyE7Evidence,
  assertE7Fixtures,
  E7_DURATION_MS,
  E7_SAMPLE_COUNT,
  E7_PSS_GROWTH_MIB,
} = require('../scripts/verify-wallpaper-plugin.js');

test('WP-11C RED: paths exist', () => {
  assert.equal(pathExists(runnerPath), true);
  assert.equal(pathExists(catalogPath), true);
  assert.equal(pathExists(wp11bTxnReceipt), true);
});

test('WP-11C RED: WP-11B EffectiveDone prerequisite', () => {
  assert.equal(readWp11bDone().ok, true);
});

test('WP-11C RED: catalog weight 4 E7', () => {
  const loaded = loadWp11cCatalogEntry();
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  assert.equal(loaded.entry.taskId, TASK_ID);
  assert.equal(loaded.entry.weight, EXPECTED_WEIGHT_FROM_PROGRESS_TABLE);
  assert.equal(loaded.entry.evidenceLevel, 'E7');
  assert.equal((loaded.entry.requiredEffectiveDone || []).includes('WP-11B'), true);
});

test('WP-11C RED: E7 verifier + fixtures', () => {
  assert.equal(assertE7VerifierSurface().ok, true);
  assert.equal(assertE7FixturesPresent().ok, true);
  assert.equal(assertE7Fixtures().ok, true);
  assert.equal(E7_DURATION_MS, 7200000);
  assert.equal(E7_SAMPLE_COUNT, 13);
  assert.equal(E7_PSS_GROWTH_MIB, 96);
  assert.equal(verifyE7Evidence(buildE7Fixture('keycodePowerOnlyReboot')).ok, false);
  assert.equal(verifyE7Evidence(buildE7Fixture('missingAccEvent')).ok, false);
  assert.equal(verifyE7Evidence(buildE7Fixture('wrongSampleCount')).ok, false);
  assert.equal(verifyE7Evidence(buildE7Fixture('correctE7')).ok, true);
});

test('WP-11C RED: evaluate surface present', () => {
  assert.equal(assertEvaluateSurface().ok, true);
});

test('WP-11C RED: full production capacity', () => {
  const r = assertWp11cFullProductionCapacity();
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('WP-11C RED: progress table pins remain authoritative after DONE', () => {
  if (pathExists(wp11cTxnReceipt)) {
    const r = readJson(wp11cTxnReceipt);
    if (r.EffectiveDone === true) {
      assert.equal(r.state, 'DONE');
      assert.ok(r.verifyDone);
    } else {
      assert.notEqual(r.state, 'DONE');
    }
  }
  assert.equal(EXPECTED_CURRENT_CORE_PROGRESS, 96);
  assert.equal(EXPECTED_PROGRESS_WHEN_DONE, 100);
});
