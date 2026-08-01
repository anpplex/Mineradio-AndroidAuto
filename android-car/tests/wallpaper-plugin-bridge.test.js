'use strict';

/**
 * WP-04 GREEN + REFACTOR unit tests: contract, action-token registry,
 * trusted WebView policy, patcher idempotency / fail-closed, build wire,
 * and JS/Smali contract mirror (single protocol truth).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const contract = require('../scripts/wallpaper-plugin-contract.js');
const {
  patchWallpaperPluginBridge,
  assertTrustedWallpaperBridgePolicy,
  assertJsSmaliContractMirror,
  canMountBridge,
  shouldStripBridge,
  openExternalLogin,
  isTrustedLocalAssetUrl,
  JS_INTERFACE,
  HOOK_MARKER,
  buildAttachSnippet,
} = require('../scripts/patch-wallpaper-plugin-bridge.js');

function makeDecodedFixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp04-bridge-'));
  const actDir = path.join(root, 'smali_classes3', 'com', 'mineradio', 'app');
  fs.mkdirSync(actDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'smali'), { recursive: true });

  const keepApp = options.omitKeepApp
    ? `
.method public final setupWeb()V
    .locals 3

    return-void
.end method
`
    : `
.method public final setupWeb()V
    .locals 3

    const-string v1, "KeepApp"

    invoke-virtual {v0, p1, v1}, Landroid/webkit/WebView;->addJavascriptInterface(Ljava/lang/Object;Ljava/lang/String;)V

    return-void
.end method
`;

  fs.writeFileSync(
    path.join(actDir, 'LandscapeWebActivity.smali'),
    `.class public final Lcom/mineradio/app/LandscapeWebActivity;
.super Landroid/app/Activity;
${keepApp}
`,
  );
  return root;
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

test('WP-04 contract exports frozen protocol 1 surface', () => {
  assert.equal(contract.protocolVersion, 1);
  assert.equal(contract.authority, 'com.motif.wallpaperengine.control');
  assert.equal(contract.pluginPackage, 'com.motif.wallpaperengine');
  assert.equal(contract.enginePackage, 'io.wallpaperengine.weclient');
  assert.deepEqual(
    [...contract.methods],
    [
      'ping',
      'status',
      'renew_action',
      'import_mpkg',
      'open_library',
      'apply_current',
      'next',
      'previous',
      'stop',
      'diagnostics',
    ],
  );
  assert.ok(contract.jsBridgeMethods.includes('confirmUserAction'));
  assert.ok(contract.jsBridgeMethods.includes('installPlugin'));
  assert.ok(contract.jsBridgeMethods.includes('renewAction'));
  assert.equal(contract.jsInterfaceName, 'WallpaperPlugin');
  assert.equal(contract.actionRegistryMaxEntries, 16);
  assert.equal(contract.actionTokenTtlMinutes, 10);
  assert.equal(contract.actionTokenIsNotUserGestureProof, true);
});

test('WP-04 REFACTOR: patcher JS_INTERFACE is sourced from contract only', () => {
  assert.equal(JS_INTERFACE, contract.jsInterfaceName);
  assert.equal(JS_INTERFACE, 'WallpaperPlugin');
  const snippet = buildAttachSnippet();
  assert.match(snippet, new RegExp(`"${contract.jsInterfaceName}"`));
  assert.match(snippet, /CarWallpaperPluginBridge/);
});

test('WP-04 REFACTOR: assertJsSmaliContractMirror — single protocol truth, no second SM', () => {
  const fromContract = contract.assertJsSmaliContractMirror();
  assert.equal(fromContract.ok, true, JSON.stringify(fromContract));
  assert.equal(fromContract.source, 'wallpaper-plugin-contract.js');
  assert.equal(fromContract.noSecondStateMachine, true);
  assert.equal(fromContract.protocolVersion, 1);
  assert.equal(fromContract.jsInterfaceName, 'WallpaperPlugin');
  assert.equal(fromContract.actionRegistryMaxEntries, 16);

  const fromPatcher = assertJsSmaliContractMirror();
  assert.equal(fromPatcher.ok, true, JSON.stringify(fromPatcher));
  assert.equal(fromPatcher.smaliPath, fromContract.smaliPath);
});

test('WP-04 contract rejects unknown method and missing fields fail-closed', () => {
  const unknown = contract.validateProviderCall('explode', { protocolVersion: 1 });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.failureReason, 'UNKNOWN_METHOD');

  const missing = contract.validateProviderCall('import_mpkg', {
    protocolVersion: 1,
    operationId: 'op',
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.failureReason, 'MISSING_SOURCE_URI');

  const proto = contract.validateProviderCall('ping', { protocolVersion: 99 });
  assert.equal(proto.ok, false);
  assert.equal(proto.failureReason, 'PROTOCOL_MISMATCH');

  const ok = contract.validateProviderCall('ping', { protocolVersion: 1 });
  assert.equal(ok.ok, true);
});

test('WP-04 mapJsBridgeMethod maps renewAction → renew_action; local-only install/confirm', () => {
  const renew = contract.mapJsBridgeMethod('renewAction');
  assert.equal(renew.ok, true);
  assert.equal(renew.providerMethod, 'renew_action');
  assert.equal(renew.localOnly, false);

  const install = contract.mapJsBridgeMethod('installPlugin');
  assert.equal(install.ok, true);
  assert.equal(install.localOnly, true);

  const bad = contract.mapJsBridgeMethod('hack');
  assert.equal(bad.ok, false);
});

test('WP-04 pluginCallFailedResult never leaks stacks/paths', () => {
  const r = contract.pluginCallFailedResult();
  assert.equal(r.code, 60);
  assert.equal(r.message, 'PLUGIN_CALL_FAILED');
  assert.equal(r.operationState, 'FAILED');
  assert.ok(!JSON.stringify(r).includes('Error'));
  assert.ok(!JSON.stringify(r).includes('/Users'));
});

// ---------------------------------------------------------------------------
// Action-token registry
// ---------------------------------------------------------------------------

test('WP-04 action-token registry: TTL, one-shot, concurrency, distinctions', () => {
  const probe = contract.assertActionTokenRegistry({ maxEntries: 16, ttlMinutes: 10 });
  assert.equal(probe.ok, true, JSON.stringify(probe));
  assert.equal(probe.oneShot, true);
  assert.equal(probe.concurrentUnique, true);
  assert.equal(probe.pendingIntentNotJson, true);
  assert.equal(probe.notUserGestureProof, true);
  assert.equal(probe.statusDoesNotImplicitRenew, true);
});

test('WP-04 action-token registry: caller cannot inject verified state', () => {
  const reg = contract.createActionTokenRegistry({
    maxEntries: 16,
    ttlMs: 600_000,
    now: () => 1000,
  });
  const pi = { kind: 'PendingIntent', id: 'x' };
  const r = reg.register({
    operationId: 'op',
    actionEpoch: 1,
    pendingIntent: pi,
    now: 1000,
  });
  // Attempt to forge by writing consumed set externally is not exposed.
  assert.equal(typeof reg._consumed.add, 'function');
  // Public consume of unknown with "verified" option must still fail.
  const forged = reg.consume('not-a-real-token', { verified: true, now: 1000 });
  assert.equal(forged.ok, false);
  assert.equal(forged.failureReason, 'UNKNOWN_TOKEN');

  const ok = reg.consume(r.actionToken, { now: 1000 });
  assert.equal(ok.ok, true);
  const replay = reg.consume(r.actionToken, { now: 1000, verified: true });
  assert.equal(replay.ok, false);
  assert.equal(replay.failureReason, 'ALREADY_USED');
});

// ---------------------------------------------------------------------------
// Trusted WebView policy
// ---------------------------------------------------------------------------

test('WP-04 TrustedWallpaperBridgePolicy fixtures pass', () => {
  const r = assertTrustedWallpaperBridgePolicy();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.jsInterfaceName, 'WallpaperPlugin');
  assert.equal(r.topLevelFrameOnly, true);
  assert.equal(r.externalLoginWithoutBridge, true);
  assert.equal(r.nonAllowlistFailClosed, true);
});

test('WP-04 trusted policy rejects arbitrary WebView URL strings and wildcards', () => {
  assert.equal(isTrustedLocalAssetUrl('https://evil.example/'), false);
  assert.equal(isTrustedLocalAssetUrl('file:///android_asset/*'), false);
  assert.equal(isTrustedLocalAssetUrl('file:///android_asset/car/index.html'), true);

  const iframe = canMountBridge({
    url: 'file:///android_asset/car/index.html',
    isTopFrame: false,
    pageNonce: 'n',
    expectedNonce: 'n',
  });
  assert.equal(iframe.mount, false);

  const strip = shouldStripBridge({ isPageStarted: true });
  assert.equal(strip.strip, true);
  assert.equal(strip.removeJavascriptInterface, JS_INTERFACE);

  const login = openExternalLogin('https://y.qq.com/login');
  assert.equal(login.ok, true);
  assert.equal(login.registerBridge, false);
});

// ---------------------------------------------------------------------------
// Patcher
// ---------------------------------------------------------------------------

test('WP-04 patcher copies Smali, registers WallpaperPlugin after KeepApp, idempotent', () => {
  const root = makeDecodedFixture();
  const once = patchWallpaperPluginBridge(root);
  assert.equal(once.jsInterface, 'WallpaperPlugin');
  assert.equal(once.landscapeWebActivity.changed, true);

  const bridge = path.join(
    root,
    'smali_classes3',
    'com',
    'mineradio',
    'app',
    'car',
    'CarWallpaperPluginBridge.smali',
  );
  assert.ok(fs.existsSync(bridge));
  const bridgeSrc = fs.readFileSync(bridge, 'utf8');
  assert.match(bridgeSrc, /WallpaperPlugin/);
  assert.match(bridgeSrc, /confirmUserAction/);
  assert.match(bridgeSrc, /renewAction/);
  assert.match(bridgeSrc, /ACTION_TOKEN_EXPIRED|actionTokenExpired/);
  assert.match(bridgeSrc, /ConcurrentHashMap/);
  assert.match(bridgeSrc, /pendingIntentJson/);
  assert.match(bridgeSrc, /statusDoesNotImplicitRenew|status\(/);

  const actSrc = fs.readFileSync(once.landscapeWebActivity.file, 'utf8');
  assert.match(actSrc, /KeepApp/);
  assert.match(actSrc, /WallpaperPlugin/);
  assert.match(actSrc, /CarWallpaperPluginBridge/);
  // WallpaperPlugin must appear after KeepApp
  const keepIdx = actSrc.indexOf('KeepApp');
  const wpIdx = actSrc.indexOf('WallpaperPlugin');
  assert.ok(keepIdx >= 0 && wpIdx > keepIdx);

  const twice = patchWallpaperPluginBridge(root);
  assert.equal(twice.landscapeWebActivity.changed, false);
});

test('WP-04 patcher fails closed without KeepApp injection point', () => {
  const root = makeDecodedFixture({ omitKeepApp: true });
  assert.throws(() => patchWallpaperPluginBridge(root), /KeepApp|injection point|fail-closed/i);
});

test('WP-04 patcher fails closed on missing/invalid decoded tree', () => {
  assert.throws(() => patchWallpaperPluginBridge('/tmp/wp04-does-not-exist-xyz'), /not found/i);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'wp04-empty-'));
  assert.throws(() => patchWallpaperPluginBridge(empty), /smali/i);
});

// ---------------------------------------------------------------------------
// Smali source presence
// ---------------------------------------------------------------------------

test('WP-04 production Smali bridge file exists with contract markers', () => {
  const smali = path.join(
    __dirname,
    '../scripts/smali/com/mineradio/app/car/CarWallpaperPluginBridge.smali',
  );
  assert.ok(fs.existsSync(smali));
  const text = fs.readFileSync(smali, 'utf8');
  assert.match(text, /Lcom\/mineradio\/app\/car\/CarWallpaperPluginBridge;/);
  assert.match(text, /JavascriptInterface/);
  for (const m of [
    'ping',
    'status',
    'renewAction',
    'importMpkg',
    'installPlugin',
    'confirmUserAction',
    'openLibrary',
    'applyCurrent',
    'next',
    'previous',
    'stop',
    'diagnostics',
  ]) {
    assert.match(text, new RegExp(m));
  }
  assert.match(text, /PLUGIN_CALL_FAILED/);
  assert.match(text, /com\.motif\.wallpaperengine\.control/);
});

// ---------------------------------------------------------------------------
// Build wire
// ---------------------------------------------------------------------------

test('WP-04 build-car-apk.sh wires patch-wallpaper-plugin-bridge after audio-focus, before apktool b', () => {
  const buildScript = fs.readFileSync(
    path.join(__dirname, '../scripts/build-car-apk.sh'),
    'utf8',
  );
  assert.match(buildScript, /patch-wallpaper-plugin-bridge\.js/);
  const audioIdx = buildScript.indexOf('patch-audio-focus-bridge.js');
  const wpIdx = buildScript.indexOf('patch-wallpaper-plugin-bridge.js');
  const buildIdx = buildScript.indexOf('apktool') >= 0
    ? buildScript.search(/apktool.*\bb\b|jar "\$APKTOOL_JAR" b/)
    : buildScript.indexOf('"$JAVA_BIN" -jar "$APKTOOL_JAR" b');
  assert.ok(audioIdx >= 0, 'audio-focus wire missing');
  assert.ok(wpIdx > audioIdx, 'wallpaper bridge must follow audio-focus');
  assert.ok(buildIdx > wpIdx, 'wallpaper bridge must precede apktool build');
  // Must not hardcode real user APK/JKS secrets into the wire line itself.
  const wireLine = buildScript
    .split('\n')
    .find((l) => l.includes('patch-wallpaper-plugin-bridge.js'));
  assert.ok(wireLine);
  assert.ok(!/\/Users\//.test(wireLine));
  assert.ok(!/\.jks/.test(wireLine));
});
