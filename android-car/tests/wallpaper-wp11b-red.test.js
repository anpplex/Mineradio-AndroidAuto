'use strict';

/** WP-11B / RED-01 — E6 30-min soak capacity (weight 3). */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  runnerPath,
  catalogPath,
  wp11aTxnReceipt,
  wp11bTxnReceipt,
  TASK_ID,
  EXPECTED_CURRENT_CORE_PROGRESS,
  EXPECTED_WEIGHT_FROM_PROGRESS_TABLE,
  EXPECTED_PROGRESS_WHEN_DONE,
  pathExists,
  readJson,
  loadWp11bCatalogEntry,
  assertE6VerifierSurface,
  assertE6FixturesPresent,
  assertEvaluateSurface,
  assertWp11bFullProductionCapacity,
  readWp11aDone,
} = require('./wallpaper-wp11b-red-helpers');

const {
  buildE6Fixture,
  verifyE6Evidence,
  assertE6Fixtures,
  E6_DURATION_MS,
  E6_SAMPLE_COUNT,
  E6_PSS_GROWTH_MIB,
} = require('../scripts/verify-wallpaper-plugin.js');

test('WP-11B RED: paths exist', () => {
  assert.equal(pathExists(runnerPath), true);
  assert.equal(pathExists(catalogPath), true);
  assert.equal(pathExists(wp11aTxnReceipt), true);
});

test('WP-11B RED: WP-11A EffectiveDone prerequisite', () => {
  assert.equal(readWp11aDone().ok, true);
});

test('WP-11B RED: catalog weight 3 E6', () => {
  const loaded = loadWp11bCatalogEntry();
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  assert.equal(loaded.entry.taskId, TASK_ID);
  assert.equal(loaded.entry.weight, EXPECTED_WEIGHT_FROM_PROGRESS_TABLE);
  assert.equal(loaded.entry.evidenceLevel, 'E6');
  assert.equal((loaded.entry.requiredEffectiveDone || []).includes('WP-11A'), true);
});

test('WP-11B RED: E6 verifier + fixtures', () => {
  assert.equal(assertE6VerifierSurface().ok, true);
  assert.equal(assertE6FixturesPresent().ok, true);
  assert.equal(assertE6Fixtures().ok, true);
  assert.equal(E6_DURATION_MS, 1800000);
  assert.equal(E6_SAMPLE_COUNT, 7);
  assert.equal(E6_PSS_GROWTH_MIB, 64);
  assert.equal(verifyE6Evidence(buildE6Fixture('wrongSampleCount')).ok, false);
  assert.equal(verifyE6Evidence(buildE6Fixture('pssGrowthTooHigh')).ok, false);
  assert.equal(verifyE6Evidence(buildE6Fixture('missingInteractions')).ok, false);
  assert.equal(verifyE6Evidence(buildE6Fixture('correctE6')).ok, true);
});

test('WP-11B RED: evaluate surface present', () => {
  assert.equal(assertEvaluateSurface().ok, true);
});

test('WP-11B RED: full production capacity', () => {
  const r = assertWp11bFullProductionCapacity();
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('WP-11B RED: progress table pins remain authoritative after DONE', () => {
  if (pathExists(wp11bTxnReceipt)) {
    const r = readJson(wp11bTxnReceipt);
    if (r.EffectiveDone === true) {
      assert.equal(r.state, 'DONE');
      assert.ok(r.verifyDone);
    } else {
      assert.notEqual(r.state, 'DONE');
    }
  }
  assert.equal(EXPECTED_CURRENT_CORE_PROGRESS, 93);
  assert.equal(EXPECTED_PROGRESS_WHEN_DONE, 96);
});
