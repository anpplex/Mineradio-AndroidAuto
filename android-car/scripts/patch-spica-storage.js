#!/usr/bin/env node
'use strict';

/**
 * Android 12 scoped-storage fix for Mineradio car repack.
 *
 * Upstream hard-codes top-level SPICaMusic under getExternalStorageDirectory():
 *   /storage/emulated/<user>/SPICaMusic/mineradio_settings.json
 *   /storage/emulated/<user>/SPICaMusic/databases
 *
 * MediaProvider rejects non-default top-level dirs (SPICaMusic is not in the
 * allowlist: Music, Download, DCIM, Documents, …). Remap to Music/SPICaMusic
 * so the path remains shared-storage-like while staying under a legal root.
 *
 * Does not touch SPICaMusicTheme, SPICaMusic_update.apk, or other non-path uses.
 */

const fs = require('node:fs');
const path = require('node:path');

const LEGACY_DIR = 'SPICaMusic';
const LEGACY_DB_DIR = 'SPICaMusic/databases';
const LEGAL_DIR = 'Music/SPICaMusic';
const LEGAL_DB_DIR = 'Music/SPICaMusic/databases';

/** Match only bare top-level SPICaMusic path literals in smali const-string. */
function bareDirRe() {
  return /const-string ([vp]\d+), "SPICaMusic"/g;
}
function bareDbRe() {
  return /const-string ([vp]\d+), "SPICaMusic\/databases"/g;
}

/**
 * Rewrite smali source so SPICaMusic storage roots land under Music/.
 * Idempotent: already-patched Music/SPICaMusic is left alone.
 * @param {string} smali
 * @returns {{ text: string, changed: boolean, replacements: number }}
 */
function patchSpicaStorageSmali(smali) {
  if (typeof smali !== 'string') {
    throw new TypeError('Expected smali source text');
  }

  let replacements = 0;
  let text = smali.replace(bareDirRe(), (_match, reg) => {
    replacements += 1;
    return `const-string ${reg}, "${LEGAL_DIR}"`;
  });
  text = text.replace(bareDbRe(), (_match, reg) => {
    replacements += 1;
    return `const-string ${reg}, "${LEGAL_DB_DIR}"`;
  });

  return {
    text,
    changed: replacements > 0,
    replacements,
  };
}

/**
 * True when smali still contains a bare top-level SPICaMusic path const-string.
 * SPICaMusic_update.apk / SPICaMusicTheme are intentionally ignored.
 * @param {string} smali
 */
function hasBareSpicaTopLevelPath(smali) {
  if (typeof smali !== 'string') return false;
  return bareDirRe().test(smali) || bareDbRe().test(smali);
}

/**
 * True when smali already uses the legal Music/SPICaMusic roots.
 * @param {string} smali
 */
function hasLegalSpicaMusicPath(smali) {
  if (typeof smali !== 'string') return false;
  return smali.includes(`"${LEGAL_DIR}"`) || smali.includes(`"${LEGAL_DB_DIR}"`);
}

function walkSmaliFiles(rootDir) {
  const results = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith('.smali')) {
        results.push(full);
      }
    }
  }
  return results;
}

/**
 * Patch all smali under an apktool-decoded directory in place.
 * @param {string} decodedDir absolute or relative apktool output root
 * @returns {{ filesPatched: number, replacements: number, patchedFiles: string[] }}
 */
function patchSpicaStorageInDecodedDir(decodedDir) {
  const absolute = path.resolve(decodedDir);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) {
    throw new Error(`Decoded APK directory not found: ${absolute}`);
  }

  const smaliRoots = fs.readdirSync(absolute, { withFileTypes: true })
    .filter((e) => e.isDirectory() && (e.name === 'smali' || e.name.startsWith('smali_')))
    .map((e) => path.join(absolute, e.name));

  if (smaliRoots.length === 0) {
    throw new Error(`No smali* trees under ${absolute}; decode with apktool before patching`);
  }

  let filesPatched = 0;
  let replacements = 0;
  const patchedFiles = [];

  for (const root of smaliRoots) {
    for (const file of walkSmaliFiles(root)) {
      const original = fs.readFileSync(file, 'utf8');
      if (!original.includes(LEGACY_DIR)) continue;
      const { text, changed, replacements: count } = patchSpicaStorageSmali(original);
      if (!changed) continue;
      fs.writeFileSync(file, text, 'utf8');
      filesPatched += 1;
      replacements += count;
      patchedFiles.push(path.relative(absolute, file));
    }
  }

  // Post-condition: no bare top-level SPICaMusic path remains in smali trees
  for (const root of smaliRoots) {
    for (const file of walkSmaliFiles(root)) {
      const content = fs.readFileSync(file, 'utf8');
      if (hasBareSpicaTopLevelPath(content)) {
        throw new Error(`Bare SPICaMusic path still present after patch: ${path.relative(absolute, file)}`);
      }
    }
  }

  if (filesPatched === 0) {
    // Already patched or upstream changed; require legal path somewhere as a soft signal
    let sawLegal = false;
    for (const root of smaliRoots) {
      for (const file of walkSmaliFiles(root)) {
        if (hasLegalSpicaMusicPath(fs.readFileSync(file, 'utf8'))) {
          sawLegal = true;
          break;
        }
      }
      if (sawLegal) break;
    }
    if (!sawLegal) {
      throw new Error(
        'No SPICaMusic storage paths found to patch and no Music/SPICaMusic present; upstream APK layout may have changed',
      );
    }
  }

  return { filesPatched, replacements, patchedFiles };
}

function main(argv = process.argv.slice(2)) {
  const decodedDir = argv[0];
  if (!decodedDir) {
    throw new Error('Usage: patch-spica-storage.js <apktool-decoded-dir>');
  }
  const result = patchSpicaStorageInDecodedDir(decodedDir);
  console.log(
    `SPICa storage patch: ${result.replacements} replacement(s) in ${result.filesPatched} file(s)`,
  );
  for (const f of result.patchedFiles) {
    console.log(`  - ${f}`);
  }
  return result;
}

if (require.main === module) {
  main();
}

module.exports = {
  LEGACY_DIR,
  LEGACY_DB_DIR,
  LEGAL_DIR,
  LEGAL_DB_DIR,
  patchSpicaStorageSmali,
  hasBareSpicaTopLevelPath,
  hasLegalSpicaMusicPath,
  patchSpicaStorageInDecodedDir,
  main,
};
