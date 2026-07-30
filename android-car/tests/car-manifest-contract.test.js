'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { patchManifest } = require('../scripts/patch-manifest');

const sourceManifest = `<?xml version="1.0" encoding="utf-8" standalone="no"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.mineradio.app">
  <application android:debuggable="true" android:label="Mineradio">
    <activity android:name="com.mineradio.app.MainActivity" android:screenOrientation="portrait">
      <intent-filter>
        <action android:name="android.intent.action.MAIN"/>
        <category android:name="android.intent.category.LAUNCHER"/>
      </intent-filter>
    </activity>
    <activity android:name="com.mineradio.app.crash.CrashActivity" android:screenOrientation="portrait"/>
    <activity android:name="com.mineradio.app.LandscapeWebActivity" android:screenOrientation="landscape"/>
  </application>
</manifest>`;

test('car patch makes the immersive landscape screen the only launcher', () => {
  const patched = patchManifest(sourceManifest);

  assert.match(patched, /<activity\b[^>]*android:name="com\.mineradio\.app\.LandscapeWebActivity"[^>]*android:screenOrientation="landscape"[^>]*android:exported="true"[^>]*>[\s\S]*?<action android:name="android\.intent\.action\.MAIN"\/>[\s\S]*?<category android:name="android\.intent\.category\.LAUNCHER"\/>[\s\S]*?<category android:name="android\.intent\.category\.CAR_LAUNCHER"\/>[\s\S]*?<\/activity>/);
  const mainActivity = patched.match(/<activity\b(?=[^>]*android:name="com\.mineradio\.app\.MainActivity")[^>]*>[\s\S]*?<\/activity>/)[0];
  assert.doesNotMatch(mainActivity, /android\.intent\.action\.MAIN/);
});

test('car patch removes portrait activity constraints and allows large external displays', () => {
  const patched = patchManifest(sourceManifest);

  assert.match(patched, /<application\b[^>]*android:resizeableActivity="true"/);
  assert.doesNotMatch(patched, /android:screenOrientation="portrait"/);
  assert.match(patched, /android:configChanges="[^"]*orientation[^"]*screenSize[^"]*smallestScreenSize[^"]*screenLayout[^"]*uiMode[^"]*"/);
});
