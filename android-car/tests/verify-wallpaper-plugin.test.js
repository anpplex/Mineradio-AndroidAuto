'use strict';

/**
 * Task 9 named RED contract: verify-wallpaper-plugin static verifier.
 *
 * Create path: android-car/tests/verify-wallpaper-plugin.test.js
 * RED: production verifier missing → WP09_* fail-closed.
 * GREEN implements verify-wallpaper-plugin.js + mismatch fixtures.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FailureReason,
  assertWp09VerifierJsPresent,
  assertWp09StaticContract,
  assertWp09MismatchFixtures,
  assertWp09FullProductionCapacity,
  WP09_MISMATCH_FIXTURES,
  pathExists,
  verifyJsPath,
} = require('./wallpaper-wp09-red-helpers');

test('verifier RED: verify-wallpaper-plugin.js capacity', () => {
  const r = assertWp09VerifierJsPresent();
  if (!pathExists(verifyJsPath)) {
    assert.equal(r.failureReason, FailureReason.WP09_VERIFIER_JS_MISSING);
    assert.fail(`${FailureReason.WP09_VERIFIER_JS_MISSING}: ${verifyJsPath}`);
  }
  assert.equal(r.ok, true);
});

test('verifier RED: three-package static contract (Mineradio/plugin/official)', () => {
  const r = assertWp09StaticContract();
  if (!r.ok) {
    assert.equal(r.failureReason, FailureReason.WP09_STATIC_CONTRACT_MISSING);
    assert.fail(`${r.failureReason}: ${r.message}`);
  }
  assert.equal(r.ok, true);
});

test('verifier RED: cert/split mismatch fixtures', () => {
  const r = assertWp09MismatchFixtures();
  if (!r.ok) {
    assert.equal(r.failureReason, FailureReason.WP09_MISMATCH_FIXTURES_MISSING);
    assert.fail(
      `${FailureReason.WP09_MISMATCH_FIXTURES_MISSING}: need ${WP09_MISMATCH_FIXTURES.join(',')}`,
    );
  }
  assert.equal(r.ok, true);
});

test('verifier RED: full capacity aggregate fail-closed', () => {
  const r = assertWp09FullProductionCapacity();
  if (!r.ok) {
    assert.match(String(r.failureReason), /^WP09_/);
    assert.equal(r.EffectiveDone, false);
    assert.fail(`${r.failureReason}: ${r.message}`);
  }
  assert.equal(r.ok, true);
});

test('verifier GREEN: assertVerifyFixtures covers cert/split mismatch', () => {
  // eslint-disable-next-line import/no-dynamic-require, global-require
  const v = require('../scripts/verify-wallpaper-plugin.js');
  assert.equal(typeof v.assertVerifyFixtures, 'function');
  const r = v.assertVerifyFixtures();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.FIXTURE_NAMES.includes('certMismatch'));
  assert.ok(r.FIXTURE_NAMES.includes('splitSignerMismatch'));
  assert.equal(v.PACKAGES.mineradio, 'com.mineradio.app');
  assert.equal(v.PACKAGES.plugin, 'com.motif.wallpaperengine');
  assert.equal(v.PACKAGES.official, 'io.wallpaperengine.weclient');
  assert.ok(String(v.BUILD_PROP_CALLER_CERT).includes('mineradioCallerCertSha256'));
});
test('verifier GREEN: E3 fixtures fail-closed; correctE3 passes', () => {
  // eslint-disable-next-line import/no-dynamic-require, global-require
  const v = require('../scripts/verify-wallpaper-plugin.js');
  assert.equal(typeof v.verifyE3Evidence, 'function');
  assert.equal(typeof v.buildE3Fixture, 'function');
  assert.equal(typeof v.parseContentCallBundle, 'function');
  const r = v.assertE3Fixtures();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(v.E3_FIXTURE_NAMES.includes('shellCallerOnly'));
  assert.ok(v.E3_FIXTURE_NAMES.includes('runtimePidEqualsMineradio'));
  const shell = v.verifyE3Evidence(v.buildE3Fixture('shellCallerOnly'));
  assert.equal(shell.ok, false);
  assert.ok(shell.errors.includes('shellCallerOnly'));
  const good = v.verifyE3Evidence(v.buildE3Fixture('correctE3'));
  assert.equal(good.ok, true, JSON.stringify(good));
  const parsed = v.parseContentCallBundle(
    'Result: Bundle[{code=20, callId=abc, operationId=op1, actionEpoch=1, actionToken=t, runtimePid=9}]',
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.code, 20);
  assert.equal(parsed.runtimePid, 9);
});
