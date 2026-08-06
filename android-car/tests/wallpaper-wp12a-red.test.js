'use strict';

/**
 * WP-12A / RED-01 — experimental catalog capacity (runtime-import inventory).
 *
 * Catalog-only pin: proves WP-12A exists with experimental weight 25 and
 * runtime-import scope. Does NOT implement import scripts, evaluate_wp12a,
 * device evidence, or experimental EffectiveDone.
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
const TASK_ID = 'WP-12A';
const EXPECTED_EXPERIMENTAL_WEIGHT = 25;
const RUNTIME_IMPORT_MARKERS = Object.freeze([
  'runtime-import/manifest-map.schema.json',
  'scripts/import-official-runtime.sh',
  'scripts/verify-imported-runtime.sh',
  'scripts/tests/test-runtime-import.sh',
]);

function loadCatalog() {
  const raw = fs.readFileSync(catalogPath, 'utf8');
  return JSON.parse(raw);
}

function loadWp12aEntry() {
  const catalog = loadCatalog();
  const matches = (catalog.tasks || []).filter(
    (t) => t && t.taskId === TASK_ID,
  );
  if (matches.length !== 1) {
    return { ok: false, reason: 'missing_or_duplicate', count: matches.length };
  }
  return { ok: true, entry: matches[0] };
}

test('WP-12A RED: catalog file and tool exist', () => {
  assert.equal(fs.existsSync(catalogPath), true);
  assert.equal(fs.existsSync(catalogToolPath), true);
});

test('WP-12A RED: catalog has unique WP-12A task', () => {
  const loaded = loadWp12aEntry();
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  assert.equal(loaded.entry.taskId, TASK_ID);
});

test('WP-12A RED: experimental weight 25 separate from core', () => {
  const loaded = loadWp12aEntry();
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  assert.equal(loaded.entry.weight, EXPECTED_EXPERIMENTAL_WEIGHT);
  assert.equal(loaded.entry.path, 'experimental');
  assert.equal(loaded.entry.experimental, true);
  assert.equal(loaded.entry.deviceEvidence, false);
  assert.equal(loaded.entry.evidenceLevel, 'E2');
});

test('WP-12A RED: dependsOn/requiredEffectiveDone include WP-11C', () => {
  const loaded = loadWp12aEntry();
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  const deps = loaded.entry.dependsOn || [];
  const required = loaded.entry.requiredEffectiveDone || [];
  assert.equal(deps.includes('WP-11C'), true);
  assert.equal(required.includes('WP-11C'), true);
  assert.equal(required.every((id) => deps.includes(id)), true);
});

test('WP-12A RED: scopeCheck lists runtime-import experimental files', () => {
  const loaded = loadWp12aEntry();
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  const scope = loaded.entry.scopeCheck || {};
  const exact = scope.exactFiles || [];
  assert.equal(scope.experimental, true);
  assert.equal(scope.path, 'runtime-import/');
  for (const marker of RUNTIME_IMPORT_MARKERS) {
    assert.equal(
      exact.includes(marker),
      true,
      `scopeCheck.exactFiles missing ${marker}`,
    );
  }
});

test('WP-12A RED: phaseCommands stub covers RED/GREEN/REFACTOR/VERIFY', () => {
  const loaded = loadWp12aEntry();
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  const phases = loaded.entry.phaseCommands || {};
  for (const phase of ['RED', 'GREEN', 'REFACTOR', 'VERIFY']) {
    assert.equal(typeof phases[phase], 'object', `missing phase ${phase}`);
    assert.equal(phases[phase].commandId, `WP-12A-${phase}`);
    assert.ok(Array.isArray(phases[phase].argv));
  }
  assert.equal(loaded.entry.expectedExit.RED, 1);
  assert.equal(loaded.entry.expectedExit.GREEN, 0);
  assert.equal(loaded.entry.expectedExit.VERIFY, 0);
});
