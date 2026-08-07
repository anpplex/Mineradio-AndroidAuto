'use strict';

/**
 * WP-12E / RED-01 — experimental catalog capacity (Scene/Video E4 non-black frame).
 *
 * Catalog-only pin: proves WP-12E exists with experimental weight 20,
 * deviceEvidence true, and embedded-scene-video scope. Does NOT implement
 * scene/video harness, run on-device positive, or forge experimental EffectiveDone.
 *
 * phaseCommands wire to plugin harness argv (tools may land in parallel):
 *   RED: bash scripts/verify-embedded-scene-video.sh --case frame-negative
 *   GREEN: bash scripts/verify-embedded-scene-video.sh --case frame-positive-offline
 *   REFACTOR: true
 *   VERIFY: bash scripts/tests/test-embedded-scene-video.sh
 * RED must not be mere ["true"].
 *
 * Note: full Scene+Video E4 requires SERIAL+APKs+frames; offline GREEN validates
 * frame contract fixtures only. Catalog registers capacity even if device is offline.
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
const TASK_ID = 'WP-12E';
const EXPECTED_EXPERIMENTAL_WEIGHT = 20;
const SCENE_VIDEO_MARKERS = Object.freeze([
  'scripts/verify-embedded-scene-video.sh',
  'scripts/tests/test-embedded-scene-video.sh',
  'scripts/tests/fixtures/frame-black.json',
  'scripts/tests/fixtures/frame-single-sample.json',
  'scripts/tests/fixtures/frame-e4-pass-offline.json',
  'app/src/test/java/com/motif/wallpaperengine/plugin/EmbeddedSceneVideoTest.kt',
  'scripts/analyze-frame-nonblack.py',
]);

function loadCatalog() {
  const raw = fs.readFileSync(catalogPath, 'utf8');
  return JSON.parse(raw);
}

function loadWp12eEntry() {
  const catalog = loadCatalog();
  const matches = (catalog.tasks || []).filter(
    (t) => t && t.taskId === TASK_ID,
  );
  if (matches.length !== 1) {
    return { ok: false, reason: 'missing_or_duplicate', count: matches.length };
  }
  return { ok: true, entry: matches[0] };
}

test('WP-12E RED: catalog file and tool exist', () => {
  assert.equal(fs.existsSync(catalogPath), true);
  assert.equal(fs.existsSync(catalogToolPath), true);
});

test('WP-12E RED: catalog has unique WP-12E task', () => {
  const loaded = loadWp12eEntry();
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  assert.equal(loaded.entry.taskId, TASK_ID);
});

test('WP-12E RED: experimental weight 20 with deviceEvidence E4', () => {
  const loaded = loadWp12eEntry();
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  assert.equal(loaded.entry.weight, EXPECTED_EXPERIMENTAL_WEIGHT);
  assert.equal(loaded.entry.path, 'experimental');
  assert.equal(loaded.entry.experimental, true);
  assert.equal(loaded.entry.deviceEvidence, true);
  assert.equal(loaded.entry.evidenceLevel, 'E4');
  assert.equal(loaded.entry.product, 'Wallpaper Engine');
});

test('WP-12E RED: dependsOn/requiredEffectiveDone include WP-12D chain', () => {
  const loaded = loadWp12eEntry();
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  const deps = loaded.entry.dependsOn || [];
  const required = loaded.entry.requiredEffectiveDone || [];
  assert.equal(deps.includes('WP-11C'), true);
  assert.equal(deps.includes('WP-12A'), true);
  assert.equal(deps.includes('WP-12B'), true);
  assert.equal(deps.includes('WP-12C'), true);
  assert.equal(deps.includes('WP-12D'), true);
  assert.equal(required.includes('WP-11C'), true);
  assert.equal(required.includes('WP-12A'), true);
  assert.equal(required.includes('WP-12B'), true);
  assert.equal(required.includes('WP-12C'), true);
  assert.equal(required.includes('WP-12D'), true);
  assert.equal(required.every((id) => deps.includes(id)), true);
});

test('WP-12E RED: scopeCheck lists embedded-scene-video experimental files', () => {
  const loaded = loadWp12eEntry();
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  const scope = loaded.entry.scopeCheck || {};
  const exact = scope.exactFiles || [];
  assert.equal(scope.experimental, true);
  assert.equal(scope.path, 'experimental');
  assert.equal(scope.product, 'Wallpaper Engine');
  for (const marker of SCENE_VIDEO_MARKERS) {
    assert.equal(
      exact.includes(marker),
      true,
      `scopeCheck.exactFiles missing ${marker}`,
    );
  }
});

test('WP-12E RED: phaseCommands cover RED/GREEN/REFACTOR/VERIFY with harness argv', () => {
  const loaded = loadWp12eEntry();
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  const phases = loaded.entry.phaseCommands || {};
  for (const phase of ['RED', 'GREEN', 'REFACTOR', 'VERIFY']) {
    assert.equal(typeof phases[phase], 'object', `missing phase ${phase}`);
    assert.equal(phases[phase].commandId, `WP-12E-${phase}`);
    assert.ok(Array.isArray(phases[phase].argv));
  }

  const redArgv = phases.RED.argv;
  assert.notDeepEqual(redArgv, ['true'], 'RED argv must not be stub ["true"]');
  assert.ok(
    redArgv.includes('scripts/verify-embedded-scene-video.sh'),
    'RED argv must include verify-embedded-scene-video.sh',
  );
  assert.ok(
    redArgv.includes('frame-negative'),
    'RED argv must include frame-negative case',
  );

  const greenArgv = phases.GREEN.argv;
  assert.ok(
    greenArgv.includes('scripts/verify-embedded-scene-video.sh'),
    'GREEN argv must include verify-embedded-scene-video.sh',
  );
  assert.ok(
    greenArgv.includes('frame-positive-offline'),
    'GREEN argv must include frame-positive-offline case',
  );

  const verifyArgv = phases.VERIFY.argv;
  assert.ok(
    verifyArgv.includes('scripts/tests/test-embedded-scene-video.sh'),
    'VERIFY argv must include test-embedded-scene-video.sh',
  );

  assert.equal(loaded.entry.expectedExit.RED, 1);
  assert.equal(loaded.entry.expectedExit.GREEN, 0);
  assert.equal(loaded.entry.expectedExit.REFACTOR, 0);
  assert.equal(loaded.entry.expectedExit.VERIFY, 0);
  assert.equal(loaded.entry.failureSignaturePolicy.RED.required, true);
  assert.equal(loaded.entry.failureSignaturePolicy.RED.match, 'stderr');
});
