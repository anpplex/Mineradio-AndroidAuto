'use strict';

const MAIN_ACTIVITY = 'com.mineradio.app.MainActivity';
const LANDSCAPE_ACTIVITY = 'com.mineradio.app.LandscapeWebActivity';
const CAR_CONFIG_CHANGES = 'keyboard|keyboardHidden|orientation|screenSize|smallestScreenSize|screenLayout|uiMode|density';
const CAR_LAUNCHER_FILTER = `\n      <intent-filter>\n        <action android:name="android.intent.action.MAIN"/>\n        <category android:name="android.intent.category.LAUNCHER"/>\n        <category android:name="android.intent.category.CAR_LAUNCHER"/>\n      </intent-filter>`;

function setAndroidAttribute(attributes, attribute, value) {
  const expression = new RegExp(`\\s${attribute.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}="[^"]*"`);
  if (expression.test(attributes)) {
    return attributes.replace(expression, ` ${attribute}="${value}"`);
  }
  return `${attributes} ${attribute}="${value}"`;
}

function activityStartTagPattern(activityName) {
  const escapedName = activityName.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
  return new RegExp(`<activity\\b(?=[^>]*\\bandroid:name="${escapedName}")([^>]*?)(\\s*\\/?)>`, 'g');
}

function setActivityAttributes(xml, activityName, attributes) {
  return xml.replace(activityStartTagPattern(activityName), (_match, currentAttributes, slash) => {
    let nextAttributes = currentAttributes;
    for (const [attribute, value] of Object.entries(attributes)) {
      nextAttributes = setAndroidAttribute(nextAttributes, attribute, value);
    }
    return `<activity${nextAttributes}${slash}>`;
  });
}

function removeLauncherFilterFromActivity(xml, activityName) {
  const escapedName = activityName.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
  const activityPattern = new RegExp(`(<activity\\b(?=[^>]*\\bandroid:name="${escapedName}")[^>]*>)([\\s\\S]*?)(<\\/activity>)`, 'g');
  return xml.replace(activityPattern, (_match, openingTag, content, closingTag) => {
    const withoutLauncher = content.replace(/\s*<intent-filter>[\s\S]*?<action android:name="android\.intent\.action\.MAIN"\/>[\s\S]*?<category android:name="android\.intent\.category\.LAUNCHER"\/>[\s\S]*?<\/intent-filter>/g, '');
    return `${openingTag}${withoutLauncher}${closingTag}`;
  });
}

function addCarLauncherFilter(xml) {
  const escapedName = LANDSCAPE_ACTIVITY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const selfClosingPattern = new RegExp(`(<activity\\b(?=[^>]*\\bandroid:name="${escapedName}")[^>]*)\\s*/>`, 'g');
  const expanded = xml.replace(selfClosingPattern, (match, openingTag) => (
    `${openingTag}>${CAR_LAUNCHER_FILTER}\n    </activity>`
  ));
  if (expanded !== xml) return expanded;

  const openingPattern = new RegExp(`(<activity\\b(?=[^>]*\\bandroid:name="${escapedName}")[^>]*)>`, 'g');
  let patched = false;
  const result = xml.replace(openingPattern, (match, openingTag) => {
    if (patched) return match;
    patched = true;
    return `${openingTag}>${CAR_LAUNCHER_FILTER}`;
  });
  if (!patched) {
    throw new Error(`Cannot find ${LANDSCAPE_ACTIVITY} in AndroidManifest.xml`);
  }
  return result;
}

/** WP-05 Mineradio FileProvider (Task 5) — reuse AndroidX class, do not re-inject library. */
const WALLPAPER_PLUGIN_FILE_PROVIDER_CLASS = 'androidx.core.content.FileProvider';
const WALLPAPER_PLUGIN_FILE_PROVIDER_AUTHORITY = 'com.mineradio.app.wallpaperplugin.files';
const WALLPAPER_PLUGIN_PATHS_META = 'android.support.FILE_PROVIDER_PATHS';
const WALLPAPER_PLUGIN_PATHS_RESOURCE = '@xml/wallpaper_plugin_paths';

// WP-06 package install visibility — literals mirrored from wallpaper-plugin-contract.js
// (Smali/manifest cannot import JS; keep strings identical for capacity probes).
const contractInstall = (() => {
  try {
    // Lazy require avoids circular load during pure-manifest unit probes.
    // eslint-disable-next-line global-require
    return require('./wallpaper-plugin-contract');
  } catch {
    return null;
  }
})();
const WP06_REQUEST_INSTALL_PACKAGES =
  (contractInstall && contractInstall.requestInstallPackages) ||
  'android.permission.REQUEST_INSTALL_PACKAGES';
const WP06_PLUGIN_PACKAGE =
  (contractInstall && contractInstall.pluginPackage) || 'com.motif.wallpaperengine';
const WP06_WE_CLIENT_PACKAGE =
  (contractInstall && contractInstall.enginePackage) || 'io.wallpaperengine.weclient';

const WALLPAPER_PLUGIN_FILE_PROVIDER_SNIPPET = `
        <provider
            android:name="${WALLPAPER_PLUGIN_FILE_PROVIDER_CLASS}"
            android:authorities="${WALLPAPER_PLUGIN_FILE_PROVIDER_AUTHORITY}"
            android:exported="false"
            android:grantUriPermissions="true">
            <meta-data
                android:name="${WALLPAPER_PLUGIN_PATHS_META}"
                android:resource="${WALLPAPER_PLUGIN_PATHS_RESOURCE}" />
        </provider>`;

const WP06_REQUEST_INSTALL_PERM_SNIPPET = `
    <uses-permission android:name="${WP06_REQUEST_INSTALL_PACKAGES}" />`;

const WP06_PACKAGE_QUERIES_SNIPPET = `
    <queries>
        <package android:name="${WP06_PLUGIN_PACKAGE}" />
        <package android:name="${WP06_WE_CLIENT_PACKAGE}" />
    </queries>`;

/**
 * Inject WP-05 FileProvider into <application> if missing (idempotent).
 * Fail-closed: requires <application> open tag.
 */
function requireManifestXml(manifest) {
  if (typeof manifest !== 'string' || !manifest.includes('<manifest')) {
    throw new TypeError('Expected decoded AndroidManifest.xml text');
  }
  return manifest;
}

function injectWallpaperPluginFileProvider(manifest) {
  requireManifestXml(manifest);
  if (manifest.includes(WALLPAPER_PLUGIN_FILE_PROVIDER_AUTHORITY)) {
    // Already wired (authority unique).
    return manifest;
  }
  if (!/<application\b[^>]*>/.test(manifest)) {
    throw new Error('Cannot inject FileProvider: <application> missing (fail-closed)');
  }
  return manifest.replace(/<application\b[^>]*>/, (openTag) => `${openTag}${WALLPAPER_PLUGIN_FILE_PROVIDER_SNIPPET}`);
}

/**
 * WP-06: inject REQUEST_INSTALL_PACKAGES (sandbox) if missing (idempotent).
 */
function injectRequestInstallPackagesPermission(manifest) {
  requireManifestXml(manifest);
  if (manifest.includes(WP06_REQUEST_INSTALL_PACKAGES)) {
    return manifest;
  }
  // Prefer insert after last uses-permission; else after <manifest ...>.
  if (/<uses-permission\b[^/]*\/>/.test(manifest)) {
    let last = null;
    const re = /<uses-permission\b[^/]*\/>/g;
    let m;
    while ((m = re.exec(manifest)) !== null) last = m;
    if (last) {
      const idx = last.index + last[0].length;
      return manifest.slice(0, idx) + WP06_REQUEST_INSTALL_PERM_SNIPPET + manifest.slice(idx);
    }
  }
  return manifest.replace(/<manifest\b[^>]*>/, (open) => `${open}${WP06_REQUEST_INSTALL_PERM_SNIPPET}`);
}

/**
 * WP-06: inject <queries> for WE plugin packages if missing (idempotent).
 * Single visibility path: both plugin + WE client package names required.
 */
function injectWallpaperPackageQueries(manifest) {
  requireManifestXml(manifest);
  const hasPlugin = manifest.includes(`android:name="${WP06_PLUGIN_PACKAGE}"`);
  const hasClient = manifest.includes(`android:name="${WP06_WE_CLIENT_PACKAGE}"`);
  const hasQueries = /<queries[\s>]/.test(manifest);
  if (hasPlugin && hasClient && hasQueries) {
    return manifest;
  }
  return manifest.replace(/<manifest\b[^>]*>/, (open) => `${open}${WP06_PACKAGE_QUERIES_SNIPPET}`);
}

function patchManifest(manifest) {
  requireManifestXml(manifest);

  let patched = manifest.replace(/android:screenOrientation="portrait"/g, 'android:screenOrientation="landscape"');
  patched = patched.replace(/<application\b([^>]*)>/, (_match, attributes) => (
    `<application${setAndroidAttribute(attributes, 'android:resizeableActivity', 'true')}>`
  ));
  patched = setActivityAttributes(patched, MAIN_ACTIVITY, {
    'android:screenOrientation': 'landscape',
    'android:configChanges': CAR_CONFIG_CHANGES,
  });
  patched = setActivityAttributes(patched, 'com.mineradio.app.crash.CrashActivity', {
    'android:screenOrientation': 'landscape',
  });
  patched = setActivityAttributes(patched, LANDSCAPE_ACTIVITY, {
    'android:screenOrientation': 'landscape',
    'android:exported': 'true',
    'android:configChanges': CAR_CONFIG_CHANGES,
  });
  patched = removeLauncherFilterFromActivity(patched, MAIN_ACTIVITY);
  patched = addCarLauncherFilter(patched);
  // WP-05: FileProvider for importMpkg content:// staging grants.
  patched = injectWallpaperPluginFileProvider(patched);
  // WP-06: package install permission + package visibility queries.
  patched = injectRequestInstallPackagesPermission(patched);
  patched = injectWallpaperPackageQueries(patched);
  return patched;
}

module.exports = {
  CAR_CONFIG_CHANGES,
  LANDSCAPE_ACTIVITY,
  MAIN_ACTIVITY,
  WALLPAPER_PLUGIN_FILE_PROVIDER_CLASS,
  WALLPAPER_PLUGIN_FILE_PROVIDER_AUTHORITY,
  WALLPAPER_PLUGIN_PATHS_META,
  WALLPAPER_PLUGIN_PATHS_RESOURCE,
  WP06_REQUEST_INSTALL_PACKAGES,
  WP06_PLUGIN_PACKAGE,
  WP06_WE_CLIENT_PACKAGE,
  injectWallpaperPluginFileProvider,
  injectRequestInstallPackagesPermission,
  injectWallpaperPackageQueries,
  patchManifest,
};
