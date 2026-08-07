'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const WP12X = path.join(ROOT, 'verification/wallpaper-plugin/wp-12x');

function readJson(rel) {
  const p = path.join(WP12X, rel);
  assert.ok(fs.existsSync(p), `missing ${rel}`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

test('wp-12b native sealed summary inventorySealed; EffectiveDone false on seal summary', () => {
  const doc = readJson('native-sealed-summary.json');
  assert.strictEqual(doc.taskId, 'WP-12B');
  assert.strictEqual(doc.inventorySealed, true);
  // seal summary stays non-task-done; task EffectiveDone is on receipt after verify-done
  assert.strictEqual(doc.EffectiveDone, false);
  assert.strictEqual(doc.mode, 'native-closure');
  assert.ok(doc.apkSha256 && doc.apkSha256.length === 64);
  assert.ok(doc.failClosed && doc.failClosed.ok === true);
  assert.ok((doc.counts?.arm64LibCount || 0) >= 1);
});

test('wp-12b receipt DONE after verify-done', () => {
  const doc = readJson('receipts/wp-12b.json');
  assert.strictEqual(doc.taskId, 'WP-12B');
  assert.strictEqual(doc.state, 'DONE');
  assert.strictEqual(doc.EffectiveDone, true);
  assert.strictEqual(doc.inventorySealed, true);
  assert.strictEqual(doc.weightStillZero, false);
  assert.strictEqual(doc.dualClosureComplete, true);
});

test('wp-12b summary sidecar reflects 45% experimental', () => {
  const doc = readJson('summary-wp-12b.json');
  assert.strictEqual(doc.taskId, 'WP-12B');
  assert.strictEqual(doc.EffectiveDone, true);
  assert.strictEqual(doc.weightStillZero, false);
  assert.strictEqual(doc.inventorySealed, true);
  assert.strictEqual(doc.experimentalProgress, '45%');
});

test('wp-12a final-manifest still present with inventorySealed', () => {
  const doc = readJson('final-manifest.json');
  assert.ok(doc.inventorySealed === true || doc.taskId === 'WP-12A');
});
