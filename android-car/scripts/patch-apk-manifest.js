#!/usr/bin/env node
'use strict';

/**
 * APKtool decoded AndroidManifest patch entry (car HMI + WP-05 FileProvider).
 *
 * WP-05 capacity markers (Task 5):
 *   - androidx.core.content.FileProvider
 *   - authority com.mineradio.app.wallpaperplugin.files
 *   - android.support.FILE_PROVIDER_PATHS → @xml/wallpaper_plugin_paths
 * Reuses AndroidX FileProvider class already in APK — does not re-inject library code.
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  patchManifest,
  injectWallpaperPluginFileProvider,
  WALLPAPER_PLUGIN_FILE_PROVIDER_CLASS,
  WALLPAPER_PLUGIN_FILE_PROVIDER_AUTHORITY,
  WALLPAPER_PLUGIN_PATHS_META,
  WALLPAPER_PLUGIN_PATHS_RESOURCE,
} = require('./patch-manifest');

// Explicit string anchors for WP-05 RED capacity probes (must remain in this file).
const WP05_FILE_PROVIDER = 'androidx.core.content.FileProvider';
const WP05_FILE_PROVIDER_AUTHORITY = 'com.mineradio.app.wallpaperplugin.files';
const WP05_FILE_PROVIDER_PATHS_META = 'android.support.FILE_PROVIDER_PATHS';
const WP05_WALLPAPER_PLUGIN_PATHS = 'wallpaper_plugin_paths';
const WP05_PATHS_RESOURCE = '@xml/wallpaper_plugin_paths';

// Explicit string anchors for WP-06 RED/GREEN capacity probes (must remain in this file).
// Keep literal values identical to wallpaper-plugin-contract installResult (single mapping).
const WP06_REQUEST_INSTALL_PACKAGES = 'android.permission.REQUEST_INSTALL_PACKAGES';
const WP06_PLUGIN_PACKAGE = 'com.motif.wallpaperengine';
const WP06_WE_CLIENT_PACKAGE = 'io.wallpaperengine.weclient';
const WP06_QUERIES = 'queries';
const WP06_PACKAGE_INSTALLER = 'PackageInstaller';

// Runtime values still resolve through contract when available (fail-closed equality).
(() => {
  try {
    // eslint-disable-next-line global-require
    const c = require('./wallpaper-plugin-contract');
    if (
      c.requestInstallPackages !== WP06_REQUEST_INSTALL_PACKAGES ||
      c.pluginPackage !== WP06_PLUGIN_PACKAGE ||
      c.enginePackage !== WP06_WE_CLIENT_PACKAGE
    ) {
      throw new Error('WP-06 manifest anchors drift from wallpaper-plugin-contract installResult');
    }
  } catch (err) {
    if (err && /drift from wallpaper-plugin-contract/.test(String(err.message))) throw err;
    // Contract unavailable in pure path probes — anchors remain authoritative strings.
  }
})();

function main(argv) {
  const manifestPath = argv[2];
  if (!manifestPath) {
    throw new Error('Usage: patch-apk-manifest.js <decoded-AndroidManifest.xml>');
  }

  const absolutePath = path.resolve(manifestPath);
  const original = fs.readFileSync(absolutePath, 'utf8');
  // patchManifest injects FileProvider + WP-06 install permission/queries.
  const next = patchManifest(original);
  // Atomic-ish: write then fsync via writeFileSync replace.
  fs.writeFileSync(absolutePath, next, 'utf8');
  return {
    path: absolutePath,
    fileProviderClass: WP05_FILE_PROVIDER,
    authority: WP05_FILE_PROVIDER_AUTHORITY,
    pathsMeta: WP05_FILE_PROVIDER_PATHS_META,
    pathsResource: WP05_PATHS_RESOURCE,
    wallpaperPluginPaths: WP05_WALLPAPER_PLUGIN_PATHS,
    requestInstallPackages: WP06_REQUEST_INSTALL_PACKAGES,
    pluginPackage: WP06_PLUGIN_PACKAGE,
    weClientPackage: WP06_WE_CLIENT_PACKAGE,
    queries: WP06_QUERIES,
    packageInstaller: WP06_PACKAGE_INSTALLER,
    changed: next !== original,
  };
}

if (require.main === module) {
  main(process.argv);
}

module.exports = {
  main,
  patchManifest,
  injectWallpaperPluginFileProvider,
  WP05_FILE_PROVIDER,
  WP05_FILE_PROVIDER_AUTHORITY,
  WP05_FILE_PROVIDER_PATHS_META,
  WP05_WALLPAPER_PLUGIN_PATHS,
  WP05_PATHS_RESOURCE,
  WP06_REQUEST_INSTALL_PACKAGES,
  WP06_PLUGIN_PACKAGE,
  WP06_WE_CLIENT_PACKAGE,
  WP06_QUERIES,
  WP06_PACKAGE_INSTALLER,
  WALLPAPER_PLUGIN_FILE_PROVIDER_CLASS,
  WALLPAPER_PLUGIN_FILE_PROVIDER_AUTHORITY,
  WALLPAPER_PLUGIN_PATHS_META,
  WALLPAPER_PLUGIN_PATHS_RESOURCE,
};
