#!/usr/bin/env node
'use strict';

/**
 * Inject native AudioFocus → WebView JS bridge for car builds.
 *
 * 1) Copy CarAudioFocusBridge smali into the decoded tree
 * 2) Hook AudioFocusManager.handlePlatformAudioFocusChange
 * 3) Register LandscapeWebActivity.webView with the bridge after KeepApp inject
 */

const fs = require('node:fs');
const path = require('node:path');

const HOOK_MARKER = 'CarAudioFocusBridge';
const ATTACH_SNIPPET = `
    invoke-static {v0}, Lcom/mineradio/app/car/CarAudioFocusBridge;->attachWebView(Landroid/webkit/WebView;)V
`;
const FOCUS_HOOK_SNIPPET = `
    invoke-static {p1}, Lcom/mineradio/app/car/CarAudioFocusBridge;->onFocusChange(I)V
`;

function copySmaliTree(decodedDir) {
  const srcRoot = path.join(__dirname, 'smali', 'com', 'mineradio', 'app', 'car');
  const destRoot = path.join(decodedDir, 'smali_classes3', 'com', 'mineradio', 'app', 'car');
  fs.mkdirSync(destRoot, { recursive: true });
  for (const name of fs.readdirSync(srcRoot)) {
    if (!name.endsWith('.smali')) continue;
    fs.copyFileSync(path.join(srcRoot, name), path.join(destRoot, name));
  }
  return destRoot;
}

function patchAudioFocusManager(decodedDir) {
  const candidates = [
    path.join(decodedDir, 'smali_classes2', 'androidx', 'media3', 'common', 'audio', 'AudioFocusManager.smali'),
    path.join(decodedDir, 'smali', 'androidx', 'media3', 'common', 'audio', 'AudioFocusManager.smali'),
  ];
  const file = candidates.find((p) => fs.existsSync(p));
  if (!file) throw new Error('AudioFocusManager.smali not found in decoded tree');

  let src = fs.readFileSync(file, 'utf8');
  if (src.includes(HOOK_MARKER) && src.includes('onFocusChange(I)V')) {
    return { file, changed: false };
  }

  const needle = '.method public final handlePlatformAudioFocusChange(I)V\n    .locals 2\n';
  if (!src.includes(needle)) {
    // tolerate different locals count
    const m = src.match(
      /\.method public final handlePlatformAudioFocusChange\(I\)V\n    \.locals (\d+)\n/,
    );
    if (!m) throw new Error('handlePlatformAudioFocusChange method signature not found');
    const locals = Number(m[1]);
    const alt = `.method public final handlePlatformAudioFocusChange(I)V\n    .locals ${locals}\n`;
    src = src.replace(
      alt,
      `${alt}${FOCUS_HOOK_SNIPPET}`,
    );
  } else {
    src = src.replace(needle, `${needle}${FOCUS_HOOK_SNIPPET}`);
  }

  if (!src.includes('onFocusChange(I)V')) {
    throw new Error('Failed to inject onFocusChange hook into AudioFocusManager');
  }
  fs.writeFileSync(file, src);
  return { file, changed: true };
}

function patchLandscapeWebActivity(decodedDir) {
  const candidates = [
    path.join(decodedDir, 'smali_classes3', 'com', 'mineradio', 'app', 'LandscapeWebActivity.smali'),
    path.join(decodedDir, 'smali', 'com', 'mineradio', 'app', 'LandscapeWebActivity.smali'),
  ];
  const file = candidates.find((p) => fs.existsSync(p));
  if (!file) throw new Error('LandscapeWebActivity.smali not found');

  let src = fs.readFileSync(file, 'utf8');
  if (src.includes('attachWebView(Landroid/webkit/WebView;)V')) {
    return { file, changed: false };
  }

  const needle =
    '    const-string v1, "KeepApp"\n\n    invoke-virtual {v0, p1, v1}, Landroid/webkit/WebView;->addJavascriptInterface(Ljava/lang/Object;Ljava/lang/String;)V\n';
  if (!src.includes(needle)) {
    // looser match
    const re =
      /(const-string v1, "KeepApp"\s*\n\s*invoke-virtual \{v0, p1, v1\}, Landroid\/webkit\/WebView;->addJavascriptInterface\(Ljava\/lang\/Object;Ljava\/lang\/String;\)V\n)/;
    if (!re.test(src)) {
      throw new Error('KeepApp addJavascriptInterface site not found in LandscapeWebActivity');
    }
    src = src.replace(re, `$1${ATTACH_SNIPPET}`);
  } else {
    src = src.replace(needle, `${needle}${ATTACH_SNIPPET}`);
  }

  if (!src.includes('attachWebView(Landroid/webkit/WebView;)V')) {
    throw new Error('Failed to inject attachWebView after KeepApp');
  }
  fs.writeFileSync(file, src);
  return { file, changed: true };
}

function patchAudioFocusBridge(decodedDir) {
  const root = path.resolve(decodedDir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Decoded directory not found: ${root}`);
  }
  const dest = copySmaliTree(root);
  const focus = patchAudioFocusManager(root);
  const activity = patchLandscapeWebActivity(root);
  return {
    smaliDir: dest,
    audioFocusManager: focus,
    landscapeWebActivity: activity,
  };
}

function main(argv) {
  if (argv.length !== 1) {
    console.error('Usage: patch-audio-focus-bridge.js <apktool-decoded-directory>');
    process.exitCode = 64;
    return;
  }
  const result = patchAudioFocusBridge(path.resolve(argv[0]));
  console.log(
    'AudioFocus bridge: smali copied; AudioFocusManager=%s; LandscapeWebActivity=%s',
    result.audioFocusManager.changed ? 'patched' : 'already-patched',
    result.landscapeWebActivity.changed ? 'patched' : 'already-patched',
  );
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  patchAudioFocusBridge,
  copySmaliTree,
  patchAudioFocusManager,
  patchLandscapeWebActivity,
  HOOK_MARKER,
};
