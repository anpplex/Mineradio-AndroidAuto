'use strict';

/**
 * Task 6 RED contract suite: plugin detection + PackageInstaller install loop.
 *
 * Named path from WALLPAPER-PLUGIN-DEVELOPMENT Task 6 Files:
 *   Create: android-car/tests/wallpaper-plugin-installer.test.js
 *
 * RED: production capacity must fail closed with stable WP06_* signatures.
 * GREEN implements CarWallpaperPluginInstaller.smali, package queries,
 * REQUEST_INSTALL_PACKAGES, isInstalled/getPluginVersion, and real
 * installPlugin(contentUri) via PackageInstaller + one-shot action-token.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  WP06_SPEC_ACCEPTANCE,
  FailureReason,
  assertWp06InstallerSmaliPresent,
  assertWp06ManifestInstallCapacity,
  assertWp06BridgeMethodsCapacity,
  assertWp06InstallPluginCapacity,
  assertWp06ProductionSurfacesPresent,
  assertWp06FullProductionCapacity,
  listMissingProductionCreates,
  pathExists,
  installerSmaliPath,
  smaliBridgePath,
  readText,
  readPrerequisiteDone,
  liveAuthoritativeBaseSha,
  readTaskWorktreeIdentity,
} = require('./wallpaper-wp06-red-helpers');

test('installer RED: prerequisites WP-INFRA…WP-05 DONE (no self-injury)', () => {
  const prereq = readPrerequisiteDone();
  assert.equal(prereq.ok, true, JSON.stringify(prereq));
  assert.equal(prereq['WP-05'].EffectiveDone, true);
  assert.equal(prereq['WP-05'].state, 'DONE');
});

test('installer RED: live base from origin ls-remote', () => {
  const identity = readTaskWorktreeIdentity();
  assert.equal(identity.ok, true, JSON.stringify(identity));
  const live = liveAuthoritativeBaseSha();
  assert.match(live, /^[0-9a-f]{40}$/);
  assert.equal(identity.liveBaseSha, live);
});

test('installer RED: Task 6 Create surfaces missing → WP06_PRODUCTION_SURFACE_MISSING', () => {
  const r = assertWp06ProductionSurfacesPresent();
  const missing = listMissingProductionCreates();
  if (missing.length) {
    assert.equal(r.ok, false);
    assert.equal(r.failureReason, FailureReason.WP06_PRODUCTION_SURFACE_MISSING);
    assert.equal(r.EffectiveDone, false);
    assert.match(
      `${r.failureReason}: ${r.message}`,
      /WP06_PRODUCTION_SURFACE_MISSING/,
    );
  } else {
    assert.equal(r.ok, true);
    assert.notEqual(r.EffectiveDone, true);
  }
});

test('installer RED: CarWallpaperPluginInstaller.smali capacity', () => {
  const r = assertWp06InstallerSmaliPresent();
  if (!pathExists(installerSmaliPath)) {
    assert.equal(r.ok, false);
    assert.equal(r.failureReason, FailureReason.WP06_INSTALLER_SMALI_MISSING);
    assert.fail(
      `${FailureReason.WP06_INSTALLER_SMALI_MISSING}: ${installerSmaliPath}`,
    );
  }
  assert.equal(r.ok, true, `${r.failureReason}: ${r.message}`);
  const text = readText(installerSmaliPath);
  assert.match(text, /CarWallpaperPluginInstaller/);
  assert.ok(text.includes(WP06_SPEC_ACCEPTANCE.pluginPackage));
  assert.match(text, /PackageInstaller/);
});

test('installer RED: manifest REQUEST_INSTALL_PACKAGES + package queries', () => {
  const r = assertWp06ManifestInstallCapacity();
  if (!r.ok) {
    assert.match(
      String(r.failureReason),
      /WP06_REQUEST_INSTALL_PERM_MISSING|WP06_MANIFEST_QUERIES_MISSING/,
    );
    assert.fail(`${r.failureReason}: ${r.message}`);
  }
  assert.equal(r.ok, true);
});

test('installer RED: isInstalled + getPluginVersion + installPlugin bridge methods', () => {
  const r = assertWp06BridgeMethodsCapacity();
  if (!r.ok) {
    assert.equal(r.failureReason, FailureReason.WP06_BRIDGE_METHODS_MISSING);
    assert.fail(`${r.failureReason}: ${r.message}`);
  }
  assert.equal(r.ok, true);
  const bridge = readText(smaliBridgePath);
  assert.match(bridge, /isInstalled/);
  assert.match(bridge, /getPluginVersion/);
  assert.match(bridge, /installPlugin/);
});

test('installer RED: installPlugin must not silent-succeed; PackageInstaller path', () => {
  const r = assertWp06InstallPluginCapacity();
  if (!r.ok) {
    assert.equal(r.failureReason, FailureReason.WP06_INSTALL_PLUGIN_STUB);
    assert.fail(
      `${FailureReason.WP06_INSTALL_PLUGIN_STUB}: installPlugin must open ` +
        `PackageInstaller via action-token; never claim silent success. ` +
        `content:// only; MIME ${WP06_SPEC_ACCEPTANCE.apkMime}; ` +
        `codes 0/20/40/60 + SETTINGS_REQUIRED`,
    );
  }
  assert.equal(r.ok, true);
});

test('installer RED: stable WP06_* failure reason tokens are fixed', () => {
  assert.equal(
    FailureReason.WP06_INSTALLER_SMALI_MISSING,
    'WP06_INSTALLER_SMALI_MISSING',
  );
  assert.equal(
    FailureReason.WP06_INSTALL_PLUGIN_STUB,
    'WP06_INSTALL_PLUGIN_STUB',
  );
  assert.equal(
    FailureReason.WP06_MANIFEST_QUERIES_MISSING,
    'WP06_MANIFEST_QUERIES_MISSING',
  );
  assert.equal(
    FailureReason.WP06_REQUEST_INSTALL_PERM_MISSING,
    'WP06_REQUEST_INSTALL_PERM_MISSING',
  );
});

test('installer RED: full URI/install capacity aggregate fail-closed', () => {
  const r = assertWp06FullProductionCapacity();
  if (!r.ok) {
    assert.match(String(r.failureReason), /^WP06_/);
    assert.equal(r.EffectiveDone, false);
    assert.fail(`${r.failureReason}: ${r.message}`);
  }
  assert.equal(r.ok, true);
  assert.notEqual(r.EffectiveDone, true);
});

test('installer GREEN target: assertInstallFixtures package/MIME/token (capacity)', () => {
  // GREEN will export assertInstallFixtures from contract; RED pins absence.
  let contract;
  try {
    // eslint-disable-next-line import/no-dynamic-require, global-require
    contract = require('../scripts/wallpaper-plugin-contract.js');
  } catch (err) {
    assert.fail(`contract load failed: ${err}`);
  }
  if (typeof contract.assertInstallFixtures !== 'function') {
    assert.fail(
      'WP06_INSTALL_FIXTURES_MISSING: contract.assertInstallFixtures not implemented ' +
        '(GREEN: package name, APK MIME, content:// only, action-token INSTALL_PLUGIN, ' +
        'result codes 0/20/40/60, SETTINGS_REQUIRED, no silent success)',
    );
  }
  const result = contract.assertInstallFixtures();
  assert.equal(result.ok, true, JSON.stringify(result));
});
