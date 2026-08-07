'use strict';

/**
 * WP-12B Mineradio evidence allowlist — existence + honesty pins.
 *
 * Asserts wp-12x desensitized native section + wp-12b receipt exist,
 * apkSha matches official seal, arm64 libs present, and EffectiveDone
 * remains false. Does not claim dual-closure DONE or 20% progress.
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
const receiptPath = path.join(wp12xDir, 'receipts/wp-12b.json');

const EXPECTED_APK_SHA256 =
  '6982c82745444c5f2eef5a3d8c89ad807360bb5849a133548a6b25d18f4c4cb0';
const EXPECTED_PACKAGE = 'io.wallpaperengine.weclient';
const EXPECTED_ARM64_LIB_SHA256 =
  '908bf18eb4360f1f629eb132f425bb433ed7b96fef2570919a148f9154c013a9';

function readJson(p) {
  assert.ok(fs.existsSync(p), `missing required evidence file: ${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function sha256File(p) {
  const buf = fs.readFileSync(p);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

test('WP-12B evidence allowlist files exist', () => {
  assert.ok(fs.existsSync(finalManifestPath), 'final-manifest.json');
  assert.ok(fs.existsSync(summaryPath), 'summary.json');
  assert.ok(fs.existsSync(receiptPath), 'receipts/wp-12b.json');
});

test('final-manifest native: arm64 present, failClosedOk, apkSha match', () => {
  const m = readJson(finalManifestPath);
  assert.equal(m.packageName, EXPECTED_PACKAGE);
  assert.equal(m.apkSha256, EXPECTED_APK_SHA256);
  assert.equal(m.EffectiveDone, false);

  const native = m.native;
  assert.ok(native && typeof native === 'object', 'native section required');
  assert.equal(native.schemaVersion, 'wp12b-native-libs/v1');
  assert.equal(native.apkSha256, EXPECTED_APK_SHA256);
  assert.equal(native.failClosedOk, true);
  assert.equal(native.abiCounts && native.abiCounts['arm64-v8a'], 1);
  assert.ok(Array.isArray(native.arm64Libs) && native.arm64Libs.length >= 1);

  const lib = native.arm64Libs.find((l) => l && l.name === 'libscenejni.so');
  assert.ok(lib, 'arm64 libscenejni.so required');
  assert.equal(lib.sha256, EXPECTED_ARM64_LIB_SHA256);
  assert.equal(lib.sizeBytes, 41866072);
  assert.equal(lib.soname, 'libscenejni.so');
  assert.ok(Array.isArray(lib.needed) && lib.needed.length >= 1);
  assert.ok(lib.needed.includes('libandroid.so'));
});

test('summary: WP-12B inventory staged; experimental still 25%; no 20% claim', () => {
  const s = readJson(summaryPath);
  assert.equal(s.apkSha256, EXPECTED_APK_SHA256);
  assert.equal(s.experimentalProgress, '25%');

  const native = s.native;
  assert.ok(native && typeof native === 'object', 'summary.native required');
  assert.equal(native.taskId, 'WP-12B');
  assert.equal(native.state, 'MINERADIO_EVIDENCE_STAGED');
  assert.equal(native.EffectiveDone, false);
  assert.equal(native.weightStillZero, true);
  assert.equal(native.failClosedOk, true);
  assert.ok(
    Array.isArray(native.arm64Libs) && native.arm64Libs.length >= 1,
    'summary.native.arm64Libs',
  );

  const notes = (s.notes || []).join(' ');
  assert.ok(/WP-12B/i.test(notes), 'summary notes mention WP-12B');
  assert.ok(
    !/\b20%\b/.test(notes) || /NO.*20%|no.*20%/i.test(notes),
    'must not claim 20% progress without NO disclaimer',
  );
});

test('receipt: MINERADIO_EVIDENCE_STAGED, EffectiveDone false, native arm64', () => {
  const r = readJson(receiptPath);
  assert.equal(r.taskId, 'WP-12B');
  assert.equal(r.state, 'MINERADIO_EVIDENCE_STAGED');
  assert.equal(r.EffectiveDone, false);
  assert.equal(r.weightStillZero, true);
  assert.equal(r.dualClosureComplete, false);
  assert.equal(r.apkSha256, EXPECTED_APK_SHA256);
  assert.equal(r.inventorySchemaVersion, 'wp12b-native-libs/v1');
  assert.equal(r.failClosed && r.failClosed.ok, true);
  assert.equal(r.experimentalProgress, '25%');

  const native = r.native;
  assert.ok(native && typeof native === 'object');
  assert.equal(native.failClosedOk, true);
  const lib = (native.arm64Libs || []).find((l) => l.name === 'libscenejni.so');
  assert.ok(lib, 'receipt native arm64 libscenejni.so');
  assert.equal(lib.sha256, EXPECTED_ARM64_LIB_SHA256);

  const fileSha = sha256File(finalManifestPath);
  assert.equal(
    r.desensitizedFinalManifest && r.desensitizedFinalManifest.sha256,
    fileSha,
    'receipt final-manifest sha256 must match file bytes',
  );
});

test('WP-12B evidence files do not claim EffectiveDone true', () => {
  const r = readJson(receiptPath);
  assert.equal(r.EffectiveDone, false, 'wp-12b.json EffectiveDone');
  const m = readJson(finalManifestPath);
  assert.equal(m.EffectiveDone, false, 'final-manifest EffectiveDone');
  const s = readJson(summaryPath);
  if (s.native) {
    assert.equal(s.native.EffectiveDone, false, 'summary.native EffectiveDone');
  }
});
