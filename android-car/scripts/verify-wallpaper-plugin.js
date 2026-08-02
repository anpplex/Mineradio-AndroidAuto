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

function main(argv) {
  const args = argv.slice(2);
  if (args[0] === '--fixtures') {
    const r = assertVerifyFixtures();
    process.stdout.write(`${JSON.stringify(r)}\n`);
    process.exit(r.ok ? 0 : 1);
  }
  if (args[0] === '--report-json') {
    const report = JSON.parse(fs.readFileSync(args[1], 'utf8'));
    const r = verifyStaticReport(report);
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    process.exit(r.ok ? 0 : 1);
  }
  // Default: document query-only shell contract
  process.stderr.write(
    'verify-wallpaper-plugin.js: use --fixtures or --report-json <file>\n' +
      'Shell wrapper is query-only (no uninstall/pm clear).\n' +
      'Tools: aapt apksigner zipalign; packages com.mineradio.app / ' +
      'com.motif.wallpaperengine / io.wallpaperengine.weclient; process :we_runtime; ' +
      'BrowseActivity WEWallpaperService arm64-v8a certificate sha256 split.\n',
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
  verifyStaticReport,
  buildFixture,
  assertVerifyFixtures,
  runToolsOnApk,
  sha256File,
  sha256Hex,
};

if (require.main === module) {
  main(process.argv);
}
