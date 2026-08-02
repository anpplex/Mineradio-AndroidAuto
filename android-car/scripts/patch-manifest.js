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
  injectWallpaperPluginFileProvider,
  patchManifest,
};
