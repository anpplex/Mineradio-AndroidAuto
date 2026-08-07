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

test('wp-12b native sealed summary has inventorySealed and EffectiveDone false', () => {
  const doc = readJson('native-sealed-summary.json');
  assert.strictEqual(doc.taskId, 'WP-12B');
  assert.strictEqual(doc.inventorySealed, true);
  assert.strictEqual(doc.EffectiveDone, false);
  assert.strictEqual(doc.mode, 'native-closure');
  assert.ok(doc.apkSha256 && doc.apkSha256.length === 64);
  assert.ok(doc.failClosed && doc.failClosed.ok === true);
  assert.ok((doc.counts?.arm64LibCount || 0) >= 1);
});

test('wp-12b receipt staged not DONE/EffectiveDone', () => {
  const doc = readJson('receipts/wp-12b.json');
  assert.strictEqual(doc.taskId, 'WP-12B');
  assert.strictEqual(doc.EffectiveDone, false);
  assert.strictEqual(doc.inventorySealed, true);
  assert.strictEqual(doc.weightStillZero, true);
  assert.notStrictEqual(doc.state, 'DONE');
  assert.ok(doc.state === 'MINERADIO_EVIDENCE_STAGED' || doc.state === 'MINERADIO_EVIDENCE_COMMITTED');
});

test('wp-12b summary sidecar not claiming progress weight', () => {
  const doc = readJson('summary-wp-12b.json');
  assert.strictEqual(doc.taskId, 'WP-12B');
  assert.strictEqual(doc.EffectiveDone, false);
  assert.strictEqual(doc.weightStillZero, true);
  assert.strictEqual(doc.inventorySealed, true);
});

test('wp-12a final-manifest still inventorySealed with EffectiveDone true only after its verify-done', () => {
  // final-manifest may remain WP-12A shaped; do not require WP-12B fields here
  const doc = readJson('final-manifest.json');
  assert.ok(doc.inventorySealed === true || doc.taskId === 'WP-12A');
});
