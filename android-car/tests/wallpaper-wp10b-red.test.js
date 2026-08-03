'use strict';

/**
 * WP-10B / RED-01 — Scene/Video E4 dual-frame capacity (weight 8).
 * Does not claim EffectiveDone or raise Core above 76%.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runnerPath,
  catalogPath,
  schemaPath,
  wp10aTxnReceipt,
  wp10bTxnReceipt,
  TASK_ID,
  EXPECTED_CURRENT_CORE_PROGRESS,
  EXPECTED_WEIGHT_FROM_PROGRESS_TABLE,
  EXPECTED_PROGRESS_WHEN_DONE,
  WP10B_E4_FAIL_FIXTURES,
  pathExists,
  readJson,
  loadWp10bCatalogEntry,
  assertE4VerifierSurface,
  assertE4FixturesPresent,
  assertParentChainSurfaces,
  assertWp10bFullProductionCapacity,
  readWp10aDone,
} = require('./wallpaper-wp10b-red-helpers');

const {
  E4_FIXTURE_NAMES,
  buildE4Fixture,
  verifyE4Evidence,
  assertE4Fixtures,
} = require('../scripts/verify-wallpaper-plugin.js');

test('WP-10B RED-01: environment paths exist', () => {
  assert.equal(pathExists(runnerPath), true);
  assert.equal(pathExists(catalogPath), true);
  assert.equal(pathExists(schemaPath), true);
  assert.equal(pathExists(wp10aTxnReceipt), true, 'wp-10a.json missing');
});

test('WP-10B RED-01: WP-10A EffectiveDone prerequisite', () => {
  const prereq = readWp10aDone();
  assert.equal(prereq.ok, true, JSON.stringify(prereq));
});

test('WP-10B RED-01.1 catalog unique WP-10B weight 8 E4', () => {
  const loaded = loadWp10bCatalogEntry();
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  assert.equal(loaded.entry.taskId, TASK_ID);
  assert.equal(loaded.entry.weight, EXPECTED_WEIGHT_FROM_PROGRESS_TABLE);
  assert.equal(loaded.entry.evidenceLevel, 'E4');
  assert.ok((loaded.entry.requiredEffectiveDone || []).includes('WP-10A'));
});

test('WP-10B RED-01.2 E4 verifier surface present', () => {
  const r = assertE4VerifierSurface();
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('WP-10B RED-01.3 E4 fail fixtures reject black/solid/log-only/forged', () => {
  const r = assertE4FixturesPresent();
  assert.equal(r.ok, true, JSON.stringify(r));
  for (const name of WP10B_E4_FAIL_FIXTURES) {
    assert.ok(E4_FIXTURE_NAMES.includes(name), name);
    const v = verifyE4Evidence(buildE4Fixture(name));
    assert.equal(v.ok, false, `fixture ${name} should fail`);
  }
  const good = verifyE4Evidence(buildE4Fixture('correctE4'));
  assert.equal(good.ok, true, JSON.stringify(good));
});

test('WP-10B RED-01.4 assertE4Fixtures aggregate', () => {
  const r = assertE4Fixtures();
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('WP-10B RED-01.5 parent chain / evaluate surfaces on runner', () => {
  const r = assertParentChainSurfaces();
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('WP-10B RED-01.6 full production capacity aggregate', () => {
  const r = assertWp10bFullProductionCapacity();
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('WP-10B RED-01.7 progress table pins remain authoritative after DONE', () => {
  // Post-DONE hygiene: receipt may be DONE@84; pins document RED-era expectations only.
  if (pathExists(wp10bTxnReceipt)) {
    const r = readJson(wp10bTxnReceipt);
    if (r.EffectiveDone === true) {
      assert.equal(r.state, 'DONE');
      assert.ok(r.verifyDone);
    } else {
      assert.notEqual(r.state, 'DONE');
    }
  }
  assert.equal(EXPECTED_CURRENT_CORE_PROGRESS, 76);
  assert.equal(EXPECTED_PROGRESS_WHEN_DONE, 84);
});

test('WP-10B RED-01.8 caller cannot forge PREVIEW_READY as E4', () => {
  const forged = verifyE4Evidence(buildE4Fixture('forgedPreviewReady'));
  assert.equal(forged.ok, false);
  assert.ok(
    forged.errors.includes('forgedPreviewReady') || forged.code === 'forgedPreviewReady',
  );
});
