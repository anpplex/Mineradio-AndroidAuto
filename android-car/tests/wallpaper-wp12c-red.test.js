'use strict';

/**
 * WP-12C / RED-01 — experimental catalog capacity (EmbeddedEngineAdapter).
 *
 * Catalog-only pin: proves WP-12C exists with experimental weight 20 and
 * embedded-adapter scope. Does NOT implement adapter harness, evaluate_wp12c,
 * device evidence, or experimental EffectiveDone.
 *
 * phaseCommands wire to plugin harness argv (tools may land in parallel):
 *   RED: bash scripts/verify-embedded-adapter.sh --case adapter-negative
 *   GREEN: bash scripts/verify-embedded-adapter.sh --case adapter-positive
 *   REFACTOR: true
 *   VERIFY: bash scripts/tests/test-embedded-adapter.sh
 * RED must not be mere ["true"].
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
const TASK_ID = 'WP-12C';
const EXPECTED_EXPERIMENTAL_WEIGHT = 20;
const EMBEDDED_ADAPTER_MARKERS = Object.freeze([
  'app/src/main/java/com/motif/wallpaperengine/plugin/EngineAdapter.kt',
  'app/src/main/java/com/motif/wallpaperengine/plugin/EmbeddedEngineAdapter.kt',
  'app/src/main/java/com/motif/wallpaperengine/plugin/EmbeddedPreviewActivity.kt',
  'app/src/test/java/com/motif/wallpaperengine/plugin/EmbeddedEngineAdapterTest.kt',
  'app/src/test/java/com/motif/wallpaperengine/plugin/EmbeddedEngineAdapterNegativeTest.kt',
  'scripts/verify-embedded-adapter.sh',
  'scripts/tests/test-embedded-adapter.sh',
]);

function loadCatalog() {
  const raw = fs.readFileSync(catalogPath, 'utf8');
  return JSON.parse(raw);
}

function loadWp12cEntry() {
  const catalog = loadCatalog();
  const matches = (catalog.tasks || []).filter(
    (t) => t && t.taskId === TASK_ID,
  );
  if (matches.length !== 1) {
    return { ok: false, reason: 'missing_or_duplicate', count: matches.length };
  }
  return { ok: true, entry: matches[0] };
}

test('WP-12C RED: catalog file and tool exist', () => {
  assert.equal(fs.existsSync(catalogPath), true);
  assert.equal(fs.existsSync(catalogToolPath), true);
});

test('WP-12C RED: catalog has unique WP-12C task', () => {
  const loaded = loadWp12cEntry();
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  assert.equal(loaded.entry.taskId, TASK_ID);
});

test('WP-12C RED: experimental weight 20 separate from core', () => {
  const loaded = loadWp12cEntry();
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  assert.equal(loaded.entry.weight, EXPECTED_EXPERIMENTAL_WEIGHT);
  assert.equal(loaded.entry.path, 'experimental');
  assert.equal(loaded.entry.experimental, true);
  assert.equal(loaded.entry.deviceEvidence, false);
  assert.equal(loaded.entry.evidenceLevel, 'E2');
  assert.equal(loaded.entry.product, 'Wallpaper Engine');
});

test('WP-12C RED: dependsOn/requiredEffectiveDone include WP-12B chain', () => {
  const loaded = loadWp12cEntry();
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  const deps = loaded.entry.dependsOn || [];
  const required = loaded.entry.requiredEffectiveDone || [];
  assert.equal(deps.includes('WP-11C'), true);
  assert.equal(deps.includes('WP-12A'), true);
  assert.equal(deps.includes('WP-12B'), true);
  assert.equal(required.includes('WP-11C'), true);
  assert.equal(required.includes('WP-12A'), true);
  assert.equal(required.includes('WP-12B'), true);
  assert.equal(required.every((id) => deps.includes(id)), true);
});

test('WP-12C RED: scopeCheck lists embedded-adapter experimental files', () => {
  const loaded = loadWp12cEntry();
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  const scope = loaded.entry.scopeCheck || {};
  const exact = scope.exactFiles || [];
  assert.equal(scope.experimental, true);
  assert.equal(scope.path, 'experimental');
  assert.equal(scope.product, 'Wallpaper Engine');
  for (const marker of EMBEDDED_ADAPTER_MARKERS) {
    assert.equal(
      exact.includes(marker),
      true,
      `scopeCheck.exactFiles missing ${marker}`,
    );
  }
});

test('WP-12C RED: phaseCommands cover RED/GREEN/REFACTOR/VERIFY with harness argv', () => {
  const loaded = loadWp12cEntry();
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  const phases = loaded.entry.phaseCommands || {};
  for (const phase of ['RED', 'GREEN', 'REFACTOR', 'VERIFY']) {
    assert.equal(typeof phases[phase], 'object', `missing phase ${phase}`);
    assert.equal(phases[phase].commandId, `WP-12C-${phase}`);
    assert.ok(Array.isArray(phases[phase].argv));
  }

  const redArgv = phases.RED.argv;
  assert.notDeepEqual(redArgv, ['true'], 'RED argv must not be stub ["true"]');
  assert.ok(
    redArgv.includes('scripts/verify-embedded-adapter.sh'),
    'RED argv must include verify-embedded-adapter.sh',
  );
  assert.ok(
    redArgv.includes('adapter-negative'),
    'RED argv must include adapter-negative case',
  );

  const greenArgv = phases.GREEN.argv;
  assert.ok(
    greenArgv.includes('scripts/verify-embedded-adapter.sh'),
    'GREEN argv must include verify-embedded-adapter.sh',
  );
  assert.ok(
    greenArgv.includes('adapter-positive'),
    'GREEN argv must include adapter-positive case',
  );

  const verifyArgv = phases.VERIFY.argv;
  assert.ok(
    verifyArgv.includes('scripts/tests/test-embedded-adapter.sh'),
    'VERIFY argv must include test-embedded-adapter.sh',
  );

  assert.equal(loaded.entry.expectedExit.RED, 1);
  assert.equal(loaded.entry.expectedExit.GREEN, 0);
  assert.equal(loaded.entry.expectedExit.REFACTOR, 0);
  assert.equal(loaded.entry.expectedExit.VERIFY, 0);
  assert.equal(loaded.entry.failureSignaturePolicy.RED.required, true);
  assert.equal(loaded.entry.failureSignaturePolicy.RED.match, 'stderr');
});
