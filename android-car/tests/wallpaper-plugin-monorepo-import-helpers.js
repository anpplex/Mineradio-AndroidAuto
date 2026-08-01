'use strict';

/**
 * Helpers for MONOREPO-IMPORT RED/GREEN: Wallpaper Engine plugin content
 * import into Mineradio wallpaper-plugin/ (not a separate Plugin origin).
 *
 * Paths are absolute to the monorepo import worktree only.
 * WallpaperEngine sandbox is read-only source reference — never a runtime path.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/** Absolute monorepo import worktree (NOT WallpaperEngine sandbox). */
const MONOREPO_WORKTREE = '/Users/anpple/Codex/Mineradio-wallpaper-plugin';

const APPROVED_BRANCH = 'codex/wallpaper-plugin-monorepo';
const PRODUCT_NAME = 'Wallpaper Engine';
const PLUGIN_NAMESPACE = 'com.motif.wallpaperengine';
const TARGET_MODULE = 'wallpaper-plugin/app';
const PLUGIN_ROOT_REL = 'wallpaper-plugin';

/** Read-only source reference — must not be used as monorepo runtime path. */
const WE_SOURCE_SANDBOX =
  '/Users/anpple/Codex/WallpaperEngine/.worktrees/mineradio-plugin-sandbox';
const SOURCE_COMMIT = 'f117780b0741b6c3807d024ce59dbf629410579c';

const FORBIDDEN_IMPORT_SEGMENTS = Object.freeze([
  'MainActivity',
  'importscan',
  'we-official',
  'scripts',
  'docs',
  'testdata',
  'local.properties',
  '.gradle',
  '.kotlin',
  'build/',
]);

const FORBIDDEN_RUNTIME_SUFFIXES = Object.freeze([
  '.apk',
  '.jks',
  '.keystore',
]);

// Shared verification receipts (primary clone bootstrap, gitignored).
const VERIFICATION_BOOTSTRAP = path.join(
  '/Users/anpple/Codex/Mineradio',
  'android-car',
  'verification',
  'wallpaper-plugin',
  'bootstrap',
);
const WP_INFRA_FINAL = path.join(
  VERIFICATION_BOOTSTRAP,
  'WP-INFRA-FINAL-RECEIPT-17.json',
);
const WP00_MERGE = path.join(VERIFICATION_BOOTSTRAP, 'WP-00-PR-MERGE-19.json');
const WP01_COMMIT = path.join(
  VERIFICATION_BOOTSTRAP,
  'WP-01-COMMIT-IMPLEMENTATION-01.json',
);

const pluginRoot = path.join(MONOREPO_WORKTREE, PLUGIN_ROOT_REL);
const requiredPaths = Object.freeze({
  pluginRoot,
  settingsGradle: path.join(pluginRoot, 'settings.gradle.kts'),
  rootBuildGradle: path.join(pluginRoot, 'build.gradle.kts'),
  gradleProperties: path.join(pluginRoot, 'gradle.properties'),
  gradlew: path.join(pluginRoot, 'gradlew'),
  gradlewBat: path.join(pluginRoot, 'gradlew.bat'),
  wrapperJar: path.join(pluginRoot, 'gradle', 'wrapper', 'gradle-wrapper.jar'),
  wrapperProps: path.join(
    pluginRoot,
    'gradle',
    'wrapper',
    'gradle-wrapper.properties',
  ),
  appBuildGradle: path.join(pluginRoot, 'app', 'build.gradle.kts'),
  androidManifest: path.join(
    pluginRoot,
    'app',
    'src',
    'main',
    'AndroidManifest.xml',
  ),
  pluginContract: path.join(
    pluginRoot,
    'app',
    'src',
    'main',
    'java',
    'com',
    'motif',
    'wallpaperengine',
    'plugin',
    'PluginContract.kt',
  ),
  pluginResult: path.join(
    pluginRoot,
    'app',
    'src',
    'main',
    'java',
    'com',
    'motif',
    'wallpaperengine',
    'plugin',
    'PluginResult.kt',
  ),
  pluginContractTest: path.join(
    pluginRoot,
    'app',
    'src',
    'test',
    'java',
    'com',
    'motif',
    'wallpaperengine',
    'plugin',
    'PluginContractTest.kt',
  ),
  provenance: path.join(pluginRoot, 'SOURCE-PROVENANCE.txt'),
});

function git(args, cwd = MONOREPO_WORKTREE) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return {
    status: result.status === null ? 1 : result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
    combined: `${result.stdout || ''}\n${result.stderr || ''}`,
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function pathExists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Assert monorepo wallpaper-plugin tree is fully imported (GREEN target).
 * Throws with a stable failure reason when any required piece is missing.
 */
function assertMonorepoPluginImported() {
  if (!pathExists(requiredPaths.pluginRoot)) {
    throw new Error(
      'MONOREPO_PLUGIN_NOT_IMPORTED: wallpaper-plugin/ directory missing',
    );
  }
  const missing = [];
  for (const [key, p] of Object.entries(requiredPaths)) {
    if (key === 'pluginRoot') continue;
    if (!pathExists(p)) missing.push(path.relative(MONOREPO_WORKTREE, p));
  }
  if (missing.length) {
    throw new Error(
      `MONOREPO_PLUGIN_INCOMPLETE: missing ${missing.join(', ')}`,
    );
  }
  if (!isExecutable(requiredPaths.gradlew)) {
    throw new Error('MONOREPO_PLUGIN_INCOMPLETE: gradlew is not executable');
  }
  return true;
}

function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

/**
 * Post-import content gates (only meaningful once files exist).
 * Separated so RED fails first on missing tree, GREEN satisfies content.
 */
function assertMonorepoPluginContent() {
  assertMonorepoPluginImported();

  const appGradle = readText(requiredPaths.appBuildGradle);
  if (!appGradle.includes(`namespace = "${PLUGIN_NAMESPACE}"`) &&
      !appGradle.includes(`namespace = '${PLUGIN_NAMESPACE}'`)) {
    throw new Error(
      `MONOREPO_NAMESPACE_MISMATCH: expected namespace ${PLUGIN_NAMESPACE}`,
    );
  }

  const settings = readText(requiredPaths.settingsGradle);
  if (!settings.includes(':app')) {
    throw new Error('MONOREPO_MODULE_MISMATCH: settings must include :app');
  }
  // Product name surfaces
  const nameOk =
    settings.includes(PRODUCT_NAME) ||
    settings.includes('WallpaperEngine') ||
    (pathExists(path.join(pluginRoot, 'README.md')) &&
      readText(path.join(pluginRoot, 'README.md')).includes(PRODUCT_NAME));
  if (!nameOk) {
    throw new Error(
      `MONOREPO_PRODUCT_NAME_MISMATCH: product name must be ${PRODUCT_NAME}`,
    );
  }

  const provenance = readText(requiredPaths.provenance);
  if (!provenance.includes(SOURCE_COMMIT)) {
    throw new Error(
      `MONOREPO_PROVENANCE_MISSING: Source-Commit ${SOURCE_COMMIT} not recorded`,
    );
  }
  if (!/Source-Repository:\s*local WallpaperEngine sandbox/i.test(provenance)) {
    throw new Error(
      'MONOREPO_PROVENANCE_MISSING: Source-Repository line required',
    );
  }

  // Must not wire monorepo build to WE sandbox or external plugin origin.
  const gradleTexts = [
    readText(requiredPaths.settingsGradle),
    readText(requiredPaths.rootBuildGradle),
    readText(requiredPaths.appBuildGradle),
  ].join('\n');
  if (gradleTexts.includes(WE_SOURCE_SANDBOX)) {
    throw new Error(
      'MONOREPO_FORBIDDEN_PATH: must not depend on WallpaperEngine sandbox path',
    );
  }
  if (/github\.com\/.*wallpaperengine/i.test(gradleTexts) ||
      /Plugin origin/i.test(gradleTexts)) {
    throw new Error(
      'MONOREPO_FORBIDDEN_ORIGIN: must not depend on independent Plugin origin',
    );
  }

  // Forbidden *imported source* scan under wallpaper-plugin only.
  // Local Gradle/Kotlin build outputs may appear after test runs; they are not
  // source imports. Skip generated dirs. Flag tracked-style source pollution.
  const GENERATED_DIRS = new Set(['build', '.gradle', '.kotlin', '.idea']);
  const forbiddenHits = [];
  function walk(dir) {
    if (!pathExists(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      const rel = path.relative(pluginRoot, full);
      if (ent.isDirectory()) {
        if (GENERATED_DIRS.has(ent.name)) {
          continue;
        }
        // Never import WE runtime trees as source packages
        if (
          ent.name === 'importscan' ||
          ent.name === 'we-official' ||
          ent.name === 'testdata' ||
          ent.name === 'scripts' ||
          ent.name === 'docs'
        ) {
          forbiddenHits.push(rel);
          continue;
        }
        walk(full);
      } else {
        if (ent.name === 'MainActivity.kt' || ent.name === 'local.properties') {
          forbiddenHits.push(rel);
        }
        if (/\.dex$/i.test(ent.name) || ent.name === 'preview.jpg') {
          forbiddenHits.push(rel);
        }
        for (const suf of FORBIDDEN_RUNTIME_SUFFIXES) {
          if (rel.endsWith(suf)) forbiddenHits.push(rel);
        }
      }
    }
  }
  walk(pluginRoot);
  // allowed: "scripts" segment only if we forbid - scripts is in forbidden list
  // MainActivity.kt path would hit MainActivity
  if (forbiddenHits.length) {
    throw new Error(
      `MONOREPO_FORBIDDEN_IMPORT: ${[...new Set(forbiddenHits)].slice(0, 20).join(', ')}`,
    );
  }

  return true;
}

module.exports = {
  MONOREPO_WORKTREE,
  APPROVED_BRANCH,
  PRODUCT_NAME,
  PLUGIN_NAMESPACE,
  TARGET_MODULE,
  PLUGIN_ROOT_REL,
  WE_SOURCE_SANDBOX,
  SOURCE_COMMIT,
  WP_INFRA_FINAL,
  WP00_MERGE,
  WP01_COMMIT,
  pluginRoot,
  requiredPaths,
  git,
  readJson,
  pathExists,
  isExecutable,
  assertMonorepoPluginImported,
  assertMonorepoPluginContent,
};
