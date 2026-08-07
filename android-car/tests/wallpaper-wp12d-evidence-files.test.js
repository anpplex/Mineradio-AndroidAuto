'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const wp12x = path.join(root, 'verification/wallpaper-plugin/wp-12x');

function readJson(rel) {
  const p = path.join(wp12x, rel);
  assert.ok(fs.existsSync(p), `missing ${rel}`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

describe('WP-12D evidence files (desensitized device e2-e3)', () => {
  it('stages sealed summary with inventorySealed and EffectiveDone false', () => {
    const s = readJson('device-e2e3-sealed-summary.json');
    assert.strictEqual(s.taskId, 'WP-12D');
    assert.strictEqual(s.mode, 'device-e2e3');
    assert.strictEqual(s.inventorySchemaVersion, 'wp12d-device-e2e3/v1');
    assert.strictEqual(s.inventorySealed, true);
    assert.strictEqual(s.EffectiveDone, false);
    assert.strictEqual(s.deviceEvidenceClaimed, true);
    assert.strictEqual(s.officialNotEmbeddedHost, true);
    assert.ok(s.failClosed && s.failClosed.ok === true);
    assert.ok(!('serial' in s) || s.serial == null, 'serial must be desensitized/omitted');
    assert.ok(s.signatures && s.signatures.officialWe);
    assert.ok(s.sourceSeal && s.sourceSeal.rawSha256);
  });

  it('stages receipt without claiming EffectiveDone or progress weight', () => {
    const r = readJson('receipts/wp-12d.json');
    assert.strictEqual(r.taskId, 'WP-12D');
    assert.strictEqual(r.EffectiveDone, false);
    assert.strictEqual(r.weightStillZero, true);
    assert.strictEqual(r.inventorySealed, true);
    assert.strictEqual(r.experimentalProgress, '65%');
    assert.ok(r.desensitizedDeviceE2e3SealedSummary);
    assert.ok(r.desensitizedDeviceE2e3SealedSummary.sha256);
  });

  it('updates final-manifest and summary with deviceE2e3 section', () => {
    const fm = readJson('final-manifest.json');
    assert.ok(fm.deviceE2e3);
    assert.strictEqual(fm.deviceE2e3.taskId, 'WP-12D');
    assert.strictEqual(fm.deviceE2e3.EffectiveDone, false);
    assert.strictEqual(fm.deviceE2e3.inventorySealed, true);

    const su = readJson('summary.json');
    assert.ok(su.deviceE2e3);
    assert.strictEqual(su.deviceE2e3.EffectiveDone, false);
    assert.strictEqual(su.deviceE2e3.weightStillZero, true);
  });
});
