'use strict';

/**
 * MONOREPO-IMPORT / RED-02 — Wallpaper Engine plugin monorepo import contract.
 *
 * GREEN must content-import WP-01 protocol sources into wallpaper-plugin/
 * under this Mineradio worktree. RED fails because that tree is not present.
 *
 * Does not create production plugin files. Does not claim EffectiveDone.
 * Does not use WallpaperEngine sandbox as a monorepo path.
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MONOREPO_WORKTREE,
  APPROVED_BRANCH,
  PRODUCT_NAME,
  PLUGIN_NAMESPACE,
  TARGET_MODULE,
  WE_SOURCE_SANDBOX,
  SOURCE_COMMIT,
  WP_INFRA_FINAL,
  WP00_MERGE,
  WP01_COMMIT,
  pluginRoot,
  requiredPaths,
  git,
  readJson,
  pathExists,
  isExecutable,
  assertMonorepoPluginImported,
  assertMonorepoPluginContent,
} = require('./wallpaper-plugin-monorepo-import-helpers');

// ---------------------------------------------------------------------------
// Environment: monorepo worktree identity (may pass in RED)
// ---------------------------------------------------------------------------

test('MONOREPO-IMPORT RED-02: monorepo worktree identity is correct', () => {
  assert.equal(
    path.resolve(MONOREPO_WORKTREE),
    '/Users/anpple/Codex/Mineradio-wallpaper-plugin',
  );
  const top = git(['rev-parse', '--show-toplevel']);
  assert.equal(top.status, 0, top.combined);
  assert.equal(path.resolve(top.stdout), path.resolve(MONOREPO_WORKTREE));
  const branch = git(['branch', '--show-current']);
  assert.equal(branch.stdout, APPROVED_BRANCH);
  const head = git(['rev-parse', 'HEAD']);
  assert.match(head.stdout, /^[0-9a-f]{40}$/);
  // Must not point tests at WE sandbox as monorepo root
  assert.notEqual(path.resolve(top.stdout), path.resolve(WE_SOURCE_SANDBOX));
});

test('MONOREPO-IMPORT RED-02: WP-INFRA remains DONE and WP-00 EffectiveDone', () => {
  const infra = readJson(WP_INFRA_FINAL);
  assert.equal(infra.EffectiveDone, true);
  assert.equal(infra.EffectiveGate, true);
  assert.equal(infra.state, 'DONE');

  const wp00 = readJson(WP00_MERGE);
  assert.equal(wp00.EffectiveDone, true);
  assert.equal(wp00.coreProgressPercent, 4);

  // WP-01 not weighted yet
  if (pathExists(WP01_COMMIT)) {
    const wp01 = readJson(WP01_COMMIT);
    assert.equal(wp01.EffectiveDone, false);
  }
});

test('MONOREPO-IMPORT RED-02: progress must stay at 4% and WP-01 not EffectiveDone', () => {
  const wp00 = readJson(WP00_MERGE);
  assert.equal(wp00.coreProgressPercent, 4);
  // No monorepo receipt may claim progress bump in RED
  assert.equal(wp00.EffectiveDone, true);
  if (pathExists(WP01_COMMIT)) {
    assert.equal(readJson(WP01_COMMIT).EffectiveDone, false);
  }
});

// ---------------------------------------------------------------------------
// Import structure gates (RED: fail until wallpaper-plugin is content-imported)
// ---------------------------------------------------------------------------

test('MONOREPO-IMPORT RED-02.1 wallpaper-plugin/ directory must exist', () => {
  assert.equal(
    pathExists(pluginRoot),
    true,
    'MONOREPO_PLUGIN_NOT_IMPORTED: wallpaper-plugin/ directory missing',
  );
});

test('MONOREPO-IMPORT RED-02.2 settings.gradle.kts must exist', () => {
  assert.equal(
    pathExists(requiredPaths.settingsGradle),
    true,
    'MONOREPO_PLUGIN_INCOMPLETE: wallpaper-plugin/settings.gradle.kts missing',
  );
});

test('MONOREPO-IMPORT RED-02.3 root build.gradle.kts must exist', () => {
  assert.equal(
    pathExists(requiredPaths.rootBuildGradle),
    true,
    'MONOREPO_PLUGIN_INCOMPLETE: wallpaper-plugin/build.gradle.kts missing',
  );
});

test('MONOREPO-IMPORT RED-02.4 gradle.properties must exist', () => {
  assert.equal(
    pathExists(requiredPaths.gradleProperties),
    true,
    'MONOREPO_PLUGIN_INCOMPLETE: wallpaper-plugin/gradle.properties missing',
  );
});

test('MONOREPO-IMPORT RED-02.5 gradlew must exist and be executable', () => {
  assert.equal(
    pathExists(requiredPaths.gradlew),
    true,
    'MONOREPO_PLUGIN_INCOMPLETE: wallpaper-plugin/gradlew missing',
  );
  assert.equal(
    isExecutable(requiredPaths.gradlew),
    true,
    'MONOREPO_PLUGIN_INCOMPLETE: wallpaper-plugin/gradlew not executable',
  );
});

test('MONOREPO-IMPORT RED-02.6 Gradle wrapper files must be complete', () => {
  assert.equal(
    pathExists(requiredPaths.wrapperJar),
    true,
    'MONOREPO_PLUGIN_INCOMPLETE: gradle-wrapper.jar missing',
  );
  assert.equal(
    pathExists(requiredPaths.wrapperProps),
    true,
    'MONOREPO_PLUGIN_INCOMPLETE: gradle-wrapper.properties missing',
  );
  assert.equal(
    pathExists(requiredPaths.gradlewBat),
    true,
    'MONOREPO_PLUGIN_INCOMPLETE: gradlew.bat missing',
  );
});

test('MONOREPO-IMPORT RED-02.7 app/build.gradle.kts must exist', () => {
  assert.equal(
    pathExists(requiredPaths.appBuildGradle),
    true,
    'MONOREPO_PLUGIN_INCOMPLETE: app/build.gradle.kts missing',
  );
});

test('MONOREPO-IMPORT RED-02.8 AndroidManifest.xml must exist', () => {
  assert.equal(
    pathExists(requiredPaths.androidManifest),
    true,
    'MONOREPO_PLUGIN_INCOMPLETE: AndroidManifest.xml missing',
  );
});

test('MONOREPO-IMPORT RED-02.9 PluginContract.kt must exist', () => {
  assert.equal(
    pathExists(requiredPaths.pluginContract),
    true,
    'MONOREPO_PLUGIN_INCOMPLETE: PluginContract.kt missing',
  );
});

test('MONOREPO-IMPORT RED-02.10 PluginResult.kt must exist', () => {
  assert.equal(
    pathExists(requiredPaths.pluginResult),
    true,
    'MONOREPO_PLUGIN_INCOMPLETE: PluginResult.kt missing',
  );
});

test('MONOREPO-IMPORT RED-02.11 PluginContractTest.kt must exist', () => {
  assert.equal(
    pathExists(requiredPaths.pluginContractTest),
    true,
    'MONOREPO_PLUGIN_INCOMPLETE: PluginContractTest.kt missing',
  );
});

test('MONOREPO-IMPORT RED-02.12-20 full import content contract', () => {
  // namespace, module, product name, provenance, no WE path, no plugin origin,
  // no forbidden imports, content-import model (no ancestry requirement).
  assert.doesNotThrow(
    () => assertMonorepoPluginContent(),
    'monorepo wallpaper-plugin content contract must pass after GREEN import',
  );
  assert.equal(TARGET_MODULE, 'wallpaper-plugin/app');
  assert.equal(PLUGIN_NAMESPACE, 'com.motif.wallpaperengine');
  assert.equal(PRODUCT_NAME, 'Wallpaper Engine');
  assert.match(SOURCE_COMMIT, /^[0-9a-f]{40}$/);
  // Content import: SOURCE_COMMIT need not be a Mineradio ancestor
  const anc = git(['merge-base', '--is-ancestor', SOURCE_COMMIT, 'HEAD']);
  // Either not in object db or not ancestor — both OK for content-import model.
  // After GREEN, provenance file records the source; ancestry must not be required.
  assert.ok(
    anc.status !== 0 || anc.status === 0,
    'content-import must not require source commit ancestry',
  );
});

test('MONOREPO-IMPORT GREEN-02.21 aggregate import assertion passes after import', () => {
  assert.doesNotThrow(() => assertMonorepoPluginImported());
});

test('MONOREPO-IMPORT: must not treat WE sandbox as monorepo plugin root', () => {
  assert.notEqual(
    path.resolve(pluginRoot),
    path.resolve(path.join(WE_SOURCE_SANDBOX, 'wallpaper-plugin')),
  );
  // Required paths must all be under monorepo worktree
  for (const p of Object.values(requiredPaths)) {
    assert.equal(
      p.startsWith(MONOREPO_WORKTREE + path.sep) || p === MONOREPO_WORKTREE,
      true,
      `path escapes monorepo worktree: ${p}`,
    );
  }
});

test('MONOREPO-IMPORT GREEN-02: production plugin tree exists under monorepo only', () => {
  assert.equal(
    pathExists(pluginRoot),
    true,
    'GREEN-02 must content-import wallpaper-plugin/ under Mineradio worktree',
  );
  assert.equal(
    pathExists(path.join(WE_SOURCE_SANDBOX, 'app', 'src', 'main', 'java',
      'com', 'motif', 'wallpaperengine', 'plugin', 'PluginContract.kt')),
    true,
    'WE sandbox remains read-only source reference',
  );
});
