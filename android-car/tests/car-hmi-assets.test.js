const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decryptMineradioAsset,
  encryptMineradioAsset,
  injectCarHmiStylesheet,
  CAR_HMI_STYLESHEET,
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
  assert.equal((twice.match(/car-hmi\.css/g) || []).length, 1);
  assert.equal((twice.match(/car-login-entry/g) || []).length, 1);
});

test('car HMI injection requires a real stylesheet link, not a filename in page text', () => {
  const document = '<html><head><!-- car-hmi.css is reserved --></head><body></body></html>';
  const patched = injectCarHmiStylesheet(document);

  assert.match(patched, /<link rel="stylesheet" href="car-hmi\.css">/);
  assert.equal((patched.match(/car-hmi\.css/g) || []).length, 2);
});

test('car HMI stylesheet defines large text, touch targets, quieter background and an explicit login action', () => {
  assert.match(CAR_HMI_STYLESHEET, /@media \(min-width: 1548px\) and \(min-height: 540px\)/);
  assert.doesNotMatch(CAR_HMI_STYLESHEET, /@media \(min-width: 960px\) and \(min-height: 540px\)/);
  assert.match(CAR_HMI_STYLESHEET, /--car-touch-target:\s*72px/);
  assert.match(CAR_HMI_STYLESHEET, /--car-primary-action:\s*96px/);
  assert.match(CAR_HMI_STYLESHEET, /font-size:\s*24px/);
  assert.match(CAR_HMI_STYLESHEET, /#trial-login-btn/);
  assert.match(CAR_HMI_STYLESHEET, /#car-login-entry/);
  assert.match(CAR_HMI_STYLESHEET, /#trial-banner[\s\S]*top:\s*128px/);
  assert.match(CAR_HMI_STYLESHEET, /#fx-fab\s*\{[\s\S]*bottom:\s*192px/);
  assert.match(CAR_HMI_STYLESHEET, /#bottom-bar > #controls > \.control-cluster > \.ctrl-btn/);
  assert.match(CAR_HMI_STYLESHEET, /#audio-effect-control/);
  assert.match(CAR_HMI_STYLESHEET, /#home-recent-panel/);
  assert.match(CAR_HMI_STYLESHEET, /#playlist-toggle/);
  assert.match(CAR_HMI_STYLESHEET, /#bottom-bar/);
  assert.match(CAR_HMI_STYLESHEET, /#canvas-container/);
});

test('car APK build applies the HMI asset overlay after decoding the original APK', () => {
  const buildScript = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../scripts/build-car-apk.sh'),
    'utf8',
  );

  assert.match(buildScript, /patch-car-hmi-assets\.js" "\$DECODED_DIR"/);
  assert.match(buildScript, /--ks-pass "env:MINERADIO_CAR_KEYSTORE_PASSWORD"/);
  assert.match(buildScript, /--key-pass "env:MINERADIO_CAR_KEYSTORE_PASSWORD"/);
  assert.doesNotMatch(buildScript, /pass:\$KEY_PASSWORD/);
  assert.match(buildScript, /Missing car signing keystore/);
});
