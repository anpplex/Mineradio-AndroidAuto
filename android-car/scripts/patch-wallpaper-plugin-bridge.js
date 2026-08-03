#!/usr/bin/env node
'use strict';

/**
 * WP-04: inject CarWallpaperPluginBridge Smali + register WallpaperPlugin
 * JS interface after KeepApp in LandscapeWebActivity.
 *
 * Protocol constants come only from wallpaper-plugin-contract.js (REFACTOR).
 * Also exports TrustedWallpaperBridgePolicy fixtures (allowlist local asset URL,
 * top-level frame, page nonce; strip on nav; external login without bridge).
 *
 * Fail-closed: missing injection point, invalid tree, path traversal → throw.
 * Idempotent: re-run is a no-op when already patched.
 * Atomic writes: write temp then rename.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const contract = require('./wallpaper-plugin-contract.js');

const BRIDGE_CLASS = 'CarWallpaperPluginBridge';
/** Single source: wallpaper-plugin-contract.js — never hardcode a second name. */
const JS_INTERFACE = contract.jsInterfaceName;
const HOOK_MARKER = 'CarWallpaperPluginBridge';

/**
 * Attach WallpaperPlugin after KeepApp.
 *
 * IMPORTANT: use high locals (v11/v12) — v2/v3 are live later in onCreate
 * (booleans / ViewGroup.addView). Clobbering them causes VerifyError.
 * Caller must ensure method .locals >= 13 so v11/v12 are not parameters.
 */
function buildAttachSnippet(jsInterfaceName = JS_INTERFACE) {
  return `
    new-instance v11, Lcom/mineradio/app/car/CarWallpaperPluginBridge;

    invoke-direct {v11}, Lcom/mineradio/app/car/CarWallpaperPluginBridge;-><init>()V

    const-string v12, "${jsInterfaceName}"

    invoke-virtual {v0, v11, v12}, Landroid/webkit/WebView;->addJavascriptInterface(Ljava/lang/Object;Ljava/lang/String;)V
`;
}

const ATTACH_SNIPPET = buildAttachSnippet();

/** Ensure .locals N is at least minLocals for the method containing KeepApp inject. */
function ensureMethodLocals(src, minLocals) {
  const keepAppLoose =
    /(const-string v\d+, "KeepApp"\s*\n\s*invoke-virtual \{v\d+, p\d+, v\d+\}, Landroid\/webkit\/WebView;->addJavascriptInterface\(Ljava\/lang\/Object;Ljava\/lang\/String;\)V\n)/;
  const m = keepAppLoose.exec(src);
  if (!m) return src;
  const injectAt = m.index;
  // Walk backward to nearest .method / .locals
  const before = src.slice(0, injectAt);
  const methodIdx = before.lastIndexOf('\n.method ');
  if (methodIdx < 0) return src;
  const methodSlice = src.slice(methodIdx);
  const localsMatch = methodSlice.match(/\.locals (\d+)/);
  if (!localsMatch) return src;
  const cur = parseInt(localsMatch[1], 10);
  if (cur >= minLocals) return src;
  const absLocalsIdx = methodIdx + methodSlice.indexOf(localsMatch[0]);
  return (
    src.slice(0, absLocalsIdx) +
    `.locals ${minLocals}` +
    src.slice(absLocalsIdx + localsMatch[0].length)
  );
}

/** Fixed local asset URL allowlist (Task 4 TrustedWallpaperBridgePolicy). */
const TRUSTED_LOCAL_ASSET_PREFIXES = Object.freeze([
  'file:///android_asset/',
  'https://appassets.androidplatform.net/',
  'https://appassets.androidplatform.net/assets/',
]);

/** External login hosts — must open without high-privilege bridge. */
const EXTERNAL_LOGIN_HOST_MARKERS = Object.freeze([
  'music.163.com',
  'y.qq.com',
  'i.y.qq.com',
  'qishui.douyin.com',
  'douyin.com',
]);

function atomicWriteFile(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`,
  );
  if (Buffer.isBuffer(content)) {
    fs.writeFileSync(tmp, content, { mode: 0o644 });
  } else {
    fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o644 });
  }
  fs.renameSync(tmp, filePath);
}

/** WP-05 paths XML: only cache-path wallpaper_plugin_stage/ (Task 5). */
const FORBIDDEN_PROVIDER_PATH_TAGS_RE =
  /<(files-path|external-path|external-files-path|root-path)\b/;
const PATHS_XML_BASENAME = 'wallpaper_plugin_paths.xml';
const STAGER_SMALI_BASENAME = 'CarWallpaperMpkgStager.smali';
const BRIDGE_SMALI_BASENAME = 'CarWallpaperPluginBridge.smali';
const INSTALLER_SMALI_BASENAME = 'CarWallpaperPluginInstaller.smali';
/** WP-10A: real Binder ContentResolver client + adb probe Activity. */
const PROVIDER_CLIENT_SMALI_BASENAME = 'WallpaperPluginProviderClient.smali';
const PROBE_ACTIVITY_SMALI_BASENAME = 'WallpaperPluginBridgeProbeActivity.smali';
const PROBE_ACTIVITY_CLASS = 'com.mineradio.app.car.WallpaperPluginBridgeProbeActivity';

function resolveSmaliSourceRoot() {
  return path.join(__dirname, 'smali', 'com', 'mineradio', 'app', 'car');
}

/** Decoded APK smali_classes3/.../car destination for bridge + stager. */
function resolveDecodedCarSmaliDestDir(decodedDir) {
  return path.join(decodedDir, 'smali_classes3', 'com', 'mineradio', 'app', 'car');
}

/**
 * Atomic copy of a Smali source into decoded car package dir.
 * @param {string} decodedDir
 * @param {string} basename e.g. CarWallpaperPluginBridge.smali
 * @param {(text: string) => void} [validateText] fail-closed pre-write check
 */
function copyCarSmaliFile(decodedDir, basename, validateText) {
  const src = path.join(resolveSmaliSourceRoot(), basename);
  if (!fs.existsSync(src)) {
    throw new Error(`${basename} missing at ${src}`);
  }
  const body = fs.readFileSync(src);
  if (typeof validateText === 'function') {
    validateText(body.toString('utf8'));
  }
  const destRoot = resolveDecodedCarSmaliDestDir(decodedDir);
  fs.mkdirSync(destRoot, { recursive: true });
  const dest = path.join(destRoot, basename);
  atomicWriteFile(dest, body);
  return { dest, changed: true, src };
}

function copyBridgeSmali(decodedDir) {
  const bridgeSrc = path.join(resolveSmaliSourceRoot(), BRIDGE_SMALI_BASENAME);
  if (!fs.existsSync(bridgeSrc)) {
    throw new Error(`CarWallpaperPluginBridge.smali missing at ${bridgeSrc}`);
  }
  // REFACTOR: refuse copy if Smali drifts from contract (single protocol truth).
  const mirror = contract.assertJsSmaliContractMirror({ smaliPath: bridgeSrc });
  if (!mirror.ok) {
    throw new Error(
      `JS/Smali contract mirror failed before copy: ${mirror.failureReason}: ${mirror.message}`,
    );
  }
  const copied = copyCarSmaliFile(decodedDir, BRIDGE_SMALI_BASENAME);
  // WP-10A realCaller: ProviderClient must ride with the bridge inject.
  const clientSrc = path.join(resolveSmaliSourceRoot(), PROVIDER_CLIENT_SMALI_BASENAME);
  if (!fs.existsSync(clientSrc)) {
    throw new Error(
      `${PROVIDER_CLIENT_SMALI_BASENAME} missing — run scripts/tools/compile-provider-client.sh`,
    );
  }
  const clientText = fs.readFileSync(clientSrc, 'utf8');
  if (
    !clientText.includes('ContentResolver') ||
    !clientText.includes('realCaller') ||
    !clientText.includes(contract.authority || 'com.motif.wallpaperengine.control')
  ) {
    throw new Error('WallpaperPluginProviderClient.smali missing Binder/realCaller markers');
  }
  const client = copyCarSmaliFile(decodedDir, PROVIDER_CLIENT_SMALI_BASENAME);
  const probeSrc = path.join(resolveSmaliSourceRoot(), PROBE_ACTIVITY_SMALI_BASENAME);
  let probe = null;
  if (fs.existsSync(probeSrc)) {
    probe = copyCarSmaliFile(decodedDir, PROBE_ACTIVITY_SMALI_BASENAME);
  }
  return {
    dest: copied.dest,
    changed: true,
    contractMirror: mirror,
    providerClient: client,
    probeActivity: probe,
  };
}

/**
 * Register exported probe Activity for adb realCaller evidence (no WebView).
 * Idempotent. Does not add car HMI launcher categories.
 */
function injectProbeActivityManifest(decodedDir) {
  const manifestPath = path.join(decodedDir, 'AndroidManifest.xml');
  // Smali-only fixture trees (unit tests) may omit the manifest — skip, do not fail.
  if (!fs.existsSync(manifestPath)) {
    return { changed: false, activity: PROBE_ACTIVITY_CLASS, skipped: true };
  }
  let xml = fs.readFileSync(manifestPath, 'utf8');
  if (xml.includes(PROBE_ACTIVITY_CLASS)) {
    return { changed: false, activity: PROBE_ACTIVITY_CLASS };
  }
  const activityXml =
    `        <activity android:name="${PROBE_ACTIVITY_CLASS}"` +
    ` android:exported="true" android:excludeFromRecents="true"` +
    ` android:theme="@android:style/Theme.NoDisplay"/>\n`;
  const appClose = xml.lastIndexOf('</application>');
  if (appClose < 0) {
    throw new Error('AndroidManifest missing </application> (fail-closed)');
  }
  xml = xml.slice(0, appClose) + activityXml + xml.slice(appClose);
  atomicWriteFile(manifestPath, xml);
  return { changed: true, activity: PROBE_ACTIVITY_CLASS };
}

/**
 * WP-05: copy CarWallpaperMpkgStager.smali next to bridge (idempotent refresh).
 */
function copyStagerSmali(decodedDir) {
  const fpMirror = contract.assertFileProviderSmaliMirror({
    cwd: path.resolve(__dirname, '..', '..'),
  });
  if (!fpMirror.ok) {
    throw new Error(
      `FileProvider Smali mirror failed before stager copy: ${fpMirror.failureReason}: ${fpMirror.message}`,
    );
  }
  const copied = copyCarSmaliFile(decodedDir, STAGER_SMALI_BASENAME, (text) => {
    if (!text.includes('CarWallpaperMpkgStager') || !text.includes('wallpaper_plugin_stage')) {
      throw new Error('CarWallpaperMpkgStager.smali missing required stage markers (fail-closed)');
    }
  });
  return { dest: copied.dest, changed: true, stager: 'CarWallpaperMpkgStager' };
}

/**
 * WP-06: copy CarWallpaperPluginInstaller.smali next to bridge (idempotent refresh).
 */
function copyInstallerSmali(decodedDir) {
  const installMirror = contract.assertInstallSmaliMirror({
    cwd: path.resolve(__dirname, '..', '..'),
  });
  if (!installMirror.ok) {
    throw new Error(
      `Install Smali mirror failed before installer copy: ${installMirror.failureReason}: ${installMirror.message}`,
    );
  }
  const copied = copyCarSmaliFile(decodedDir, INSTALLER_SMALI_BASENAME, (text) => {
    if (
      !text.includes('CarWallpaperPluginInstaller') ||
      !text.includes('PackageInstaller') ||
      !text.includes('content://')
    ) {
      throw new Error(
        'CarWallpaperPluginInstaller.smali missing required install markers (fail-closed)',
      );
    }
  });
  return { dest: copied.dest, changed: true, installer: 'CarWallpaperPluginInstaller' };
}

/**
 * Validate Task 5 paths XML text (cache-path only). Shared by copy + tests.
 * @param {string} text
 */
function assertWallpaperPluginPathsXmlText(text) {
  if (typeof text !== 'string' || !text.includes('cache-path') || !text.includes('wallpaper_plugin_stage')) {
    throw new Error('wallpaper_plugin_paths.xml must only expose cache-path wallpaper_plugin_stage/');
  }
  if (FORBIDDEN_PROVIDER_PATH_TAGS_RE.test(text)) {
    throw new Error('wallpaper_plugin_paths.xml forbids files/external/root paths (fail-closed)');
  }
}

/**
 * WP-05: copy wallpaper_plugin_paths.xml into decoded APK res/xml/.
 * Input structure + target authority validated; original APK never overwritten.
 */
function copyWallpaperPluginPathsXml(decodedDir) {
  const src = path.join(__dirname, 'resources', 'xml', PATHS_XML_BASENAME);
  if (!fs.existsSync(src)) {
    throw new Error(`wallpaper_plugin_paths.xml missing at ${src}`);
  }
  const text = fs.readFileSync(src, 'utf8');
  assertWallpaperPluginPathsXmlText(text);
  const destDir = path.join(decodedDir, 'res', 'xml');
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, PATHS_XML_BASENAME);
  atomicWriteFile(dest, text);
  return {
    dest,
    changed: true,
    authority: contract.fileProviderAuthority,
    resource: '@xml/wallpaper_plugin_paths',
  };
}

function findLandscapeWebActivity(decodedDir) {
  const candidates = [
    path.join(decodedDir, 'smali_classes3', 'com', 'mineradio', 'app', 'LandscapeWebActivity.smali'),
    path.join(decodedDir, 'smali', 'com', 'mineradio', 'app', 'LandscapeWebActivity.smali'),
    path.join(decodedDir, 'smali_classes2', 'com', 'mineradio', 'app', 'LandscapeWebActivity.smali'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function patchLandscapeWebActivity(decodedDir) {
  const file = findLandscapeWebActivity(decodedDir);
  if (!file) {
    throw new Error('LandscapeWebActivity.smali not found in decoded tree');
  }

  let src = fs.readFileSync(file, 'utf8');
  // Already patched with safe high registers.
  if (
    src.includes('const-string') &&
    src.includes(`"${JS_INTERFACE}"`) &&
    src.includes(`${HOOK_MARKER}`) &&
    src.includes('new-instance v11, Lcom/mineradio/app/car/CarWallpaperPluginBridge')
  ) {
    return { file, changed: false };
  }

  // Strip legacy v2/v3 inject (VerifyError: clobbers later ViewGroup/boolean uses).
  const legacySnippet =
    /\n\s*new-instance v2, Lcom\/mineradio\/app\/car\/CarWallpaperPluginBridge;\s*\n\s*invoke-direct \{v2\}, Lcom\/mineradio\/app\/car\/CarWallpaperPluginBridge;-><init>\(\)V\s*\n\s*const-string v3, "WallpaperPlugin"\s*\n\s*invoke-virtual \{v0, v2, v3\}, Landroid\/webkit\/WebView;->addJavascriptInterface\(Ljava\/lang\/Object;Ljava\/lang\/String;\)V\s*\n/;
  if (legacySnippet.test(src)) {
    src = src.replace(legacySnippet, '\n');
  }

  const keepAppExact =
    '    const-string v1, "KeepApp"\n\n    invoke-virtual {v0, p1, v1}, Landroid/webkit/WebView;->addJavascriptInterface(Ljava/lang/Object;Ljava/lang/String;)V\n';
  const keepAppLoose =
    /(const-string v\d+, "KeepApp"\s*\n\s*invoke-virtual \{v\d+, p\d+, v\d+\}, Landroid\/webkit\/WebView;->addJavascriptInterface\(Ljava\/lang\/Object;Ljava\/lang\/String;\)V\n)/;

  // Need v11/v12 free → .locals >= 13 for onCreate(this, Bundle).
  src = ensureMethodLocals(src, 13);

  if (src.includes(keepAppExact) && !src.includes(`new-instance v11, Lcom/mineradio/app/car/CarWallpaperPluginBridge`)) {
    src = src.replace(keepAppExact, `${keepAppExact}${ATTACH_SNIPPET}`);
  } else if (
    keepAppLoose.test(src) &&
    !src.includes(`new-instance v11, Lcom/mineradio/app/car/CarWallpaperPluginBridge`)
  ) {
    src = src.replace(keepAppLoose, `$1${ATTACH_SNIPPET}`);
  } else if (!src.includes(`new-instance v11, Lcom/mineradio/app/car/CarWallpaperPluginBridge`)) {
    throw new Error(
      'KeepApp addJavascriptInterface injection point not found in LandscapeWebActivity (fail-closed)',
    );
  }

  if (!src.includes(`"${JS_INTERFACE}"`) || !src.includes(HOOK_MARKER)) {
    throw new Error('Failed to inject WallpaperPlugin after KeepApp');
  }

  atomicWriteFile(file, src);
  return { file, changed: true };
}

/**
 * Patch a decoded APKtool tree. Does not modify original input APK.
 * @param {string} decodedDir
 */
function patchWallpaperPluginBridge(decodedDir) {
  const root = path.resolve(decodedDir);
  if (!root || root === '/' || root === path.parse(root).root) {
    throw new Error('decodedDir path rejected');
  }
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Decoded directory not found: ${root}`);
  }
  // Basic structure validation — require smali root presence
  const hasSmali =
    fs.existsSync(path.join(root, 'smali')) ||
    fs.existsSync(path.join(root, 'smali_classes2')) ||
    fs.existsSync(path.join(root, 'smali_classes3'));
  if (!hasSmali) {
    throw new Error('Decoded tree missing smali* directories (fail-closed)');
  }

  const smali = copyBridgeSmali(root);
  // WP-05: FileProvider paths XML → res/xml/ + CarWallpaperMpkgStager.smali
  const pathsXml = copyWallpaperPluginPathsXml(root);
  const stager = copyStagerSmali(root);
  // WP-06: CarWallpaperPluginInstaller.smali (PackageInstaller + package visibility)
  const installer = copyInstallerSmali(root);
  const activity = patchLandscapeWebActivity(root);
  const probeManifest = injectProbeActivityManifest(root);
  return {
    smaliDir: path.dirname(smali.dest),
    bridgeSmali: smali,
    providerClientSmali: smali.providerClient,
    probeActivitySmali: smali.probeActivity,
    probeManifest,
    stagerSmali: stager,
    installerSmali: installer,
    wallpaperPluginPathsXml: pathsXml,
    landscapeWebActivity: activity,
    jsInterface: JS_INTERFACE,
    hookMarker: HOOK_MARKER,
    protocolVersion: contract.protocolVersion,
    authority: contract.authority,
    fileProviderAuthority: contract.fileProviderAuthority,
    pluginPackage: contract.pluginPackage,
    contractMirror: smali.contractMirror,
  };
}

// ---------------------------------------------------------------------------
// TrustedWallpaperBridgePolicy
// ---------------------------------------------------------------------------

function isTrustedLocalAssetUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  // No wildcard; prefix allowlist only.
  if (url.includes('*') || url.includes('..')) return false;
  return TRUSTED_LOCAL_ASSET_PREFIXES.some((p) => url.startsWith(p));
}

function isExternalLoginUrl(url) {
  if (typeof url !== 'string') return false;
  const lower = url.toLowerCase();
  return EXTERNAL_LOGIN_HOST_MARKERS.some((h) => lower.includes(h));
}

/**
 * Decide whether WallpaperPlugin may be mounted.
 * Requires: trusted local asset URL + top-level frame + matching page nonce + CSP ok.
 */
function canMountBridge(ctx = {}) {
  const {
    url,
    isTopFrame,
    pageNonce,
    expectedNonce,
    cspOk = true,
    packageName,
    uid,
    trustedPackage = 'com.mineradio.app',
    trustedUid = null,
  } = ctx;

  if (packageName != null && packageName !== trustedPackage) {
    return {
      ok: false,
      mount: false,
      failureReason: 'UNTRUSTED_PACKAGE',
      message: 'package is not trusted Mineradio package',
    };
  }
  if (trustedUid != null && uid != null && Number(uid) !== Number(trustedUid)) {
    return {
      ok: false,
      mount: false,
      failureReason: 'UNTRUSTED_UID',
      message: 'UID is not trusted',
    };
  }
  if (!isTrustedLocalAssetUrl(url)) {
    return {
      ok: false,
      mount: false,
      failureReason: 'UNTRUSTED_ORIGIN',
      message: 'URL is not a fixed local asset allowlist entry',
    };
  }
  if (isTopFrame !== true) {
    return {
      ok: false,
      mount: false,
      failureReason: 'NOT_TOP_FRAME',
      message: 'bridge only mounts on top-level frame',
    };
  }
  if (!pageNonce || !expectedNonce || pageNonce !== expectedNonce) {
    return {
      ok: false,
      mount: false,
      failureReason: 'NONCE_MISMATCH',
      message: 'page nonce must match expected nonce',
    };
  }
  if (cspOk !== true) {
    return {
      ok: false,
      mount: false,
      failureReason: 'CSP_FAILED',
      message: 'CSP validation failed',
    };
  }
  return { ok: true, mount: true, jsInterface: JS_INTERFACE };
}

/**
 * On navigation start / redirect / history restore: strip bridge first.
 */
function shouldStripBridge(ctx = {}) {
  const { navigationUrl, isRedirect, isHistoryRestore, isPageStarted } = ctx;
  if (isPageStarted === true || isRedirect === true || isHistoryRestore === true) {
    return {
      ok: true,
      strip: true,
      removeJavascriptInterface: JS_INTERFACE,
      reason: 'NAVIGATION_OR_RESTORE',
    };
  }
  if (navigationUrl && !isTrustedLocalAssetUrl(navigationUrl)) {
    return {
      ok: true,
      strip: true,
      removeJavascriptInterface: JS_INTERFACE,
      reason: 'NON_ALLOWLIST_NAV',
    };
  }
  return { ok: true, strip: false };
}

/**
 * External login (Netease/QQ/Qishui) must open without high-privilege bridge.
 */
function openExternalLogin(url) {
  if (!isExternalLoginUrl(url)) {
    return {
      ok: false,
      failureReason: 'NOT_EXTERNAL_LOGIN',
      message: 'URL is not a known external login host',
    };
  }
  return {
    ok: true,
    openIn: 'new_webview_or_custom_tab',
    registerBridge: false,
    stripBridgeFirst: true,
    jsInterface: null,
  };
}

/**
 * RED/GREEN fixture probe for TrustedWallpaperBridgePolicy.
 */
/**
 * REFACTOR re-export: protocol constants + Smali mirror must stay aligned.
 */
function assertJsSmaliContractMirror(options = {}) {
  return contract.assertJsSmaliContractMirror(options);
}

function assertTrustedWallpaperBridgePolicy(_options = {}) {
  // Policy still uses contract JS interface name (no second constant).
  if (JS_INTERFACE !== contract.jsInterfaceName) {
    return {
      ok: false,
      message: 'patcher JS_INTERFACE drifted from wallpaper-plugin-contract.js',
    };
  }
  const nonce = 'page-nonce-abc';
  const goodUrl = 'file:///android_asset/car/index.html';

  // Mount allowed only when all checks pass
  const good = canMountBridge({
    url: goodUrl,
    isTopFrame: true,
    pageNonce: nonce,
    expectedNonce: nonce,
    cspOk: true,
    packageName: 'com.mineradio.app',
  });
  if (!good.ok || !good.mount) {
    return { ok: false, message: 'trusted local asset should mount', detail: good };
  }

  // Non-allowlist URL
  const badUrl = canMountBridge({
    url: 'https://evil.example/app',
    isTopFrame: true,
    pageNonce: nonce,
    expectedNonce: nonce,
    cspOk: true,
  });
  if (badUrl.ok || badUrl.mount) {
    return { ok: false, message: 'non-allowlist must refuse mount' };
  }

  // Wildcard rejected
  const wild = canMountBridge({
    url: 'file:///android_asset/*',
    isTopFrame: true,
    pageNonce: nonce,
    expectedNonce: nonce,
  });
  if (wild.ok) {
    return { ok: false, message: 'wildcard URL must refuse' };
  }

  // iframe / non-top-frame
  const iframe = canMountBridge({
    url: goodUrl,
    isTopFrame: false,
    pageNonce: nonce,
    expectedNonce: nonce,
  });
  if (iframe.ok || iframe.mount) {
    return { ok: false, message: 'iframe must refuse mount' };
  }

  // nonce mismatch
  const badNonce = canMountBridge({
    url: goodUrl,
    isTopFrame: true,
    pageNonce: 'x',
    expectedNonce: nonce,
  });
  if (badNonce.ok) {
    return { ok: false, message: 'nonce mismatch must refuse' };
  }

  // untrusted package / UID
  const badPkg = canMountBridge({
    url: goodUrl,
    isTopFrame: true,
    pageNonce: nonce,
    expectedNonce: nonce,
    packageName: 'com.evil.app',
  });
  if (badPkg.ok) {
    return { ok: false, message: 'untrusted package must refuse' };
  }
  const badUid = canMountBridge({
    url: goodUrl,
    isTopFrame: true,
    pageNonce: nonce,
    expectedNonce: nonce,
    packageName: 'com.mineradio.app',
    uid: 10001,
    trustedUid: 10086,
  });
  if (badUid.ok) {
    return { ok: false, message: 'untrusted UID must refuse' };
  }

  // strip on navigation / redirect / history restore
  const stripNav = shouldStripBridge({ isPageStarted: true });
  const stripRedir = shouldStripBridge({ isRedirect: true });
  const stripHist = shouldStripBridge({ isHistoryRestore: true });
  if (!stripNav.strip || !stripRedir.strip || !stripHist.strip) {
    return { ok: false, message: 'nav/redirect/history must strip bridge' };
  }
  if (stripNav.removeJavascriptInterface !== JS_INTERFACE) {
    return { ok: false, message: 'strip must target WallpaperPlugin' };
  }

  // external login without bridge
  const login = openExternalLogin('https://music.163.com/login');
  if (!login.ok || login.registerBridge !== false) {
    return { ok: false, message: 'external login must not register bridge', detail: login };
  }

  return {
    ok: true,
    jsInterfaceName: JS_INTERFACE,
    stripOnNavigation: true,
    topLevelFrameOnly: true,
    externalLoginWithoutBridge: true,
    nonAllowlistFailClosed: true,
    noWildcard: true,
    trustedPackageUidRequired: true,
  };
}

function main(argv) {
  const decoded = argv[2];
  if (!decoded) {
    console.error('Usage: patch-wallpaper-plugin-bridge.js <decoded-apk-dir>');
    process.exit(2);
  }
  try {
    const result = patchWallpaperPluginBridge(decoded);
    console.log(
      JSON.stringify({
        ok: true,
        command: 'patch-wallpaper-plugin-bridge',
        jsInterface: result.jsInterface,
        bridge: result.bridgeSmali.dest,
        activity: result.landscapeWebActivity.file,
        activityChanged: result.landscapeWebActivity.changed,
      }),
    );
  } catch (err) {
    console.error(String(err && err.message ? err.message : err));
    process.exit(1);
  }
}

module.exports = {
  patchWallpaperPluginBridge,
  copyBridgeSmali,
  copyStagerSmali,
  copyInstallerSmali,
  copyWallpaperPluginPathsXml,
  copyCarSmaliFile,
  resolveDecodedCarSmaliDestDir,
  assertWallpaperPluginPathsXmlText,
  FORBIDDEN_PROVIDER_PATH_TAGS_RE,
  patchLandscapeWebActivity,
  atomicWriteFile,
  buildAttachSnippet,
  BRIDGE_CLASS,
  JS_INTERFACE,
  HOOK_MARKER,
  TRUSTED_LOCAL_ASSET_PREFIXES,
  EXTERNAL_LOGIN_HOST_MARKERS,
  isTrustedLocalAssetUrl,
  isExternalLoginUrl,
  canMountBridge,
  shouldStripBridge,
  openExternalLogin,
  assertTrustedWallpaperBridgePolicy,
  assertJsSmaliContractMirror,
  contract,
};

if (require.main === module) {
  main(process.argv);
}
