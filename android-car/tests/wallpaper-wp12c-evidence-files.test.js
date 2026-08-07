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

test('wp-12c adapter sealed summary inventorySealed; EffectiveDone false', () => {
  const doc = readJson('adapter-contract-sealed-summary.json');
  assert.strictEqual(doc.taskId, 'WP-12C');
  assert.strictEqual(doc.inventorySealed, true);
  assert.strictEqual(doc.EffectiveDone, false);
  assert.strictEqual(doc.mode, 'adapter-contract');
  assert.strictEqual(doc.embeddedRuntimeDefault, false);
  assert.ok(doc.failClosed && doc.failClosed.ok === true);
  assert.ok(doc.checks && doc.checks.unknownMethodRejected === true);
  assert.ok(doc.checks.defaultUsesOfficial === true);
});

test('wp-12c receipt staged not EffectiveDone', () => {
  const doc = readJson('receipts/wp-12c.json');
  assert.strictEqual(doc.taskId, 'WP-12C');
  assert.ok(['MINERADIO_EVIDENCE_STAGED', 'DONE'].includes(doc.state));
  assert.strictEqual(doc.inventorySealed, true);
  // before verify-done: false; after progress closure may become true
  if (doc.state === 'MINERADIO_EVIDENCE_STAGED') {
    assert.strictEqual(doc.EffectiveDone, false);
    assert.strictEqual(doc.weightStillZero, true);
  }
});

test('wp-12c summary sidecar present', () => {
  const doc = readJson('summary-wp-12c.json');
  assert.strictEqual(doc.taskId, 'WP-12C');
  assert.strictEqual(doc.inventorySealed, true);
});

test('final-manifest adapterContract section desensitized', () => {
  const doc = readJson('final-manifest.json');
  assert.ok(doc.adapterContract, 'adapterContract section required');
  assert.strictEqual(doc.adapterContract.schemaVersion, 'wp12c-adapter-contract/v1');
  assert.strictEqual(doc.adapterContract.inventorySealed, true);
  assert.strictEqual(doc.adapterContract.EffectiveDone, false);
});
