'use strict';

/**
 * Task 5 RED contract suite: Mineradio FileProvider + importMpkg(contentUri)
 * Provider / URI lifecycle fixtures.
 *
 * Named path from WALLPAPER-PLUGIN-DEVELOPMENT Task 5 Files:
 *   Create: android-car/tests/wallpaper-plugin-file-provider.test.js
 *
 * RED: production capacity must fail closed with stable WP05_* signatures.
 * GREEN implements paths XML, stager Smali, manifest provider, patcher wire,
 * and real importMpkg (content:// only, grant/revoke, 24h cleanup).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  WP05_SPEC_ACCEPTANCE,
  FailureReason,
  assertWp05PathsXmlCapacity,
  assertWp05StagerSmaliPresent,
  assertWp05ManifestProviderCapacity,
  assertWp05PatcherPathsWire,
  assertWp05ImportMpkgCapacity,
  assertWp05ProductionSurfacesPresent,
  assertWp05FullProductionCapacity,
  listMissingProductionCreates,
  pathExists,
  pathsXmlPath,
  stagerSmaliPath,
  smaliBridgePath,
  readText,
  readPrerequisiteDone,
  liveAuthoritativeBaseSha,
  readTaskWorktreeIdentity,
} = require('./wallpaper-wp05-red-helpers');

test('file-provider RED: prerequisites WP-INFRA…WP-04 DONE (no self-injury)', () => {
  const prereq = readPrerequisiteDone();
  assert.equal(prereq.ok, true, JSON.stringify(prereq));
  assert.equal(prereq['WP-04'].EffectiveDone, true);
});

test('file-provider RED: live base from origin ls-remote', () => {
  const identity = readTaskWorktreeIdentity();
  assert.equal(identity.ok, true, JSON.stringify(identity));
  const live = liveAuthoritativeBaseSha();
  assert.match(live, /^[0-9a-f]{40}$/);
  assert.equal(identity.liveBaseSha, live);
});

test('file-provider RED: Task 5 Create surfaces missing → WP05_PRODUCTION_SURFACE_MISSING', () => {
  const r = assertWp05ProductionSurfacesPresent();
  const missing = listMissingProductionCreates();
  if (missing.length) {
    assert.equal(r.ok, false);
    assert.equal(r.failureReason, FailureReason.WP05_PRODUCTION_SURFACE_MISSING);
    assert.equal(r.EffectiveDone, false);
    // Stable signature string for receipt matching.
    assert.match(
      `${r.failureReason}: ${r.message}`,
      /WP05_PRODUCTION_SURFACE_MISSING/,
    );
  } else {
    assert.equal(r.ok, true);
    assert.notEqual(r.EffectiveDone, true);
  }
});

test('file-provider RED: paths XML cache-path wallpaper_plugin_stage only', () => {
  const r = assertWp05PathsXmlCapacity();
  if (!pathExists(pathsXmlPath())) {
    assert.equal(r.ok, false);
    assert.equal(r.failureReason, FailureReason.WP05_PATHS_XML_MISSING);
    assert.fail(
      `${FailureReason.WP05_PATHS_XML_MISSING}: ` +
        `expected ${pathsXmlPath()} with cache-path name=` +
        `${WP05_SPEC_ACCEPTANCE.cachePathName}`,
    );
  }
  assert.equal(r.ok, true, `${r.failureReason}: ${r.message}`);
  const text = readText(pathsXmlPath());
  assert.match(text, /cache-path/);
  assert.ok(text.includes(WP05_SPEC_ACCEPTANCE.cachePathName));
  assert.ok(text.includes(WP05_SPEC_ACCEPTANCE.cachePathDir));
  assert.equal(/<(files-path|external-path|root-path)\b/.test(text), false);
});

test('file-provider RED: CarWallpaperMpkgStager.smali capacity', () => {
  const r = assertWp05StagerSmaliPresent();
  if (!pathExists(stagerSmaliPath())) {
    assert.equal(r.ok, false);
    assert.equal(r.failureReason, FailureReason.WP05_STAGER_SMALI_MISSING);
    assert.fail(
      `${FailureReason.WP05_STAGER_SMALI_MISSING}: ${stagerSmaliPath()}`,
    );
  }
  assert.equal(r.ok, true, `${r.failureReason}: ${r.message}`);
});

test('file-provider RED: Manifest Provider authority com.mineradio.app.wallpaperplugin.files', () => {
  const r = assertWp05ManifestProviderCapacity();
  assert.equal(
    WP05_SPEC_ACCEPTANCE.fileProviderAuthority,
    'com.mineradio.app.wallpaperplugin.files',
  );
  assert.equal(
    WP05_SPEC_ACCEPTANCE.fileProviderClass,
    'androidx.core.content.FileProvider',
  );
  assert.equal(
    r.ok,
    true,
    `${FailureReason.WP05_MANIFEST_PROVIDER_MISSING}: ${r.message}`,
  );
});

test('file-provider RED: patcher copies wallpaper_plugin_paths.xml → res/xml/', () => {
  const r = assertWp05PatcherPathsWire();
  assert.equal(
    r.ok,
    true,
    `${FailureReason.WP05_PATCHER_PATHS_WIRE_MISSING}: ${r.message}`,
  );
});

test('file-provider RED: importMpkg content:// only; reject file:// / absolute path', () => {
  const r = assertWp05ImportMpkgCapacity();
  assert.equal(WP05_SPEC_ACCEPTANCE.jsMethod, 'importMpkg');
  assert.equal(WP05_SPEC_ACCEPTANCE.providerMethod, 'import_mpkg');
  assert.equal(WP05_SPEC_ACCEPTANCE.contentSchemeOnly, 'content://');
  assert.deepEqual(WP05_SPEC_ACCEPTANCE.forbiddenSchemes, ['file://']);
  assert.equal(WP05_SPEC_ACCEPTANCE.forbidAbsolutePaths, true);
  assert.equal(
    WP05_SPEC_ACCEPTANCE.grantPluginPackage,
    'com.motif.wallpaperengine',
  );
  assert.equal(WP05_SPEC_ACCEPTANCE.cleanupWindowHours, 24);
  assert.equal(WP05_SPEC_ACCEPTANCE.sourceConsumedRevoke, true);

  // Current WP-04 stub must not count as capacity.
  assert.equal(
    r.ok,
    true,
    `${FailureReason.WP05_IMPORT_MPKG_CAPACITY_MISSING}: ${r.message}`,
  );

  if (pathExists(smaliBridgePath())) {
    const text = readText(smaliBridgePath());
    assert.ok(text.includes('importMpkg'));
  }
});

test('file-provider RED: full URI hop capacity aggregate fail-closed', () => {
  const r = assertWp05FullProductionCapacity();
  assert.notEqual(r.EffectiveDone, true);
  assert.equal(
    r.ok,
    true,
    `${r.failureReason || FailureReason.WP05_PRODUCTION_SURFACE_MISSING}: ${r.message}`,
  );
});

test('file-provider RED: stable WP05_* failure reason tokens are fixed', () => {
  assert.equal(
    FailureReason.WP05_PRODUCTION_SURFACE_MISSING,
    'WP05_PRODUCTION_SURFACE_MISSING',
  );
  assert.equal(FailureReason.WP05_PATHS_XML_MISSING, 'WP05_PATHS_XML_MISSING');
  assert.equal(FailureReason.WP05_STAGER_SMALI_MISSING, 'WP05_STAGER_SMALI_MISSING');
  assert.equal(
    FailureReason.WP05_MANIFEST_PROVIDER_MISSING,
    'WP05_MANIFEST_PROVIDER_MISSING',
  );
  assert.equal(
    FailureReason.WP05_PATCHER_PATHS_WIRE_MISSING,
    'WP05_PATCHER_PATHS_WIRE_MISSING',
  );
  assert.equal(
    FailureReason.WP05_IMPORT_MPKG_CAPACITY_MISSING,
    'WP05_IMPORT_MPKG_CAPACITY_MISSING',
  );
  assert.equal(FailureReason.WP05_CATALOG_ENTRY_MISSING, 'WP05_CATALOG_ENTRY_MISSING');
});

// ---------------------------------------------------------------------------
// GREEN behavioral fixtures (contract JS harness mirrors Smali stager rules)
// ---------------------------------------------------------------------------

test('file-provider GREEN: assertFileProviderImportFixtures two-hop / grant / 24h', () => {
  const contract = require('../scripts/wallpaper-plugin-contract.js');
  assert.equal(
    contract.fileProviderAuthority,
    'com.mineradio.app.wallpaperplugin.files',
  );
  assert.equal(contract.stageCacheDir, 'wallpaper_plugin_stage/');
  assert.equal(contract.cleanupWindowMs, 24 * 60 * 60 * 1000);
  const r = contract.assertFileProviderImportFixtures();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.twoHop, true);
  assert.equal(r.grantRevoke, true);
  assert.equal(r.contentSchemeOnly, true);
  assert.notEqual(r.EffectiveDone, true);
});

test('file-provider REFACTOR: JS/Smali FileProvider mirror + pure URI helpers', () => {
  const contract = require('../scripts/wallpaper-plugin-contract.js');
  const mirror = contract.assertFileProviderSmaliMirror();
  assert.equal(mirror.ok, true, JSON.stringify(mirror));
  assert.equal(contract.isContentUri('content://x/y'), true);
  assert.equal(contract.isForbiddenSourceUri('file:///tmp/a'), true);
  assert.equal(contract.isForbiddenSourceUri('content://ok/../esc'), true);
  assert.equal(contract.stageKeyForOperation('op-1'), 'wallpaper_plugin_stage/op-1.mpkg');
  assert.match(
    contract.stagedContentUriForOperation('op-1'),
    /^content:\/\/com\.mineradio\.app\.wallpaperplugin\.files\//,
  );
});

test('file-provider GREEN: reject file:// http(s) absolute and path traversal', () => {
  const contract = require('../scripts/wallpaper-plugin-contract.js');
  const s = contract.createFileProviderImportStager();
  for (const bad of [
    'file:///data/a.mpkg',
    'http://evil/x',
    'https://evil/x',
    '/sdcard/a.mpkg',
    'content://ok/../escape',
  ]) {
    const r = s.importMpkg('op-x', bad);
    assert.equal(r.ok, false, bad);
  }
  const good = s.importMpkg('op-ok', 'content://com.android.providers.media.documents/document/42');
  assert.equal(good.ok, true);
  assert.match(good.stagedUri, /^content:\/\/com\.mineradio\.app\.wallpaperplugin\.files\//);
  assert.equal(good.path, undefined);
});

test('file-provider GREEN: patcher wires paths XML + stager into decoded tree', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const pathMod = require('node:path');
  const patcher = require('../scripts/patch-wallpaper-plugin-bridge.js');
  const tmp = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'wp05-fp-'));
  fs.mkdirSync(pathMod.join(tmp, 'smali_classes3', 'com', 'mineradio', 'app'), {
    recursive: true,
  });
  const act = pathMod.join(
    tmp,
    'smali_classes3',
    'com',
    'mineradio',
    'app',
    'LandscapeWebActivity.smali',
  );
  fs.writeFileSync(
    act,
    '.class public LLandscapeWebActivity;\n.method public onCreate()V\n    const-string v1, "KeepApp"\n\n    invoke-virtual {v0, p1, v1}, Landroid/webkit/WebView;->addJavascriptInterface(Ljava/lang/Object;Ljava/lang/String;)V\n.end method\n',
  );
  const r = patcher.patchWallpaperPluginBridge(tmp);
  assert.equal(fs.existsSync(r.wallpaperPluginPathsXml.dest), true);
  assert.equal(fs.existsSync(r.stagerSmali.dest), true);
  assert.equal(fs.existsSync(r.bridgeSmali.dest), true);
  const pathsText = fs.readFileSync(r.wallpaperPluginPathsXml.dest, 'utf8');
  assert.match(pathsText, /cache-path/);
  assert.ok(pathsText.includes('wallpaper_plugin_stage'));
  assert.equal(/<(files-path|external-path|root-path)\b/.test(pathsText), false);
  // Idempotent second run
  const r2 = patcher.patchWallpaperPluginBridge(tmp);
  assert.equal(fs.existsSync(r2.wallpaperPluginPathsXml.dest), true);
});
