'use strict';

/**
 * WP-12B / RED-01 — experimental catalog capacity (arm64 native dependency closure).
 *
 * Catalog-only pin: proves WP-12B exists with experimental weight 20 and
 * native-libs scope. Does NOT implement native-libs scripts, evaluate_wp12b,
 * device evidence, or experimental EffectiveDone.
 *
 * phaseCommands are argv stubs ["true"] until plugin lands:
 *   scripts/verify-native-libs.sh, scripts/tests/test-native-libs.sh,
 *   fixtures native-missing-needed.json / native-wrong-abi.json.
 * Wire later (mirror WP-12A harness upgrade) to:
 *   RED: bash scripts/verify-native-libs.sh --inventory scripts/tests/fixtures/native-missing-needed.json --mode negative-missing-needed
 *   GREEN/VERIFY: bash scripts/tests/test-native-libs.sh
 *   REFACTOR: true
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
const TASK_ID = 'WP-12B';
const EXPECTED_EXPERIMENTAL_WEIGHT = 20;
const NATIVE_LIBS_MARKERS = Object.freeze([
  'runtime-import/native-libs.schema.json',
  'scripts/import-native-libs.sh',
  'scripts/verify-native-libs.sh',
  'scripts/tests/test-native-libs.sh',
  'scripts/tests/fixtures/native-missing-needed.json',
  'scripts/tests/fixtures/native-wrong-abi.json',
]);

function loadCatalog() {
  const raw = fs.readFileSync(catalogPath, 'utf8');
  return JSON.parse(raw);
}

function loadWp12bEntry() {
  const catalog = loadCatalog();
  const matches = (catalog.tasks || []).filter(
    (t) => t && t.taskId === TASK_ID,
  );
  if (matches.length !== 1) {
    return { ok: false, reason: 'missing_or_duplicate', count: matches.length };
  }
  return { ok: true, entry: matches[0] };
}

test('WP-12B RED: catalog file and tool exist', () => {
  assert.equal(fs.existsSync(catalogPath), true);
  assert.equal(fs.existsSync(catalogToolPath), true);
});

test('WP-12B RED: catalog has unique WP-12B task', () => {
  const loaded = loadWp12bEntry();
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  assert.equal(loaded.entry.taskId, TASK_ID);
});

test('WP-12B RED: experimental weight 20 separate from core', () => {
  const loaded = loadWp12bEntry();
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  assert.equal(loaded.entry.weight, EXPECTED_EXPERIMENTAL_WEIGHT);
  assert.equal(loaded.entry.path, 'experimental');
  assert.equal(loaded.entry.experimental, true);
  assert.equal(loaded.entry.deviceEvidence, false);
  assert.equal(loaded.entry.evidenceLevel, 'E2');
  assert.equal(loaded.entry.product, 'Wallpaper Engine');
});

test('WP-12B RED: dependsOn/requiredEffectiveDone include WP-12A chain', () => {
  const loaded = loadWp12bEntry();
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  const deps = loaded.entry.dependsOn || [];
  const required = loaded.entry.requiredEffectiveDone || [];
  assert.equal(deps.includes('WP-11C'), true);
  assert.equal(deps.includes('WP-12A'), true);
  assert.equal(required.includes('WP-11C'), true);
  assert.equal(required.includes('WP-12A'), true);
  assert.equal(required.every((id) => deps.includes(id)), true);
});

test('WP-12B RED: scopeCheck lists native-libs experimental files', () => {
  const loaded = loadWp12bEntry();
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  const scope = loaded.entry.scopeCheck || {};
  const exact = scope.exactFiles || [];
  assert.equal(scope.experimental, true);
  assert.equal(scope.path, 'runtime-import/');
  assert.equal(scope.product, 'Wallpaper Engine');
  for (const marker of NATIVE_LIBS_MARKERS) {
    assert.equal(
      exact.includes(marker),
      true,
      `scopeCheck.exactFiles missing ${marker}`,
    );
  }
});

test('WP-12B RED: phaseCommands structure covers RED/GREEN/REFACTOR/VERIFY', () => {
  const loaded = loadWp12bEntry();
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  const phases = loaded.entry.phaseCommands || {};
  for (const phase of ['RED', 'GREEN', 'REFACTOR', 'VERIFY']) {
    assert.equal(typeof phases[phase], 'object', `missing phase ${phase}`);
    assert.equal(phases[phase].commandId, `WP-12B-${phase}`);
    assert.ok(Array.isArray(phases[phase].argv));
  }
  // Plugin native-libs harness not landed yet — stubs only (see file header).
  // When wired: RED must not be ["true"] and must include verify-native-libs.sh.
  assert.equal(loaded.entry.expectedExit.RED, 1);
  assert.equal(loaded.entry.expectedExit.GREEN, 0);
  assert.equal(loaded.entry.expectedExit.VERIFY, 0);
});
