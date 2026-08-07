'use strict';

/**
 * WP-12D / RED-01 — experimental catalog capacity (device E2/E3 runtime).
 *
 * Catalog-only pin: proves WP-12D exists with experimental weight 15,
 * deviceEvidence true, and embedded-runtime-device scope. Does NOT implement
 * device harness, run on-device positive, or forge experimental EffectiveDone.
 *
 * phaseCommands wire to plugin harness argv (tools may land in parallel):
 *   RED: bash scripts/verify-embedded-runtime-device.sh --case device-negative
 *   GREEN: bash scripts/verify-embedded-runtime-device.sh --case device-positive-offline
 *   REFACTOR: true
 *   VERIFY: bash scripts/tests/test-embedded-runtime-device.sh
 * RED must not be mere ["true"].
 *
 * Note: full device-positive requires SERIAL+APKs; offline GREEN validates
 * contract fixtures only. Catalog registers capacity even if device is offline.
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const repoRoot = path.resolve(__dirname, '../..');
const catalogPath = path.join(repoRoot, 'android-car/scripts/wallpaper-plugin-tasks.json');
const catalogToolPath = path.join(
  repoRoot,
  'android-car/scripts/generate-wallpaper-task-catalog.py',
);
const TASK_ID = 'WP-12D';
const EXPECTED_EXPERIMENTAL_WEIGHT = 15;
const DEVICE_RUNTIME_MARKERS = Object.freeze([
  'scripts/verify-embedded-runtime-device.sh',
  'scripts/tests/test-embedded-runtime-device.sh',
  'scripts/tests/fixtures/device-missing-serial.json',
  'scripts/tests/fixtures/device-wrong-user.json',
  'scripts/tests/fixtures/device-official-as-embedded-host.json',
  'app/src/test/java/com/motif/wallpaperengine/plugin/EmbeddedRuntimeDeviceContractTest.kt',
]);

function loadCatalog() {
  const raw = fs.readFileSync(catalogPath, 'utf8');
  return JSON.parse(raw);
}

function loadWp12dEntry() {
  const catalog = loadCatalog();
  const matches = (catalog.tasks || []).filter(
    (t) => t && t.taskId === TASK_ID,
  );
  if (matches.length !== 1) {
    return { ok: false, reason: 'missing_or_duplicate', count: matches.length };
  }
  return { ok: true, entry: matches[0] };
}

test('WP-12D RED: catalog file and tool exist', () => {
  assert.equal(fs.existsSync(catalogPath), true);
  assert.equal(fs.existsSync(catalogToolPath), true);
});

test('WP-12D RED: catalog has unique WP-12D task', () => {
  const loaded = loadWp12dEntry();
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  assert.equal(loaded.entry.taskId, TASK_ID);
});

test('WP-12D RED: experimental weight 15 with deviceEvidence E3', () => {
  const loaded = loadWp12dEntry();
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  assert.equal(loaded.entry.weight, EXPECTED_EXPERIMENTAL_WEIGHT);
  assert.equal(loaded.entry.path, 'experimental');
  assert.equal(loaded.entry.experimental, true);
  assert.equal(loaded.entry.deviceEvidence, true);
  assert.equal(loaded.entry.evidenceLevel, 'E3');
  assert.equal(loaded.entry.product, 'Wallpaper Engine');
});

test('WP-12D RED: dependsOn/requiredEffectiveDone include WP-12C chain', () => {
  const loaded = loadWp12dEntry();
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  const deps = loaded.entry.dependsOn || [];
  const required = loaded.entry.requiredEffectiveDone || [];
  assert.equal(deps.includes('WP-11C'), true);
  assert.equal(deps.includes('WP-12A'), true);
  assert.equal(deps.includes('WP-12B'), true);
  assert.equal(deps.includes('WP-12C'), true);
  assert.equal(required.includes('WP-11C'), true);
  assert.equal(required.includes('WP-12A'), true);
  assert.equal(required.includes('WP-12B'), true);
  assert.equal(required.includes('WP-12C'), true);
  assert.equal(required.every((id) => deps.includes(id)), true);
});

test('WP-12D RED: scopeCheck lists embedded-runtime-device experimental files', () => {
  const loaded = loadWp12dEntry();
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  const scope = loaded.entry.scopeCheck || {};
  const exact = scope.exactFiles || [];
  assert.equal(scope.experimental, true);
  assert.equal(scope.path, 'experimental');
  assert.equal(scope.product, 'Wallpaper Engine');
  for (const marker of DEVICE_RUNTIME_MARKERS) {
    assert.equal(
      exact.includes(marker),
      true,
      `scopeCheck.exactFiles missing ${marker}`,
    );
  }
});

test('WP-12D RED: phaseCommands cover RED/GREEN/REFACTOR/VERIFY with harness argv', () => {
  const loaded = loadWp12dEntry();
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  const phases = loaded.entry.phaseCommands || {};
  for (const phase of ['RED', 'GREEN', 'REFACTOR', 'VERIFY']) {
    assert.equal(typeof phases[phase], 'object', `missing phase ${phase}`);
    assert.equal(phases[phase].commandId, `WP-12D-${phase}`);
    assert.ok(Array.isArray(phases[phase].argv));
  }

  const redArgv = phases.RED.argv;
  assert.notDeepEqual(redArgv, ['true'], 'RED argv must not be stub ["true"]');
  assert.ok(
    redArgv.includes('scripts/verify-embedded-runtime-device.sh'),
    'RED argv must include verify-embedded-runtime-device.sh',
  );
  assert.ok(
    redArgv.includes('device-negative'),
    'RED argv must include device-negative case',
  );

  const greenArgv = phases.GREEN.argv;
  assert.ok(
    greenArgv.includes('scripts/verify-embedded-runtime-device.sh'),
    'GREEN argv must include verify-embedded-runtime-device.sh',
  );
  assert.ok(
    greenArgv.includes('device-positive-offline'),
    'GREEN argv must include device-positive-offline case',
  );

  const verifyArgv = phases.VERIFY.argv;
  assert.ok(
    verifyArgv.includes('scripts/tests/test-embedded-runtime-device.sh'),
    'VERIFY argv must include test-embedded-runtime-device.sh',
  );

  assert.equal(loaded.entry.expectedExit.RED, 1);
  assert.equal(loaded.entry.expectedExit.GREEN, 0);
  assert.equal(loaded.entry.expectedExit.REFACTOR, 0);
  assert.equal(loaded.entry.expectedExit.VERIFY, 0);
  assert.equal(loaded.entry.failureSignaturePolicy.RED.required, true);
  assert.equal(loaded.entry.failureSignaturePolicy.RED.match, 'stderr');
});
