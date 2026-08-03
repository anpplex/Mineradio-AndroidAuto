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
  // Default: document query-only shell contract
  process.stderr.write(
    'verify-wallpaper-plugin.js: use --fixtures | --e3-fixtures | --report-json <file>\n' +
      'Shell wrapper is query-only (no uninstall/pm clear).\n' +
      'Tools: aapt apksigner zipalign; packages com.mineradio.app / ' +
      'com.motif.wallpaperengine / io.wallpaperengine.weclient; process :we_runtime; ' +
      'BrowseActivity WEWallpaperService arm64-v8a certificate sha256 split.\n' +
      'E3: user 12 + Mineradio real caller + PID isolation (not shell content call).\n',
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
  WP10A_E3_FAIL_FIXTURES: E3_FIXTURE_NAMES.filter((n) => n !== 'correctE3'),
  verifyStaticReport,
  buildFixture,
  assertVerifyFixtures,
  parseContentCallBundle,
  parseProviderBundle,
  buildE3Fixture,
  verifyE3Evidence,
  verifyE3,
  assertE3Fixtures,
  runToolsOnApk,
  sha256File,
  sha256Hex,
};

if (require.main === module) {
  main(process.argv);
}
