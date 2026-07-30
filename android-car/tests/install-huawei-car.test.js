'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..', '..');
const script = path.join(root, 'android-car', 'scripts', 'install-huawei-car.sh');

test('Huawei installer follows the Lyra user-12 flow and restores PackageInstaller state', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-car-install-'));
  const apk = path.join(tmp, 'Mineradio.apk');
  const adb = path.join(tmp, 'fake-adb');
  const log = path.join(tmp, 'adb.log');
  fs.writeFileSync(apk, 'not-a-real-apk');
  fs.writeFileSync(adb, `#!/usr/bin/env bash
set -euo pipefail
{ printf 'adb'; for arg in "$@"; do printf ' <%s>' "$arg"; done; printf '\\n'; } >> "$FAKE_ADB_LOG"
case " $* " in
  *' get-state '*) echo device ;;
  *' shell pm path --user 12 com.mineradio.app '*) echo 'package:/data/app/com.mineradio.app/base.apk' ;;
  *' shell dumpsys package com.mineradio.app '*) printf 'versionName=1.1.7.0\\nversionCode=4107000\\ninstallerPackageName=com.huawei.appinstaller.car\\n' ;;
esac
`);
  fs.chmodSync(adb, 0o755);

  const result = spawnSync('bash', [script, 'TEST-SERIAL', apk], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ADB: adb, FAKE_ADB_LOG: log },
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = fs.readFileSync(log, 'utf8');
  assert.match(calls, /<shell> <pm> <disable-user> <--user> <12> <com\.android\.packageinstaller>/);
  assert.match(calls, /<shell> <pm> <disable-user> <--user> <0> <com\.android\.packageinstaller>/);
  assert.match(calls, /<push> <.*Mineradio\.apk> <\/data\/local\/tmp\/Mineradio-1\.1\.7\.0-huawei-android12-car\.apk>/);
  assert.match(calls, /<shell> <pm> <install> <-r> <-d> <-g> <-t> <-i> <com\.huawei\.appinstaller\.car> <--user> <12> <\/data\/local\/tmp\/Mineradio-1\.1\.7\.0-huawei-android12-car\.apk>/);
  assert.match(calls, /<shell> <pm> <path> <--user> <12> <com\.mineradio\.app>/);
  assert.match(calls, /<shell> <am> <force-stop> <--user> <12> <com\.mineradio\.app>/);
  assert.match(calls, /<shell> <am> <start> <--user> <12> <--windowingMode> <1> <-W> <-n> <com\.mineradio\.app\/.LandscapeWebActivity>/);
  assert.match(calls, /<shell> <pm> <enable> <--user> <12> <com\.android\.packageinstaller>/);
  assert.match(calls, /<shell> <pm> <enable> <--user> <0> <com\.android\.packageinstaller>/);
  assert.match(calls, /<shell> <rm> <-f> <\/data\/local\/tmp\/Mineradio-1\.1\.7\.0-huawei-android12-car\.apk>/);
});
