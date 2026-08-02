'use strict';

/**
 * Task 9 named RED contract: wp09-transaction dual-repo state machine.
 *
 * Create/Modify: android-car/tests/wp09-transaction.test.js
 * RED: wp09-transaction.py missing → WP09_* fail-closed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FailureReason,
  assertWp09TransactionToolPresent,
  assertWp09TransactionTestPresent,
  pathExists,
  wp09TxnToolPath,
  readPrerequisiteDone,
} = require('./wallpaper-wp09-red-helpers');

test('wp09-transaction RED: prereqs WP-08 DONE', () => {
  const prereq = readPrerequisiteDone();
  assert.equal(prereq.ok, true, JSON.stringify(prereq));
  assert.equal(prereq['WP-08'].EffectiveDone, true);
});

test('wp09-transaction RED: tool surface missing → WP09_TRANSACTION_TOOL_MISSING', () => {
  const r = assertWp09TransactionToolPresent();
  if (!pathExists(wp09TxnToolPath)) {
    assert.equal(r.ok, false);
    assert.equal(r.failureReason, FailureReason.WP09_TRANSACTION_TOOL_MISSING);
    assert.fail(`${FailureReason.WP09_TRANSACTION_TOOL_MISSING}: ${wp09TxnToolPath}`);
  }
  assert.equal(r.ok, true);
});

test('wp09-transaction RED: named test path registered', () => {
  // This file is the named surface; GREEN implements tool.
  const r = assertWp09TransactionTestPresent();
  assert.equal(r.ok, true, r.message);
});

test('wp09-transaction RED: stable WP09_* tokens', () => {
  assert.equal(
    FailureReason.WP09_TRANSACTION_TOOL_MISSING,
    'WP09_TRANSACTION_TOOL_MISSING',
  );
  assert.equal(
    FailureReason.WP09_TRANSACTION_TEST_MISSING,
    'WP09_TRANSACTION_TEST_MISSING',
  );
});
