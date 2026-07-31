'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  patchAudioFocusBridge,
  HOOK_MARKER,
} = require('../scripts/patch-audio-focus-bridge.js');

function makeDecodedFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-af-'));
  const focusDir = path.join(root, 'smali_classes2', 'androidx', 'media3', 'common', 'audio');
  const actDir = path.join(root, 'smali_classes3', 'com', 'mineradio', 'app');
  fs.mkdirSync(focusDir, { recursive: true });
  fs.mkdirSync(actDir, { recursive: true });

  fs.writeFileSync(
    path.join(focusDir, 'AudioFocusManager.smali'),
    `.class public final Landroidx/media3/common/audio/AudioFocusManager;
.super Ljava/lang/Object;

.method public final handlePlatformAudioFocusChange(I)V
    .locals 2

    const/4 v0, -0x3

    return-void
.end method
`,
  );

  fs.writeFileSync(
    path.join(actDir, 'LandscapeWebActivity.smali'),
    `.class public final Lcom/mineradio/app/LandscapeWebActivity;
.super Landroid/app/Activity;

.method public final setupWeb()V
    .locals 3

    const-string v1, "KeepApp"

    invoke-virtual {v0, p1, v1}, Landroid/webkit/WebView;->addJavascriptInterface(Ljava/lang/Object;Ljava/lang/String;)V

    return-void
.end method
`,
  );

  return root;
}

test('audio focus bridge copies smali and hooks manager + webview attach', () => {
  const root = makeDecodedFixture();
  const once = patchAudioFocusBridge(root);
  assert.equal(once.audioFocusManager.changed, true);
  assert.equal(once.landscapeWebActivity.changed, true);

  const bridge = path.join(
    root,
    'smali_classes3',
    'com',
    'mineradio',
    'app',
    'car',
    'CarAudioFocusBridge.smali',
  );
  const evalJs = path.join(
    root,
    'smali_classes3',
    'com',
    'mineradio',
    'app',
    'car',
    'CarAudioFocusBridge$EvalJs.smali',
  );
  assert.ok(fs.existsSync(bridge));
  assert.ok(fs.existsSync(evalJs));
  assert.match(fs.readFileSync(bridge, 'utf8'), /onFocusChange\(I\)V/);
  assert.match(fs.readFileSync(bridge, 'utf8'), /MineradioCarVisual\.setAudioDuck/);

  const focusSrc = fs.readFileSync(once.audioFocusManager.file, 'utf8');
  assert.match(focusSrc, /handlePlatformAudioFocusChange/);
  assert.match(focusSrc, /CarAudioFocusBridge;->onFocusChange\(I\)V/);

  const actSrc = fs.readFileSync(once.landscapeWebActivity.file, 'utf8');
  assert.match(actSrc, /KeepApp/);
  assert.match(actSrc, /CarAudioFocusBridge;->attachWebView/);

  const twice = patchAudioFocusBridge(root);
  assert.equal(twice.audioFocusManager.changed, false);
  assert.equal(twice.landscapeWebActivity.changed, false);
});

test('car APK build wires audio focus bridge after spica patch', () => {
  const buildScript = fs.readFileSync(
    path.join(__dirname, '../scripts/build-car-apk.sh'),
    'utf8',
  );
  assert.match(buildScript, /patch-spica-storage\.js/);
  assert.match(buildScript, /patch-audio-focus-bridge\.js/);
  assert.match(buildScript, /patch-car-hmi-assets\.js/);
  // order: spica then audio-focus then hmi
  const iSpica = buildScript.indexOf('patch-spica-storage.js');
  const iAf = buildScript.indexOf('patch-audio-focus-bridge.js');
  const iHmi = buildScript.indexOf('patch-car-hmi-assets.js');
  assert.ok(iSpica > 0 && iAf > iSpica && iHmi > iAf);
  assert.ok(HOOK_MARKER);
});
