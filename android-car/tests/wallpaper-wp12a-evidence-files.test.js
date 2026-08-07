'use strict';

/**
 * WP-12A Mineradio evidence allowlist — existence + honesty pins.
 *
 * Asserts wp-12x desensitized files exist, apkSha matches official seal,
 * and EffectiveDone remains false. Does not claim dual-closure DONE.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');

const repoRoot = path.resolve(__dirname, '../..');
const wp12xDir = path.join(
  repoRoot,
  'android-car/verification/wallpaper-plugin/wp-12x',
);
const finalManifestPath = path.join(wp12xDir, 'final-manifest.json');
const summaryPath = path.join(wp12xDir, 'summary.json');
const receiptPath = path.join(wp12xDir, 'receipts/wp-12a.json');

const EXPECTED_APK_SHA256 =
  '6982c82745444c5f2eef5a3d8c89ad807360bb5849a133548a6b25d18f4c4cb0';
const EXPECTED_PACKAGE = 'io.wallpaperengine.weclient';

function readJson(p) {
  assert.ok(fs.existsSync(p), `missing required evidence file: ${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function sha256File(p) {
  const buf = fs.readFileSync(p);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

test('WP-12A evidence allowlist files exist', () => {
  assert.ok(fs.existsSync(finalManifestPath), 'final-manifest.json');
  assert.ok(fs.existsSync(summaryPath), 'summary.json');
  assert.ok(fs.existsSync(receiptPath), 'receipts/wp-12a.json');
});

test('final-manifest: official apkSha + package + sealed flags', () => {
  const m = readJson(finalManifestPath);
  assert.equal(m.schemaVersion, 'wp12a-manifest-map/v1');
  assert.equal(m.packageName, EXPECTED_PACKAGE);
  assert.equal(m.apkSha256, EXPECTED_APK_SHA256);
  assert.equal(m.inventorySealed, true);
  assert.equal(m.EffectiveDone, false);
  assert.equal(m.failClosed && m.failClosed.ok, true);
  assert.equal(m.dex && m.dex.count, 2);
  assert.ok(Array.isArray(m.dex.entries) && m.dex.entries.length === 2);
  assert.ok(Array.isArray(m.authorities) && m.authorities.length === 2);
  assert.equal(m.permissions && m.permissions.declaredCount, 1);
  assert.equal(m.permissions && m.permissions.usesCount, 15);
});

test('summary: VERIFIED_LOCAL / EVIDENCE_SEALED local, weight still zero', () => {
  const s = readJson(summaryPath);
  assert.equal(s.taskId, 'WP-12A');
  assert.equal(s.status, 'VERIFIED_LOCAL');
  assert.equal(s.evidenceStatus, 'EVIDENCE_SEALED');
  assert.equal(s.weightStillZero, true);
  assert.equal(s.EffectiveDone, false);
  assert.equal(s.apkSha256, EXPECTED_APK_SHA256);
});

test('receipt: staged state, EffectiveDone false, manifest sha matches file', () => {
  const r = readJson(receiptPath);
  assert.equal(r.taskId, 'WP-12A');
  assert.equal(r.EffectiveDone, false);
  assert.ok(
    r.state === 'MINERADIO_EVIDENCE_STAGED' || r.state === 'EVIDENCE_PREPARED',
    `unexpected state: ${r.state}`,
  );
  assert.equal(r.apkSha256, EXPECTED_APK_SHA256);
  assert.equal(r.inventorySealed, true);
  assert.equal(r.dualClosureComplete, false);

  const fileSha = sha256File(finalManifestPath);
  assert.equal(
    r.desensitizedFinalManifest && r.desensitizedFinalManifest.sha256,
    fileSha,
    'receipt sealed inventory sha256 must match final-manifest.json bytes',
  );
});

test('no evidence file claims EffectiveDone true', () => {
  for (const p of [finalManifestPath, summaryPath, receiptPath]) {
    const j = readJson(p);
    assert.equal(j.EffectiveDone, false, `${path.basename(p)} EffectiveDone`);
  }
});
