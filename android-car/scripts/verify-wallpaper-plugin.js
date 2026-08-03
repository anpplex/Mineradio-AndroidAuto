#!/usr/bin/env node
'use strict';

/**
 * WP-09 static verifier for three-package wallpaper plugin loop (Task 9).
 *
 * Packages:
 *   Mineradio  com.mineradio.app
 *   Plugin     com.motif.wallpaperengine  (Provider + process :we_runtime)
 *   Official   io.wallpaperengine.weclient (BrowseActivity / WEWallpaperService)
 *
 * Checks (from structured report or tool output):
 *   package names, provider authority/process, arm64-v8a, apksigner/zipalign/aapt,
 *   certificate sha256, split signer uniqueness, mineradioCallerCertSha256 allowlist
 *   match against Mineradio APK actual signing cert.
 *
 * Shell default is query-only (no uninstall/pm clear). Fake fixtures cover:
 * wrongPackage, missingProvider, missingWeRuntime, certMismatch,
 * splitSignerMismatch, officialMissing, apkPathMissing, BrowseActivity drift.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const PACKAGES = Object.freeze({
  mineradio: 'com.mineradio.app',
  plugin: 'com.motif.wallpaperengine',
  official: 'io.wallpaperengine.weclient',
});

const PLUGIN_PROVIDER_AUTHORITY = 'com.motif.wallpaperengine.control';
const PLUGIN_RUNTIME_PROCESS = ':we_runtime';
const OFFICIAL_BROWSE = 'io.wallpaperengine.weclient.BrowseActivity';
const OFFICIAL_WALLPAPER = 'io.wallpaperengine.weclient.WEWallpaperService';
const ABI = 'arm64-v8a';
const BUILD_PROP_CALLER_CERT = 'mineradioCallerCertSha256';

const FIXTURE_NAMES = Object.freeze([
  'wrongPackage',
  'missingProvider',
  'missingWeRuntime',
  'certMismatch',
  'splitSignerMismatch',
  'officialMissing',
  'apkPathMissing',
]);

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * @typedef {object} PackageReport
 * @property {string} packageName
 * @property {string} [versionName]
 * @property {number} [versionCode]
 * @property {string} [apkPath]
 * @property {string} [apkSha256]
 * @property {string} [certificateSha256]
 * @property {string[]} [abis]
 * @property {boolean} [zipAligned]
 * @property {boolean} [apkSignerVerified]
 * @property {boolean} [aaptOk]
 * @property {string} [providerAuthority]
 * @property {string} [providerProcess]
 * @property {string} [callerCertMeta]
 * @property {string} [browseActivity]
 * @property {string} [wallpaperService]
 * @property {boolean} [exportedBrowse]
 * @property {string[]} [splitApkSha256]
 * @property {string[]} [splitCertificateSha256]
 */

/**
 * Validate a three-package static report. Pure — no shell.
 * @param {{mineradio: PackageReport, plugin: PackageReport, official?: PackageReport|null, splits?: PackageReport[]}} report
 */
function verifyStaticReport(report) {
  const errors = [];
  const warnings = [];

  if (!report || typeof report !== 'object') {
    return { ok: false, errors: ['report missing'], code: 'apkPathMissing' };
  }

  const m = report.mineradio;
  const p = report.plugin;
  const o = report.official;

  if (!m || !m.apkPath) {
    errors.push('Mineradio apkPathMissing');
    return { ok: false, errors, code: 'apkPathMissing' };
  }
  if (!p || !p.apkPath) {
    errors.push('Plugin apkPathMissing');
    return { ok: false, errors, code: 'apkPathMissing' };
  }

  if (m.packageName !== PACKAGES.mineradio) {
    errors.push(`wrongPackage mineradio=${m.packageName}`);
  }
  if (p.packageName !== PACKAGES.plugin) {
    errors.push(`wrongPackage plugin=${p.packageName}`);
  }

  if (!p.providerAuthority || p.providerAuthority !== PLUGIN_PROVIDER_AUTHORITY) {
    errors.push('missingProvider authority');
  }
  if (!p.providerProcess || !String(p.providerProcess).includes('we_runtime')) {
    errors.push('missingWeRuntime process');
  }

  const needAbi = (pkg, label) => {
    const abis = pkg.abis || [];
    if (!abis.includes(ABI) && !abis.includes('arm64-v8a')) {
      errors.push(`${label} missing arm64-v8a`);
    }
  };
  needAbi(m, 'mineradio');
  needAbi(p, 'plugin');

  if (m.zipAligned === false || m.apkSignerVerified === false || m.aaptOk === false) {
    errors.push('mineradio apksigner/zipalign/aapt failed');
  }
  if (p.zipAligned === false || p.apkSignerVerified === false || p.aaptOk === false) {
    errors.push('plugin apksigner/zipalign/aapt failed');
  }

  // Plugin allowlist must equal this-cycle Mineradio certificate sha256
  const mineradioCert = String(m.certificateSha256 || '').toLowerCase();
  const pluginAllow = String(p.callerCertMeta || p.mineradioCallerCertSha256 || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(mineradioCert)) {
    errors.push('mineradio certificate sha256 missing/invalid');
  }
  if (pluginAllow && mineradioCert && pluginAllow !== mineradioCert) {
    errors.push('certMismatch plugin allowlist != mineradio certificate');
  }
  if (!pluginAllow) {
    warnings.push('plugin caller cert meta-data missing (mineradioCallerCertSha256)');
  }

  if (o == null) {
    // officialMissing — device-only observation allowed but blocks continuous E2
    warnings.push('officialMissing — continuous E2 not advanced');
  } else {
    if (o.packageName !== PACKAGES.official) {
      errors.push(`wrongPackage official=${o.packageName}`);
    }
    if (o.browseActivity && o.browseActivity !== OFFICIAL_BROWSE) {
      warnings.push(`BrowseActivity drift: ${o.browseActivity}`);
    }
    if (o.wallpaperService && o.wallpaperService !== OFFICIAL_WALLPAPER) {
      warnings.push(`WEWallpaperService drift: ${o.wallpaperService}`);
    }
    needAbi(o, 'official');
  }

  // split: all certificates sort -u must be exactly one value
  const splitCerts = [];
  if (Array.isArray(report.splits)) {
    for (const s of report.splits) {
      if (s && s.certificateSha256) splitCerts.push(String(s.certificateSha256).toLowerCase());
    }
  }
  if (p.splitCertificateSha256) {
    for (const c of p.splitCertificateSha256) splitCerts.push(String(c).toLowerCase());
  }
  if (splitCerts.length) {
    const unique = [...new Set(splitCerts)];
    if (unique.length !== 1) {
      errors.push('splitSignerMismatch unique cert count != 1');
    }
  }

  const code = errors.find((e) => e.includes('wrongPackage'))
    ? 'wrongPackage'
    : errors.find((e) => e.includes('missingProvider'))
      ? 'missingProvider'
      : errors.find((e) => e.includes('missingWeRuntime'))
        ? 'missingWeRuntime'
        : errors.find((e) => e.includes('certMismatch'))
          ? 'certMismatch'
          : errors.find((e) => e.includes('splitSignerMismatch'))
            ? 'splitSignerMismatch'
            : errors.find((e) => e.includes('apkPathMissing'))
              ? 'apkPathMissing'
              : errors.length
                ? 'STATIC_FAIL'
                : o == null
                  ? 'officialMissing'
                  : 'OK';

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    code,
    packages: PACKAGES,
    abi: ABI,
    tools: ['aapt', 'apksigner', 'zipalign'],
  };
}

/** Fixture builders for RED/GREEN unit tests. */
function buildFixture(name, overrides = {}) {
  const baseMineradio = {
    packageName: PACKAGES.mineradio,
    apkPath: '/tmp/mineradio.apk',
    apkSha256: 'a'.repeat(64),
    certificateSha256: 'b'.repeat(64),
    abis: [ABI],
    zipAligned: true,
    apkSignerVerified: true,
    aaptOk: true,
    versionName: '1.0.0',
    versionCode: 1,
  };
  const basePlugin = {
    packageName: PACKAGES.plugin,
    apkPath: '/tmp/plugin.apk',
    apkSha256: 'c'.repeat(64),
    certificateSha256: 'd'.repeat(64),
    abis: [ABI],
    zipAligned: true,
    apkSignerVerified: true,
    aaptOk: true,
    providerAuthority: PLUGIN_PROVIDER_AUTHORITY,
    providerProcess: ':we_runtime',
    callerCertMeta: 'b'.repeat(64),
    mineradioCallerCertSha256: 'b'.repeat(64),
  };
  const baseOfficial = {
    packageName: PACKAGES.official,
    apkPath: '/tmp/we.apk',
    apkSha256: 'e'.repeat(64),
    certificateSha256: 'f'.repeat(64),
    abis: [ABI],
    zipAligned: true,
    apkSignerVerified: true,
    aaptOk: true,
    browseActivity: OFFICIAL_BROWSE,
    wallpaperService: OFFICIAL_WALLPAPER,
    exportedBrowse: true,
  };

  switch (name) {
    case 'correctThreePackage':
      return {
        mineradio: { ...baseMineradio, ...overrides.mineradio },
        plugin: { ...basePlugin, ...overrides.plugin },
        official: { ...baseOfficial, ...overrides.official },
      };
    case 'wrongPackage':
      return {
        mineradio: { ...baseMineradio, packageName: 'com.evil.app' },
        plugin: { ...basePlugin },
        official: { ...baseOfficial },
      };
    case 'missingProvider':
      return {
        mineradio: { ...baseMineradio },
        plugin: { ...basePlugin, providerAuthority: '' },
        official: { ...baseOfficial },
      };
    case 'missingWeRuntime':
      return {
        mineradio: { ...baseMineradio },
        plugin: { ...basePlugin, providerProcess: '' },
        official: { ...baseOfficial },
      };
    case 'certMismatch':
      return {
        mineradio: { ...baseMineradio, certificateSha256: '1'.repeat(64) },
        plugin: {
          ...basePlugin,
          callerCertMeta: '2'.repeat(64),
          mineradioCallerCertSha256: '2'.repeat(64),
        },
        official: { ...baseOfficial },
      };
    case 'splitSignerMismatch':
      return {
        mineradio: { ...baseMineradio },
        plugin: {
          ...basePlugin,
          splitCertificateSha256: ['a'.repeat(64), 'b'.repeat(64)],
        },
        official: { ...baseOfficial },
        splits: [
          { certificateSha256: 'a'.repeat(64) },
          { certificateSha256: 'b'.repeat(64) },
        ],
      };
    case 'officialMissing':
      return {
        mineradio: { ...baseMineradio },
        plugin: { ...basePlugin },
        official: null,
      };
    case 'apkPathMissing':
      return {
        mineradio: { packageName: PACKAGES.mineradio },
        plugin: { packageName: PACKAGES.plugin },
        official: null,
      };
    default:
      throw new Error(`unknown fixture: ${name}`);
  }
}

function assertVerifyFixtures() {
  const results = [];
  const expectFail = [
    'wrongPackage',
    'missingProvider',
    'missingWeRuntime',
    'certMismatch',
    'splitSignerMismatch',
    'apkPathMissing',
  ];
  for (const name of expectFail) {
    const r = verifyStaticReport(buildFixture(name));
    results.push({ name, ok: r.ok === false, code: r.code });
    if (r.ok !== false) {
      return {
        ok: false,
        message: `fixture ${name} should fail`,
        results,
      };
    }
  }
  const good = verifyStaticReport(buildFixture('correctThreePackage'));
  if (!good.ok) {
    return { ok: false, message: `correctThreePackage should pass: ${good.errors}`, results };
  }
  results.push({ name: 'correctThreePackage', ok: true, code: good.code });
  const noOff = verifyStaticReport(buildFixture('officialMissing'));
  // officialMissing: errors empty, ok true but warning — continuous E2 not advanced
  results.push({
    name: 'officialMissing',
    ok: noOff.ok === true && noOff.code === 'officialMissing',
    code: noOff.code,
  });
  return {
    ok: results.every((x) => x.ok),
    results,
    FIXTURE_NAMES,
    PACKAGES,
    BUILD_PROP_CALLER_CERT,
  };
}

function runToolsOnApk(apkPath, buildTools) {
  const out = {
    apkPath,
    exists: fs.existsSync(apkPath),
  };
  if (!out.exists) return out;
  out.apkSha256 = sha256File(apkPath);
  if (buildTools) {
    const aapt = path.join(buildTools, 'aapt');
    const apksigner = path.join(buildTools, 'apksigner');
    const zipalign = path.join(buildTools, 'zipalign');
    if (fs.existsSync(aapt)) {
      const r = spawnSync(aapt, ['dump', 'badging', apkPath], { encoding: 'utf8' });
      out.aaptOk = r.status === 0;
      out.aaptStdout = r.stdout || '';
      const pm = /package: name='([^']+)'/.exec(out.aaptStdout);
      if (pm) out.packageName = pm[1];
      const ab = [...out.aaptStdout.matchAll(/native-code: '([^']+)'/g)].map((m) => m[1]);
      if (ab.length) out.abis = ab.flatMap((s) => s.split(/\s+/));
    }
    if (fs.existsSync(apksigner)) {
      const r = spawnSync(apksigner, ['verify', '--print-certs', apkPath], {
        encoding: 'utf8',
      });
      out.apkSignerVerified = r.status === 0;
      out.apksignerStdout = `${r.stdout || ''}\n${r.stderr || ''}`;
      const cert = /SHA-256 digest:\s*([0-9a-fA-F:]+)/.exec(out.apksignerStdout);
      if (cert) {
        out.certificateSha256 = cert[1].replace(/:/g, '').toLowerCase();
      }
    }
    if (fs.existsSync(zipalign)) {
      const r = spawnSync(zipalign, ['-c', '-v', '4', apkPath], { encoding: 'utf8' });
      out.zipAligned = r.status === 0;
    }
  }
  return out;
}

/**
 * WP-10A E3: parse adb `content call` Bundle dump into structured fields.
 * Empty Bundle / code=10 / timeout / cold-start handled by callers.
 * Never treats whole-line grep as a Gate.
 *
 * @param {string} raw
 * @returns {{ok:boolean, code?:number, callId?:string, operationId?:string,
 *   actionEpoch?:number, actionToken?:string, runtimePid?:number,
 *   operationState?:string, bindingState?:string, sourceConsumed?:boolean,
 *   errors:string[]}}
 */
function parseContentCallBundle(raw) {
  const errors = [];
  if (raw == null || String(raw).trim() === '') {
    return { ok: false, errors: ['empty Bundle'], code: null };
  }
  const text = String(raw);
  const out = { errors: [] };
  const codeM = /(?:Result: Bundle\[|Bundle\[|{)?[^\n]*\bcode[=:](\d+)/i.exec(text)
    || /\bcode\s*[:=]\s*(\d+)/i.exec(text);
  if (codeM) out.code = Number(codeM[1]);
  const pick = (key) => {
    const re = new RegExp(`(?:^|[,\\[{\\s])${key}\\s*[=:]\\s*([^,\\]}\\s]+)`, 'i');
    const m = re.exec(text);
    if (!m) return undefined;
    return m[1].replace(/^["']|["']$/g, '').replace(/\]+$/, '');
  };
  out.callId = pick('callId');
  out.operationId = pick('operationId');
  const epoch = pick('actionEpoch');
  if (epoch != null && epoch !== '') {
    const n = Number(epoch);
    if (Number.isFinite(n)) out.actionEpoch = n;
  }
  out.actionToken = pick('actionToken');
  const pid = pick('runtimePid');
  if (pid != null && pid !== '') {
    const n = Number(pid);
    if (Number.isFinite(n)) out.runtimePid = n;
  }
  out.operationState = pick('operationState');
  out.bindingState = pick('bindingState');
  const sc = pick('sourceConsumed');
  if (sc != null) out.sourceConsumed = /^(true|1|yes)$/i.test(sc);
  // Fallback for Android Bundle dump: key=value forms without word boundaries.
  if (out.actionToken == null) {
    const tm = /actionToken[=:]([0-9a-fA-F-]{8,})/.exec(text);
    if (tm) out.actionToken = tm[1];
  }
  if (out.sourceConsumed === undefined) {
    const sm = /sourceConsumed[=:](true|false)/i.exec(text);
    if (sm) out.sourceConsumed = /^true$/i.test(sm[1]);
  }
  if (out.code === undefined) errors.push('code missing');
  out.errors = errors;
  out.ok = errors.length === 0;
  return out;
}

/** Alias for Bundle parser (RED capacity pin name). */
const parseProviderBundle = parseContentCallBundle;

const E3_FIXTURE_NAMES = Object.freeze([
  'missingUser12',
  'shellCallerOnly',
  'actionTokenMissing',
  'actionTokenReplay',
  'confirmUserActionSkipped',
  'sourceConsumedMissing',
  'sourceUriNotRevoked',
  'runtimePidEmpty',
  'runtimePidDuplicate',
  'runtimePidEqualsMineradio',
  'correctE3',
]);

/**
 * Build structured E3 evidence report fixture for unit tests.
 * @param {string} name
 * @param {object} [overrides]
 */
function buildE3Fixture(name, overrides = {}) {
  const good = {
    targetUser: 12,
    currentUser: 12,
    caller: 'mineradio-ui', // not shell
    packagesOnUser12: [
      PACKAGES.mineradio,
      PACKAGES.plugin,
      PACKAGES.official,
    ],
    callId: '00000000-0000-4000-8000-000000000001',
    operationId: 'op-stable-1',
    actionEpoch: 1,
    actionToken: 'rand-token-once',
    actionTokenConsumed: true,
    confirmUserActionCalled: true,
    importMpkgCalled: true,
    sourceConsumed: true,
    sourceUriRevoked: true,
    runtimePid: 4242,
    mineradioPid: 1111,
    pluginRuntimePids: [4242],
    shellCallerUsedForE3: false,
    ...overrides,
  };
  switch (name) {
    case 'correctE3':
      return good;
    case 'missingUser12':
      return { ...good, targetUser: 0, currentUser: 0, packagesOnUser12: [] };
    case 'shellCallerOnly':
      return { ...good, caller: 'shell', shellCallerUsedForE3: true };
    case 'actionTokenMissing':
      return { ...good, actionToken: '', actionTokenConsumed: false };
    case 'actionTokenReplay':
      return { ...good, actionTokenConsumed: false, actionTokenReplayed: true };
    case 'confirmUserActionSkipped':
      return { ...good, confirmUserActionCalled: false, actionTokenConsumed: false };
    case 'sourceConsumedMissing':
      return { ...good, sourceConsumed: false };
    case 'sourceUriNotRevoked':
      return { ...good, sourceUriRevoked: false };
    case 'runtimePidEmpty':
      return { ...good, runtimePid: null, pluginRuntimePids: [] };
    case 'runtimePidDuplicate':
      return { ...good, pluginRuntimePids: [4242, 4242], runtimePid: 4242 };
    case 'runtimePidEqualsMineradio':
      return { ...good, runtimePid: 1111, mineradioPid: 1111, pluginRuntimePids: [1111] };
    default:
      throw new Error(`unknown E3 fixture: ${name}`);
  }
}

/**
 * Verify E3 evidence report (Task 10A). Pure — no adb.
 * Shell caller / missing token / PID isolation failures are fail-closed.
 * @param {object} report
 */
function verifyE3Evidence(report) {
  const errors = [];
  if (!report || typeof report !== 'object') {
    return { ok: false, code: 'E3_REPORT_MISSING', errors: ['report missing'] };
  }
  if (Number(report.targetUser) !== 12 || Number(report.currentUser) !== 12) {
    errors.push('missingUser12');
  }
  const pkgs = report.packagesOnUser12 || [];
  for (const p of [PACKAGES.mineradio, PACKAGES.plugin, PACKAGES.official]) {
    if (!pkgs.includes(p)) errors.push(`package missing on user12: ${p}`);
  }
  if (report.shellCallerUsedForE3 === true || report.caller === 'shell') {
    errors.push('shellCallerOnly');
  }
  if (!report.actionToken) errors.push('actionTokenMissing');
  if (report.actionTokenReplayed === true || report.actionTokenConsumed === false) {
    if (report.actionTokenReplayed) errors.push('actionTokenReplay');
  }
  if (!report.confirmUserActionCalled) errors.push('confirmUserActionSkipped');
  if (report.sourceConsumed !== true) errors.push('sourceConsumedMissing');
  if (report.sourceUriRevoked !== true) errors.push('sourceUriNotRevoked');
  const rp = report.runtimePid;
  if (rp == null || rp === '' || Number(rp) <= 0) errors.push('runtimePidEmpty');
  const pids = report.pluginRuntimePids || (rp != null ? [rp] : []);
  if (pids.length !== 1) {
    if (pids.length > 1) errors.push('runtimePidDuplicate');
    else if (!errors.includes('runtimePidEmpty')) errors.push('runtimePidEmpty');
  }
  if (
    report.mineradioPid != null &&
    rp != null &&
    Number(rp) === Number(report.mineradioPid)
  ) {
    errors.push('runtimePidEqualsMineradio');
  }
  if (!report.importMpkgCalled) errors.push('importMpkg skipped');
  if (!report.callId || !report.operationId) errors.push('callId/operationId missing');

  const code = errors[0] || 'OK';
  return {
    ok: errors.length === 0,
    code,
    errors,
    evidenceLevel: errors.length === 0 ? 'E3' : 'E3-OBSERVED',
  };
}

/** Alias expected by RED capacity pin. */
const verifyE3 = verifyE3Evidence;

function assertE3Fixtures() {
  const results = [];
  for (const name of E3_FIXTURE_NAMES) {
    if (name === 'correctE3') continue;
    const r = verifyE3Evidence(buildE3Fixture(name));
    const ok = r.ok === false;
    results.push({ name, ok, code: r.code });
    if (!ok) {
      return { ok: false, message: `fixture ${name} should fail`, results };
    }
  }
  const good = verifyE3Evidence(buildE3Fixture('correctE3'));
  if (!good.ok) {
    return { ok: false, message: `correctE3 should pass: ${good.errors}`, results };
  }
  results.push({ name: 'correctE3', ok: true, code: good.code });
  return { ok: results.every((x) => x.ok), results, E3_FIXTURE_NAMES };
}

/** WP-10B / E4: Scene + Video dual-frame render evidence (Task 10B). */
const E4_FIXTURE_NAMES = Object.freeze([
  'blackScreen',
  'solidColorOnly',
  'activityLogOnly',
  'missingWindowSurface',
  'missingFramePair',
  'dynamicFramesIdentical',
  'stateOnlyStaged',
  'forgedPreviewReady',
  'sceneOnlyMissingVideo',
  'videoOnlyMissingScene',
  'correctE4',
]);

/**
 * Build structured E4 evidence report fixture.
 * @param {string} name
 * @param {object} [overrides]
 */
function buildE4Fixture(name, overrides = {}) {
  const frameGood = {
    sha256: 'a'.repeat(64),
    width: 1920,
    height: 1080,
    notBlack: true,
    notSolidColor: true,
  };
  const frame2 = {
    sha256: 'b'.repeat(64),
    width: 1920,
    height: 1080,
    notBlack: true,
    notSolidColor: true,
  };
  const sample = (type) => ({
    type,
    basename: `${type}-sample.mpkg`,
    bytes: 1024,
    sha256: (type === 'scene' ? 'c' : 'd').repeat(64),
    operationId: `op-${type}-1`,
    callId: `call-${type}-1`,
    actionEpoch: 1,
    operationState: 'ENGINE_LAUNCHED',
    frames: [frameGood, frame2],
    framesDistinct: true,
    hasWindow: true,
    hasSurface: true,
    humanRecognizable: true,
  });
  const good = {
    targetUser: 12,
    parentTaskId: 'WP-10A',
    parentManifestSha256: 'e'.repeat(64),
    requiredEffectiveDone: true,
    shellCallerUsedForE4: false,
    caller: 'mineradio-ui',
    scene: sample('scene'),
    video: sample('video'),
    ...overrides,
  };
  switch (name) {
    case 'correctE4':
      return good;
    case 'blackScreen':
      return {
        ...good,
        scene: {
          ...good.scene,
          frames: [
            { ...frameGood, notBlack: false, sha256: '1'.repeat(64) },
            { ...frame2, notBlack: false, sha256: '2'.repeat(64) },
          ],
          humanRecognizable: false,
        },
      };
    case 'solidColorOnly':
      return {
        ...good,
        video: {
          ...good.video,
          frames: [
            { ...frameGood, notSolidColor: false, sha256: '3'.repeat(64) },
            { ...frame2, notSolidColor: false, sha256: '4'.repeat(64) },
          ],
          humanRecognizable: false,
        },
      };
    case 'activityLogOnly':
      return {
        ...good,
        scene: {
          ...good.scene,
          frames: [],
          framesDistinct: false,
          hasWindow: false,
          hasSurface: false,
          humanRecognizable: false,
          logOnly: true,
        },
      };
    case 'missingWindowSurface':
      return {
        ...good,
        scene: { ...good.scene, hasWindow: false, hasSurface: false },
      };
    case 'missingFramePair':
      return {
        ...good,
        video: { ...good.video, frames: [frameGood], framesDistinct: false },
      };
    case 'dynamicFramesIdentical':
      return {
        ...good,
        scene: {
          ...good.scene,
          frames: [frameGood, { ...frameGood }],
          framesDistinct: false,
        },
      };
    case 'stateOnlyStaged':
      return {
        ...good,
        scene: { ...good.scene, operationState: 'STAGED' },
        video: { ...good.video, operationState: 'STAGED' },
      };
    case 'forgedPreviewReady':
      return {
        ...good,
        scene: {
          ...good.scene,
          operationState: 'PREVIEW_READY',
          previewReadyForged: true,
        },
      };
    case 'sceneOnlyMissingVideo':
      return { ...good, video: null };
    case 'videoOnlyMissingScene':
      return { ...good, scene: null };
    default:
      throw new Error(`unknown E4 fixture: ${name}`);
  }
}

/**
 * Verify E4 evidence (Task 10B). Pure — no adb.
 * Black/solid/log-only/missing frames/STAGED-only/forged PREVIEW_READY fail-closed.
 * @param {object} report
 */
function verifyE4Evidence(report) {
  const errors = [];
  if (!report || typeof report !== 'object') {
    return { ok: false, code: 'E4_REPORT_MISSING', errors: ['report missing'] };
  }
  if (Number(report.targetUser) !== 12) errors.push('missingUser12');
  if (report.parentTaskId !== 'WP-10A') errors.push('parentTaskMissing');
  if (
    !report.parentManifestSha256 ||
    !/^[0-9a-f]{64}$/i.test(String(report.parentManifestSha256))
  ) {
    errors.push('parentManifestMissing');
  }
  if (report.requiredEffectiveDone !== true) errors.push('parentNotEffectiveDone');
  if (report.shellCallerUsedForE4 === true || report.caller === 'shell') {
    errors.push('shellCallerOnly');
  }

  function checkSample(label, sample) {
    if (!sample || typeof sample !== 'object') {
      errors.push(`${label}Missing`);
      return;
    }
    if (sample.previewReadyForged === true) errors.push('forgedPreviewReady');
    if (sample.operationState === 'STAGED') errors.push('stateOnlyStaged');
    if (sample.operationState === 'PREVIEW_READY' && sample.previewReadyForged) {
      /* already counted */
    }
    // ENGINE_LAUNCHED or later external-proven state OK; STAGED alone is not E4.
    if (
      sample.operationState &&
      !['ENGINE_LAUNCHED', 'PREVIEW_READY', 'APPLY_ACTION_PENDING', 'APPLIED'].includes(
        sample.operationState,
      ) &&
      sample.operationState === 'STAGED'
    ) {
      /* stateOnlyStaged already */
    }
    if (sample.logOnly === true) errors.push('activityLogOnly');
    if (sample.hasWindow !== true || sample.hasSurface !== true) {
      errors.push('missingWindowSurface');
    }
    const frames = sample.frames || [];
    if (frames.length < 2) errors.push('missingFramePair');
    if (frames.length >= 2) {
      const a = frames[0] || {};
      const b = frames[1] || {};
      if (a.notBlack === false || b.notBlack === false) errors.push('blackScreen');
      if (a.notSolidColor === false || b.notSolidColor === false) {
        errors.push('solidColorOnly');
      }
      if (
        sample.framesDistinct === false ||
        (a.sha256 && b.sha256 && a.sha256 === b.sha256)
      ) {
        errors.push('dynamicFramesIdentical');
      }
    }
    if (sample.humanRecognizable !== true) {
      if (!errors.includes('blackScreen') && !errors.includes('solidColorOnly')) {
        errors.push('notHumanRecognizable');
      }
    }
  }

  if (!report.scene) {
    errors.push('sceneMissing');
    errors.push('videoOnlyMissingScene');
  } else {
    checkSample('scene', report.scene);
  }
  if (!report.video) {
    errors.push('videoMissing');
    errors.push('sceneOnlyMissingVideo');
  } else {
    checkSample('video', report.video);
  }

  const uniq = [...new Set(errors)];
  const code = uniq[0] || 'OK';
  return {
    ok: uniq.length === 0,
    code,
    errors: uniq,
    evidenceLevel: uniq.length === 0 ? 'E4' : 'E4-OBSERVED',
  };
}

const verifyE4 = verifyE4Evidence;

function assertE4Fixtures() {
  const results = [];
  for (const name of E4_FIXTURE_NAMES) {
    if (name === 'correctE4') continue;
    const r = verifyE4Evidence(buildE4Fixture(name));
    const ok = r.ok === false;
    results.push({ name, ok, code: r.code });
    if (!ok) {
      return { ok: false, message: `fixture ${name} should fail`, results };
    }
  }
  const good = verifyE4Evidence(buildE4Fixture('correctE4'));
  if (!good.ok) {
    return { ok: false, message: `correctE4 should pass: ${good.errors}`, results };
  }
  results.push({ name: 'correctE4', ok: true, code: good.code });
  return { ok: results.every((x) => x.ok), results, E4_FIXTURE_NAMES };
}


/** WP-10C / E5: current-user system wallpaper binding (Task 10C). */
const E5_FIXTURE_NAMES = Object.freeze([
  'wrongUser',
  'candidateOnly',
  'historyPackageOnly',
  'activityStillForeground',
  'engineInactive',
  'previewOnly',
  'shellCallerOnly',
  'missingActiveTarget',
  'dumpsysDrivenInternal',
  'wrongComponent',
  'correctE5',
]);

function buildE5Fixture(name, overrides = {}) {
  const good = {
    targetUser: 12,
    currentUser: 12,
    parentTaskId: 'WP-10B',
    parentManifestSha256: 'f'.repeat(64),
    requiredEffectiveDone: true,
    caller: 'mineradio-ui',
    shellCallerUsedForE5: false,
    bindingState: 'ACTIVE_TARGET',
    activePackage: 'io.wallpaperengine.weclient',
    activeComponent: 'io.wallpaperengine.weclient/io.wallpaperengine.weclient.WEWallpaperService',
    sourceGetWallpaperInfo: true,
    dumpsysDrivenInternal: false,
    wallpaperComponent: 'io.wallpaperengine.weclient/.WEWallpaperService',
    connectionActive: true,
    engineActive: true,
    homeForeground: true,
    activityStillForeground: false,
    candidateOnly: false,
    historyPackageOnly: false,
    previewOnly: false,
    boundScreenNotBlack: true,
    callId: 'e5-status-1',
    operationId: 'op-e5-1',
    actionEpoch: 1,
    code: 0,
    ...overrides,
  };
  switch (name) {
    case 'correctE5':
      return good;
    case 'wrongUser':
      return { ...good, targetUser: 0, currentUser: 0 };
    case 'candidateOnly':
      return { ...good, candidateOnly: true, wallpaperComponent: '', engineActive: false };
    case 'historyPackageOnly':
      return { ...good, historyPackageOnly: true, wallpaperComponent: '', connectionActive: false };
    case 'activityStillForeground':
      return { ...good, activityStillForeground: true, homeForeground: false };
    case 'engineInactive':
      return { ...good, engineActive: false, connectionActive: false };
    case 'previewOnly':
      return { ...good, previewOnly: true, homeForeground: false };
    case 'shellCallerOnly':
      return { ...good, caller: 'shell', shellCallerUsedForE5: true };
    case 'missingActiveTarget':
      return { ...good, bindingState: 'UNBOUND', activePackage: '', activeComponent: '' };
    case 'dumpsysDrivenInternal':
      return { ...good, dumpsysDrivenInternal: true, sourceGetWallpaperInfo: false };
    case 'wrongComponent':
      return {
        ...good,
        wallpaperComponent: 'com.android.systemui/.ImageWallpaper',
        activeComponent: 'com.android.systemui/.ImageWallpaper',
        activePackage: 'com.android.systemui',
        bindingState: 'ACTIVE_OTHER',
      };
    default:
      throw new Error(`unknown E5 fixture: ${name}`);
  }
}

function verifyE5Evidence(report) {
  const errors = [];
  if (!report || typeof report !== 'object') {
    return { ok: false, code: 'E5_REPORT_MISSING', errors: ['report missing'] };
  }
  if (Number(report.targetUser) !== 12 || Number(report.currentUser) !== 12) {
    errors.push('wrongUser');
  }
  if (report.parentTaskId !== 'WP-10B') errors.push('parentTaskMissing');
  if (
    !report.parentManifestSha256 ||
    !/^[0-9a-f]{64}$/i.test(String(report.parentManifestSha256))
  ) {
    errors.push('parentManifestMissing');
  }
  if (report.requiredEffectiveDone !== true) errors.push('parentNotEffectiveDone');
  if (report.shellCallerUsedForE5 === true || report.caller === 'shell') {
    errors.push('shellCallerOnly');
  }
  if (report.candidateOnly === true) errors.push('candidateOnly');
  if (report.historyPackageOnly === true) errors.push('historyPackageOnly');
  if (report.activityStillForeground === true) errors.push('activityStillForeground');
  if (report.previewOnly === true) errors.push('previewOnly');
  if (report.engineActive !== true || report.connectionActive !== true) {
    errors.push('engineInactive');
  }
  if (report.bindingState !== 'ACTIVE_TARGET') errors.push('missingActiveTarget');
  if (report.dumpsysDrivenInternal === true || report.sourceGetWallpaperInfo !== true) {
    errors.push('dumpsysDrivenInternal');
  }
  const wc = String(report.wallpaperComponent || '');
  const ac = String(report.activeComponent || '');
  if (!wc.includes('WEWallpaperService') && !ac.includes('WEWallpaperService')) {
    errors.push('wrongComponent');
  }
  if (report.activePackage !== 'io.wallpaperengine.weclient') {
    if (!errors.includes('wrongComponent')) errors.push('wrongComponent');
  }
  if (report.code !== 0 && report.code !== undefined) errors.push('statusNotOk');
  if (report.boundScreenNotBlack !== true) errors.push('boundScreenBlack');
  if (report.homeForeground !== true && report.activityStillForeground !== true) {
    // already covered
  }
  const uniq = [...new Set(errors)];
  return {
    ok: uniq.length === 0,
    code: uniq[0] || 'OK',
    errors: uniq,
    evidenceLevel: uniq.length === 0 ? 'E5' : 'E5-OBSERVED',
  };
}

const verifyE5 = verifyE5Evidence;

function assertE5Fixtures() {
  const results = [];
  for (const name of E5_FIXTURE_NAMES) {
    if (name === 'correctE5') continue;
    const r = verifyE5Evidence(buildE5Fixture(name));
    const ok = r.ok === false;
    results.push({ name, ok, code: r.code });
    if (!ok) {
      return { ok: false, message: `fixture ${name} should fail`, results };
    }
  }
  const good = verifyE5Evidence(buildE5Fixture('correctE5'));
  if (!good.ok) {
    return { ok: false, message: `correctE5 should pass: ${good.errors}`, results };
  }
  results.push({ name: 'correctE5', ok: true, code: good.code });
  return { ok: results.every((x) => x.ok), results, E5_FIXTURE_NAMES };
}

// ---------------------------------------------------------------------------
// WP-11A recovery fault matrix (keeps evidence level E5; does not elevate).
// faultClass:
//   package_presence  — missing package detection only (no IDLE/new PID)
//   expected_error    — fixed business error codes (not auto-recovery)
//   auto_recoverable  — process kill/restart with recovery SLA <= 10s
// ---------------------------------------------------------------------------
const RECOVERY_MAX_MS = 10000;
const RECOVERY_FIXTURE_NAMES = Object.freeze([
  'missingParent',
  'wrongUser',
  'packagePresenceDemandsIdle',
  'expectedErrorWrongCode',
  'recoveryTooSlow',
  'recoverySamePid',
  'recoveryMissingRequest',
  'wrongCallerCertificate',
  'unrelatedProcessAsFailure',
  'autoRecoverableMissingBinding',
  'correctRecoveryMatrix',
]);

function _baseRecoveryMeta(overrides = {}) {
  return {
    parentTaskId: 'WP-10C',
    parentManifestSha256: 'a'.repeat(64),
    requiredEffectiveDone: true,
    serial: 'LD249H019625',
    targetUser: 12,
    currentUser: 12,
    evidenceLevel: 'E5',
    elevatedEvidenceLevel: false,
    source: 'fixture',
    ...overrides,
  };
}

function _casePackagePresence(ok = true) {
  return {
    id: 'plugin_not_installed',
    faultClass: 'package_presence',
    inject: 'pm_disable_user_plugin',
    expectedCode: 'PLUGIN_NOT_INSTALLED',
    actualCode: ok ? 'PLUGIN_NOT_INSTALLED' : 'OK',
    providerUnreachable: ok,
    runtimePid: null,
    // package_presence must NOT require IDLE / new PID
    operationState: null,
    bindingState: null,
    pass: ok,
  };
}

function _caseEngineMissing(ok = true) {
  return {
    id: 'engine_not_installed',
    faultClass: 'package_presence',
    inject: 'pm_disable_user_engine',
    expectedCode: 'ENGINE_NOT_INSTALLED',
    actualCode: ok ? 'ENGINE_NOT_INSTALLED' : 'PLUGIN_NOT_INSTALLED',
    providerUnreachable: false,
    engineMissing: true,
    runtimePid: null,
    operationState: null,
    bindingState: null,
    pass: ok,
  };
}

function _caseExpectedError(ok = true) {
  return {
    id: 'uri_permission_revoked',
    faultClass: 'expected_error',
    inject: 'revoke_uri_permission',
    expectedCode: 'URI_PERMISSION_REVOKED',
    actualCode: ok ? 'URI_PERMISSION_REVOKED' : 'UNKNOWN',
    crashOrAnr: false,
    falseStatusReport: false,
    pass: ok,
  };
}

function _caseAutoRecoverable(ok = true, kind = 'ok') {
  const base = {
    id: 'kill_plugin_runtime',
    faultClass: 'auto_recoverable',
    inject: 'kill_plugin_runtime',
    oldPid: 2345,
    newPid: 3456,
    mineradioPid: 1111,
    code: 0,
    operationState: 'IDLE',
    bindingState: 'ACTIVE_TARGET',
    requestStartedElapsedMs: 100000,
    responseElapsedMs: 102500,
    recoveryElapsedMs: 2500,
    killSecondsNotInSla: true,
    callId: 'rec-call-1',
    operationId: 'rec-op-1',
    actionEpoch: 1,
    callerPackage: 'com.mineradio.app',
    callerCertificateMatch: true,
    recoveryRequested: true,
    crashOrAnr: false,
    pass: true,
  };
  if (kind === 'tooSlow') {
    return {
      ...base,
      recoveryElapsedMs: 15000,
      responseElapsedMs: 115000,
      pass: false,
    };
  }
  if (kind === 'samePid') {
    return { ...base, newPid: 2345, pass: false };
  }
  if (kind === 'missingRequest') {
    return { ...base, recoveryRequested: false, pass: false };
  }
  if (kind === 'wrongCaller') {
    return {
      ...base,
      callerPackage: 'com.android.shell',
      callerCertificateMatch: false,
      pass: false,
    };
  }
  if (kind === 'missingBinding') {
    return {
      ...base,
      bindingState: 'UNBOUND',
      operationState: 'BUSY',
      pass: false,
    };
  }
  if (!ok) {
    return { ...base, pass: false };
  }
  return base;
}

function _caseUnrelatedCrash() {
  return {
    id: 'unrelated_process_crash',
    faultClass: 'expected_error',
    inject: 'kill_unrelated_process',
    expectedCode: 'NO_OP',
    actualCode: 'NO_OP',
    crashOrAnr: false,
    falsePositiveRecovery: false,
    pass: true,
  };
}

function buildRecoveryFixture(name, overrides = {}) {
  const meta = _baseRecoveryMeta();
  let cases;
  switch (name) {
    case 'correctRecoveryMatrix':
      cases = [
        _casePackagePresence(true),
        _caseEngineMissing(true),
        _caseExpectedError(true),
        {
          id: 'corrupt_mpkg',
          faultClass: 'expected_error',
          inject: 'corrupt_mpkg',
          expectedCode: 'CORRUPT_MPKG',
          actualCode: 'CORRUPT_MPKG',
          crashOrAnr: false,
          pass: true,
        },
        {
          id: 'protocol_version_unsupported',
          faultClass: 'expected_error',
          inject: 'protocol_v2',
          expectedCode: 'PROTOCOL_VERSION_UNSUPPORTED',
          actualCode: 'PROTOCOL_VERSION_UNSUPPORTED',
          crashOrAnr: false,
          pass: true,
        },
        {
          id: 'duplicate_operation_epoch',
          faultClass: 'expected_error',
          inject: 'duplicate_operationId_actionEpoch',
          expectedCode: 'DUPLICATE_OPERATION',
          actualCode: 'DUPLICATE_OPERATION',
          crashOrAnr: false,
          pass: true,
        },
        {
          id: 'wallpaper_permission_denied',
          faultClass: 'expected_error',
          inject: 'deny_set_wallpaper',
          expectedCode: 'WALLPAPER_PERMISSION_DENIED',
          actualCode: 'WALLPAPER_PERMISSION_DENIED',
          crashOrAnr: false,
          pass: true,
        },
        _caseAutoRecoverable(true, 'ok'),
        {
          ..._caseAutoRecoverable(true, 'ok'),
          id: 'force_stop_mineradio',
          inject: 'am_force_stop_mineradio',
          oldPid: 4001,
          newPid: 4002,
          mineradioPid: 1111,
          callId: 'rec-call-2',
          operationId: 'rec-op-2',
        },
        _caseUnrelatedCrash(),
      ];
      break;
    case 'missingParent':
      return {
        ...meta,
        parentTaskId: 'WP-10B',
        parentManifestSha256: '',
        requiredEffectiveDone: false,
        cases: [_caseAutoRecoverable(true, 'ok')],
        ...overrides,
      };
    case 'wrongUser':
      return {
        ...meta,
        targetUser: 0,
        currentUser: 0,
        cases: [_caseAutoRecoverable(true, 'ok')],
        ...overrides,
      };
    case 'packagePresenceDemandsIdle':
      cases = [
        {
          ..._casePackagePresence(true),
          // Illegal: package_presence must not demand recovery IDLE/newPid
          operationState: 'IDLE',
          newPid: 9999,
          recoveryElapsedMs: 100,
          pass: true,
        },
      ];
      break;
    case 'expectedErrorWrongCode':
      cases = [_caseExpectedError(false)];
      break;
    case 'recoveryTooSlow':
      cases = [
        _casePackagePresence(true),
        _caseExpectedError(true),
        _caseAutoRecoverable(true, 'tooSlow'),
      ];
      break;
    case 'recoverySamePid':
      cases = [
        _casePackagePresence(true),
        _caseExpectedError(true),
        _caseAutoRecoverable(true, 'samePid'),
      ];
      break;
    case 'recoveryMissingRequest':
      cases = [
        _casePackagePresence(true),
        _caseExpectedError(true),
        _caseAutoRecoverable(true, 'missingRequest'),
      ];
      break;
    case 'wrongCallerCertificate':
      cases = [
        _casePackagePresence(true),
        _caseExpectedError(true),
        _caseAutoRecoverable(true, 'wrongCaller'),
      ];
      break;
    case 'unrelatedProcessAsFailure':
      cases = [
        {
          ..._caseUnrelatedCrash(),
          // Illegal: unrelated crash treated as auto_recoverable failure
          faultClass: 'auto_recoverable',
          pass: false,
          falsePositiveRecovery: true,
          oldPid: 1,
          newPid: null,
          recoveryElapsedMs: 0,
        },
      ];
      break;
    case 'autoRecoverableMissingBinding':
      cases = [
        _casePackagePresence(true),
        _caseExpectedError(true),
        _caseAutoRecoverable(true, 'missingBinding'),
      ];
      break;
    default:
      throw new Error(`unknown recovery fixture: ${name}`);
  }
  return { ...meta, cases, ...overrides };
}

function _validateRecoveryCase(c) {
  const errors = [];
  if (!c || typeof c !== 'object') {
    return ['caseMissing'];
  }
  const fc = c.faultClass;
  if (!['package_presence', 'expected_error', 'auto_recoverable'].includes(fc)) {
    errors.push('unknownFaultClass');
    return errors;
  }
  if (fc === 'package_presence') {
    if (c.expectedCode !== c.actualCode) errors.push('packagePresenceCodeMismatch');
    // Must not require IDLE / new PID recovery semantics
    if (c.operationState === 'IDLE' && c.newPid) {
      errors.push('packagePresenceDemandsIdle');
    }
    if (c.pass !== true && c.expectedCode === c.actualCode) {
      errors.push('packagePresenceShouldPass');
    }
    if (c.pass === true && c.expectedCode !== c.actualCode) {
      errors.push('packagePresenceFalsePass');
    }
  } else if (fc === 'expected_error') {
    if (c.expectedCode !== c.actualCode) errors.push('expectedErrorCodeMismatch');
    if (c.crashOrAnr === true) errors.push('expectedErrorCrash');
    if (c.falseStatusReport === true) errors.push('expectedErrorFalseStatus');
    if (c.falsePositiveRecovery === true) errors.push('unrelatedProcessAsFailure');
    if (c.pass !== true && c.expectedCode === c.actualCode && !c.crashOrAnr) {
      // case author marked fail but codes match — still a fixture fail path
    }
    if (c.pass === true && c.expectedCode !== c.actualCode) {
      errors.push('expectedErrorFalsePass');
    }
  } else if (fc === 'auto_recoverable') {
    if (c.recoveryRequested !== true) errors.push('recoveryMissingRequest');
    if (c.callerCertificateMatch !== true) errors.push('wrongCallerCertificate');
    if (c.callerPackage !== 'com.mineradio.app') errors.push('wrongCallerPackage');
    if (c.code !== 0) errors.push('autoRecoverableCodeNotZero');
    if (c.operationState !== 'IDLE') errors.push('autoRecoverableNotIdle');
    if (c.bindingState !== 'ACTIVE_TARGET') errors.push('autoRecoverableMissingBinding');
    const oldPid = Number(c.oldPid);
    const newPid = Number(c.newPid);
    const mineradioPid = Number(c.mineradioPid);
    if (!oldPid || !newPid) errors.push('autoRecoverablePidMissing');
    if (oldPid && newPid && oldPid === newPid) errors.push('recoverySamePid');
    if (newPid && mineradioPid && newPid === mineradioPid) {
      errors.push('recoveryPidCollidesMineradio');
    }
    const recMs = Number(c.recoveryElapsedMs);
    if (!Number.isFinite(recMs) || recMs < 0) errors.push('recoveryElapsedMissing');
    if (recMs > RECOVERY_MAX_MS) errors.push('recoveryTooSlow');
    // killSeconds must not be the SLA clock
    if (c.killSecondsNotInSla !== true) errors.push('killSecondsCountedInSla');
    if (c.crashOrAnr === true) errors.push('autoRecoverableCrash');
    if (c.falsePositiveRecovery === true) errors.push('unrelatedProcessAsFailure');
  }
  // Case-level pass bit must agree with validation for matrix overall
  const caseOk = errors.length === 0;
  if (c.pass === true && !caseOk) {
    // already have errors
  } else if (c.pass !== true && caseOk && fc !== 'package_presence') {
    // For fail fixtures that intentionally set pass:false with bad fields,
    // errors are expected; if fields are actually good, mark inconsistency.
    if (fc === 'expected_error' && c.expectedCode !== c.actualCode) {
      // already pushed expectedErrorCodeMismatch when mismatch; ok
    }
  }
  return errors;
}

function verifyRecoveryEvidence(report) {
  const errors = [];
  if (!report || typeof report !== 'object') {
    return { ok: false, code: 'RECOVERY_REPORT_MISSING', errors: ['report missing'] };
  }
  if (report.parentTaskId !== 'WP-10C') errors.push('missingParent');
  if (
    !report.parentManifestSha256 ||
    !/^[0-9a-f]{64}$/i.test(String(report.parentManifestSha256))
  ) {
    errors.push('missingParentManifest');
  }
  if (report.requiredEffectiveDone !== true) errors.push('parentNotEffectiveDone');
  if (Number(report.targetUser) !== 12 || Number(report.currentUser) !== 12) {
    errors.push('wrongUser');
  }
  if (report.serial !== 'LD249H019625') errors.push('wrongSerial');
  // WP-11A must not claim E6/E7 elevation
  if (report.elevatedEvidenceLevel === true) errors.push('evidenceElevated');
  if (report.evidenceLevel && report.evidenceLevel !== 'E5') {
    errors.push('evidenceLevelNotE5');
  }
  const cases = report.cases;
  if (!Array.isArray(cases) || cases.length === 0) {
    errors.push('casesMissing');
    return {
      ok: false,
      code: errors[0] || 'RECOVERY_FAIL',
      errors: [...new Set(errors)],
      evidenceLevel: 'E5',
    };
  }
  const classes = new Set();
  let maxRecoveryMs = 0;
  let autoPassCount = 0;
  for (const c of cases) {
    if (c && c.faultClass) classes.add(c.faultClass);
    const caseErrors = _validateRecoveryCase(c);
    for (const e of caseErrors) errors.push(e);
    // If case claims pass but validation failed, or vice-versa for matrix integrity
    if (c && c.pass === true && caseErrors.length > 0) {
      // already recorded
    }
    if (c && c.pass !== true) {
      // A failed case in a matrix fails the whole report when evaluating correctness
      errors.push(`caseFailed:${c.id || c.faultClass || 'unknown'}`);
    }
    if (c && c.faultClass === 'auto_recoverable') {
      const recMs = Number(c.recoveryElapsedMs);
      if (Number.isFinite(recMs) && recMs > maxRecoveryMs) maxRecoveryMs = recMs;
      if (caseErrors.length === 0 && c.pass === true) autoPassCount += 1;
    }
  }
  if (!classes.has('package_presence')) errors.push('missingPackagePresenceClass');
  if (!classes.has('expected_error')) errors.push('missingExpectedErrorClass');
  if (!classes.has('auto_recoverable')) errors.push('missingAutoRecoverableClass');

  const uniq = [...new Set(errors)];
  return {
    ok: uniq.length === 0,
    code: uniq[0] || 'OK',
    errors: uniq,
    evidenceLevel: 'E5',
    maxRecoveryMs,
    autoRecoverablePassCount: autoPassCount,
    faultClasses: [...classes].sort(),
  };
}

const verifyRecovery = verifyRecoveryEvidence;

function assertRecoveryFixtures() {
  const results = [];
  for (const name of RECOVERY_FIXTURE_NAMES) {
    if (name === 'correctRecoveryMatrix') continue;
    const r = verifyRecoveryEvidence(buildRecoveryFixture(name));
    const ok = r.ok === false;
    results.push({ name, ok, code: r.code });
    if (!ok) {
      return { ok: false, message: `fixture ${name} should fail`, results };
    }
  }
  const good = verifyRecoveryEvidence(buildRecoveryFixture('correctRecoveryMatrix'));
  if (!good.ok) {
    return {
      ok: false,
      message: `correctRecoveryMatrix should pass: ${good.errors}`,
      results,
    };
  }
  if (good.maxRecoveryMs > RECOVERY_MAX_MS) {
    return { ok: false, message: 'correct matrix maxRecoveryMs > 10000', results };
  }
  results.push({ name: 'correctRecoveryMatrix', ok: true, code: good.code });
  return {
    ok: results.every((x) => x.ok),
    results,
    RECOVERY_FIXTURE_NAMES,
    RECOVERY_MAX_MS,
  };
}

function main(argv) {
  const args = argv.slice(2);
  if (args[0] === '--fixtures') {
    const r = assertVerifyFixtures();
    process.stdout.write(`${JSON.stringify(r)}\n`);
    process.exit(r.ok ? 0 : 1);
  }
  if (args[0] === '--e3-fixtures') {
    const r = assertE3Fixtures();
    process.stdout.write(`${JSON.stringify(r)}\n`);
    process.exit(r.ok ? 0 : 1);
  }
  if (args[0] === '--e4-fixtures') {
    const r = assertE4Fixtures();
    process.stdout.write(`${JSON.stringify(r)}\n`);
    process.exit(r.ok ? 0 : 1);
  }
  if (args[0] === '--e5-fixtures') {
    const r = assertE5Fixtures();
    process.stdout.write(`${JSON.stringify(r)}\n`);
    process.exit(r.ok ? 0 : 1);
  }
  if (args[0] === '--recovery-fixtures') {
    const r = assertRecoveryFixtures();
    process.stdout.write(`${JSON.stringify(r)}\n`);
    process.exit(r.ok ? 0 : 1);
  }
  if (args[0] === '--e5-report-json') {
    const report = JSON.parse(fs.readFileSync(args[1], 'utf8'));
    const r = verifyE5Evidence(report);
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    process.exit(r.ok ? 0 : 1);
  }
  if (args[0] === '--recovery-report-json') {
    const report = JSON.parse(fs.readFileSync(args[1], 'utf8'));
    const r = verifyRecoveryEvidence(report);
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    process.exit(r.ok ? 0 : 1);
  }
  if (args[0] === '--report-json') {
    const report = JSON.parse(fs.readFileSync(args[1], 'utf8'));
    const r = verifyStaticReport(report);
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    process.exit(r.ok ? 0 : 1);
  }
  if (args[0] === '--e3-report-json') {
    const report = JSON.parse(fs.readFileSync(args[1], 'utf8'));
    const r = verifyE3Evidence(report);
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    process.exit(r.ok ? 0 : 1);
  }
  if (args[0] === '--e4-report-json') {
    const report = JSON.parse(fs.readFileSync(args[1], 'utf8'));
    const r = verifyE4Evidence(report);
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    process.exit(r.ok ? 0 : 1);
  }
  // Default: document query-only shell contract
  process.stderr.write(
    'verify-wallpaper-plugin.js: use --fixtures | --e3-fixtures | --e4-fixtures | --e5-fixtures | --recovery-fixtures | --report-json <file>\n' +
      'Shell wrapper is query-only (no uninstall/pm clear).\n' +
      'Tools: aapt apksigner zipalign; packages com.mineradio.app / ' +
      'com.motif.wallpaperengine / io.wallpaperengine.weclient; process :we_runtime; ' +
      'BrowseActivity WEWallpaperService arm64-v8a certificate sha256 split.\n' +
      'E3: user 12 + Mineradio real caller + PID isolation (not shell content call).\n' +
      'E4: Scene+Video dual-frame non-black/non-solid continuous render.\n' +
      'E5: current-user WEWallpaperService ACTIVE_TARGET binding.\n' +
      'WP-11A recovery: package_presence + expected_error + auto_recoverable <=10s (stay E5).\n',
  );
  process.exit(2);
}

module.exports = {
  PACKAGES,
  PLUGIN_PROVIDER_AUTHORITY,
  PLUGIN_RUNTIME_PROCESS,
  OFFICIAL_BROWSE,
  OFFICIAL_WALLPAPER,
  ABI,
  BUILD_PROP_CALLER_CERT,
  FIXTURE_NAMES,
  E3_FIXTURE_NAMES,
  E4_FIXTURE_NAMES,
  WP10A_E3_FAIL_FIXTURES: E3_FIXTURE_NAMES.filter((n) => n !== 'correctE3'),
  WP10B_E4_FAIL_FIXTURES: E4_FIXTURE_NAMES.filter((n) => n !== 'correctE4'),
  verifyStaticReport,
  buildFixture,
  assertVerifyFixtures,
  parseContentCallBundle,
  parseProviderBundle,
  buildE3Fixture,
  verifyE3Evidence,
  verifyE3,
  assertE3Fixtures,
  buildE4Fixture,
  verifyE4Evidence,
  verifyE4,
  assertE4Fixtures,
  E5_FIXTURE_NAMES,
  WP10C_E5_FAIL_FIXTURES: E5_FIXTURE_NAMES.filter((n) => n !== 'correctE5'),
  buildE5Fixture,
  verifyE5Evidence,
  verifyE5,
  assertE5Fixtures,
  RECOVERY_MAX_MS,
  RECOVERY_FIXTURE_NAMES,
  WP11A_RECOVERY_FAIL_FIXTURES: RECOVERY_FIXTURE_NAMES.filter(
    (n) => n !== 'correctRecoveryMatrix',
  ),
  buildRecoveryFixture,
  verifyRecoveryEvidence,
  verifyRecovery,
  assertRecoveryFixtures,
  runToolsOnApk,
  sha256File,
  sha256Hex,
};

if (require.main === module) {
  main(process.argv);
}
