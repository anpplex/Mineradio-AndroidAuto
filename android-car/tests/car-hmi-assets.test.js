const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  decryptMineradioAsset,
  encryptMineradioAsset,
  injectCarHmiStylesheet,
  patchCarHmiAssets,
  CAR_HMI_STYLESHEET,
  CAR_VISUAL_RUNTIME_SOURCE,
  CAR_VISUAL_RUNTIME_NAME,
} = require('../scripts/patch-car-hmi-assets.js');

test('car HMI asset encryption round-trips plaintext with the APK MENC envelope', () => {
  const source = Buffer.from('<!doctype html><title>车机</title>', 'utf8');
  const encrypted = encryptMineradioAsset(source, Buffer.alloc(16, 7));

  assert.equal(encrypted.subarray(0, 4).toString('ascii'), 'MENC');
  assert.deepEqual(decryptMineradioAsset(encrypted), source);
});

test('car HMI stylesheet injection is idempotent and keeps it after existing styles', () => {
  const document = '<html><head><link rel="stylesheet" href="base.css"></head><body></body></html>';
  const once = injectCarHmiStylesheet(document);
  const twice = injectCarHmiStylesheet(once);

  assert.match(once, /base\.css[\s\S]*car-hmi\.css/);
  assert.match(once, /id="car-login-entry"[\s\S]*onclick="showLoginModal\(\)"/);
  assert.match(once, /car-visual-runtime\.js/);
  assert.match(once, /data-car-visual-mode="drive"/);
  assert.equal((twice.match(/car-hmi\.css/g) || []).length, 1);
  assert.equal((twice.match(/car-login-entry/g) || []).length, 1);
  assert.equal((twice.match(/car-visual-runtime\.js/g) || []).length, 1);
});

test('car HMI injection requires a real stylesheet link, not a filename in page text', () => {
  const document = '<html><head><!-- car-hmi.css is reserved --></head><body></body></html>';
  const patched = injectCarHmiStylesheet(document);

  assert.match(patched, /<link rel="stylesheet" href="car-hmi\.css">/);
  assert.equal((patched.match(/car-hmi\.css/g) || []).length, 2);
});

test('car HMI stylesheet targets density-scaled WebView CSS px on the landscape unit', () => {
  assert.match(CAR_HMI_STYLESHEET, /@media \(min-width: 900px\) and \(min-height: 480px\)/);
  assert.doesNotMatch(CAR_HMI_STYLESHEET, /@media \(min-width: 1548px\)/);
  assert.match(CAR_HMI_STYLESHEET, /--car-touch-target:\s*48px/);
  assert.match(CAR_HMI_STYLESHEET, /--car-primary-action:\s*64px/);
  assert.match(CAR_HMI_STYLESHEET, /font-size:\s*18px/);
  assert.match(CAR_HMI_STYLESHEET, /#trial-login-btn/);
  assert.match(CAR_HMI_STYLESHEET, /#car-login-entry/);
  assert.match(CAR_HMI_STYLESHEET, /#trial-banner[\s\S]*top:\s*84px/);
  assert.match(CAR_HMI_STYLESHEET, /#fx-fab\s*\{[\s\S]*bottom:\s*128px/);
  assert.match(CAR_HMI_STYLESHEET, /#bottom-bar > #controls > \.control-cluster > \.ctrl-btn/);
  assert.match(CAR_HMI_STYLESHEET, /#audio-effect-control/);
  assert.match(CAR_HMI_STYLESHEET, /#home-recent-panel/);
  assert.match(CAR_HMI_STYLESHEET, /#playlist-toggle/);
  assert.match(CAR_HMI_STYLESHEET, /#bottom-bar/);
  assert.match(CAR_HMI_STYLESHEET, /#canvas-container/);
  assert.match(CAR_HMI_STYLESHEET, /grid-template-columns:\s*minmax\(280px/);
});

test('car visual layer defines drive/cruise/stage budgets and mode switcher chrome', () => {
  assert.match(CAR_HMI_STYLESHEET, /--car-particle-opacity/);
  assert.match(CAR_HMI_STYLESHEET, /--car-stage-scrim/);
  assert.match(CAR_HMI_STYLESHEET, /data-car-visual-mode="drive"/);
  assert.match(CAR_HMI_STYLESHEET, /data-car-visual-mode="cruise"/);
  assert.match(CAR_HMI_STYLESHEET, /data-car-visual-mode="stage"/);
  assert.match(CAR_HMI_STYLESHEET, /#car-visual-mode-switch/);
  assert.match(CAR_HMI_STYLESHEET, /#stage-lyrics/);
  assert.match(CAR_HMI_STYLESHEET, /prefers-reduced-motion/);
});

test('car visual runtime encodes music-class default and stage maximization probes', () => {
  assert.match(CAR_VISUAL_RUNTIME_SOURCE, /MineradioCarVisual/);
  assert.match(CAR_VISUAL_RUNTIME_SOURCE, /modes:\s*MODES/);
  assert.match(CAR_VISUAL_RUNTIME_SOURCE, /drive/);
  assert.match(CAR_VISUAL_RUNTIME_SOURCE, /cruise/);
  assert.match(CAR_VISUAL_RUNTIME_SOURCE, /stage/);
  assert.match(CAR_VISUAL_RUNTIME_SOURCE, /mineradio\.car\.visualMode/);
  assert.match(CAR_VISUAL_RUNTIME_SOURCE, /fx-intensity/);
  assert.match(CAR_VISUAL_RUNTIME_SOURCE, /fx-cineshake/);
  assert.match(CAR_VISUAL_RUNTIME_SOURCE, /initial = 'drive'/);
  assert.match(CAR_VISUAL_RUNTIME_SOURCE, /desktopLyrics/);
  // Upstream APK hooks used for stage maximize
  assert.match(CAR_VISUAL_RUNTIME_SOURCE, /setPreset/);
  assert.match(CAR_VISUAL_RUNTIME_SOURCE, /toggleFx/);
  assert.match(CAR_VISUAL_RUNTIME_SOURCE, /setShelfMode/);
  assert.match(CAR_VISUAL_RUNTIME_SOURCE, /setRenderQuality/);
  assert.match(CAR_VISUAL_RUNTIME_SOURCE, /quality:\s*'ultra'/);
  assert.match(CAR_VISUAL_RUNTIME_SOURCE, /preset:\s*0/);
  assert.match(CAR_VISUAL_RUNTIME_SOURCE, /floatLayer:\s*true/);
  assert.match(CAR_VISUAL_RUNTIME_SOURCE, /cinema:\s*true/);
  assert.match(CAR_VISUAL_RUNTIME_SOURCE, /applyStageNow/);
  assert.match(CAR_VISUAL_RUNTIME_SOURCE, /STAGE_RETRY_MS/);
  assert.match(CAR_VISUAL_RUNTIME_SOURCE, /applyCoverParticleResolution/);
  assert.match(CAR_VISUAL_RUNTIME_SOURCE, /applyCoverResolutionSharp/);
  assert.match(CAR_VISUAL_RUNTIME_SOURCE, /installCoverSharpnessHooks/);
  assert.match(CAR_VISUAL_RUNTIME_SOURCE, /coverRes:\s*2\.05/);
  assert.match(CAR_VISUAL_RUNTIME_SOURCE, /Math\.min\(2\.2,/);
  assert.match(CAR_VISUAL_RUNTIME_SOURCE, /Math\.min\(300,/);
  assert.match(CAR_VISUAL_RUNTIME_SOURCE, /return 1024/);
  // Preset must run before cover res so emily mesh is not left soft/coarse.
  assert.match(
    CAR_VISUAL_RUNTIME_SOURCE,
    /applyPreset\([\s\S]*applyQuality\([\s\S]*applyCoverResolutionSharp/,
  );
  assert.doesNotMatch(CAR_VISUAL_RUNTIME_SOURCE, /eval\(/);
});

test('car stage CSS fully opens the particle canvas and strengthens lyric stage', () => {
  assert.match(CAR_HMI_STYLESHEET, /Do NOT paint WebGL canvases with CSS opacity/);
  assert.match(CAR_HMI_STYLESHEET, /#canvas-container[\s\S]*opacity:\s*1\s*!important/);
  assert.match(CAR_HMI_STYLESHEET, /data-car-visual-mode="stage"[\s\S]*#canvas-container[\s\S]*opacity:\s*1/);
  assert.match(CAR_HMI_STYLESHEET, /#lyric-float-curr/);
  assert.match(CAR_HMI_STYLESHEET, /drop-shadow\(0 10px 36px/);
  assert.match(CAR_HMI_STYLESHEET, /#bottom-bar\.stage-mode/);
  assert.doesNotMatch(
    CAR_HMI_STYLESHEET,
    /#canvas-container[\s\S]{0,80}opacity:\s*var\(--car-particle-opacity\)/,
  );
});

test('patchCarHmiAssets writes MENC css, runtime and patched index', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-car-hmi-'));
  const assetDir = path.join(root, 'assets', 'mineradio');
  fs.mkdirSync(assetDir, { recursive: true });
  const plain = '<!doctype html><html><head></head><body><div id="canvas-container"></div></body></html>';
  fs.writeFileSync(path.join(assetDir, 'index.html'), encryptMineradioAsset(Buffer.from(plain, 'utf8')));

  patchCarHmiAssets(root);

  const index = decryptMineradioAsset(fs.readFileSync(path.join(assetDir, 'index.html'))).toString('utf8');
  assert.match(index, /car-hmi\.css/);
  assert.match(index, /car-visual-runtime\.js/);
  assert.match(index, /car-login-entry/);
  assert.match(index, /data-car-visual-mode="drive"/);

  const css = decryptMineradioAsset(fs.readFileSync(path.join(assetDir, 'car-hmi.css'))).toString('utf8');
  assert.match(css, /#car-visual-mode-switch/);

  const runtime = decryptMineradioAsset(
    fs.readFileSync(path.join(assetDir, CAR_VISUAL_RUNTIME_NAME)),
  ).toString('utf8');
  assert.match(runtime, /MineradioCarVisual/);
});

test('car APK build applies the HMI asset overlay after decoding the original APK', () => {
  const buildScript = fs.readFileSync(
    path.join(__dirname, '../scripts/build-car-apk.sh'),
    'utf8',
  );

  assert.match(buildScript, /patch-car-hmi-assets\.js" "\$DECODED_DIR"/);
  assert.match(buildScript, /--ks-pass "env:MINERADIO_CAR_KEYSTORE_PASSWORD"/);
  assert.match(buildScript, /--key-pass "env:MINERADIO_CAR_KEYSTORE_PASSWORD"/);
  assert.doesNotMatch(buildScript, /pass:\$KEY_PASSWORD/);
  assert.match(buildScript, /Missing car signing keystore/);
});
