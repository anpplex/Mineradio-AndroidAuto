'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  LEGAL_DIR,
  LEGAL_DB_DIR,
  patchSpicaStorageSmali,
  hasBareSpicaTopLevelPath,
  hasLegalSpicaMusicPath,
  patchSpicaStorageInDecodedDir,
} = require('../scripts/patch-spica-storage');

const SETTINGS_SMALI = `.method public final externalSettingsFile()Ljava/io/File;
    .locals 2

    new-instance p0, Ljava/io/File;

    invoke-static {}, Landroid/os/Environment;->getExternalStorageDirectory()Ljava/io/File;

    move-result-object v0

    const-string v1, "SPICaMusic"

    invoke-direct {p0, v0, v1}, Ljava/io/File;-><init>(Ljava/io/File;Ljava/lang/String;)V

    new-instance v0, Ljava/io/File;

    const-string v1, "mineradio_settings.json"

    invoke-direct {v0, p0, v1}, Ljava/io/File;-><init>(Ljava/io/File;Ljava/lang/String;)V

    return-object v0
.end method
`;

const DB_SMALI = `.method public static final getExternalDbDir()Ljava/io/File;
    .locals 3

    new-instance v0, Ljava/io/File;

    invoke-static {}, Landroid/os/Environment;->getExternalStorageDirectory()Ljava/io/File;

    move-result-object v1

    const-string v2, "SPICaMusic/databases"

    invoke-direct {v0, v1, v2}, Ljava/io/File;-><init>(Ljava/io/File;Ljava/lang/String;)V

    return-object v0
.end method
`;

const NON_PATH_SMALI = `.method public final unrelated()V
    .locals 2
    const-string v0, "SPICaMusicTheme"
    const-string v1, "SPICaMusic_update.apk"
    return-void
.end method
`;

test('remaps bare SPICaMusic settings dir to Music/SPICaMusic', () => {
  const { text, changed, replacements } = patchSpicaStorageSmali(SETTINGS_SMALI);

  assert.equal(changed, true);
  assert.equal(replacements, 1);
  assert.match(text, new RegExp(`const-string v1, "${LEGAL_DIR}"`));
  assert.doesNotMatch(text, /const-string v1, "SPICaMusic"/);
  assert.equal(hasBareSpicaTopLevelPath(text), false);
  assert.equal(hasLegalSpicaMusicPath(text), true);
});

test('remaps SPICaMusic/databases to Music/SPICaMusic/databases', () => {
  const { text, changed, replacements } = patchSpicaStorageSmali(DB_SMALI);

  assert.equal(changed, true);
  assert.equal(replacements, 1);
  assert.match(text, new RegExp(`const-string v2, "${LEGAL_DB_DIR}"`));
  assert.equal(hasBareSpicaTopLevelPath(text), false);
});

test('is idempotent on already-legal Music/SPICaMusic paths', () => {
  const once = patchSpicaStorageSmali(SETTINGS_SMALI).text;
  const twice = patchSpicaStorageSmali(once);

  assert.equal(twice.changed, false);
  assert.equal(twice.replacements, 0);
  assert.equal(twice.text, once);
  assert.equal((twice.text.match(/Music\/SPICaMusic/g) || []).length, 1);
});

test('does not rewrite SPICaMusicTheme or SPICaMusic_update.apk', () => {
  const { text, changed, replacements } = patchSpicaStorageSmali(NON_PATH_SMALI);

  assert.equal(changed, false);
  assert.equal(replacements, 0);
  assert.equal(text, NON_PATH_SMALI);
  assert.match(text, /SPICaMusicTheme/);
  assert.match(text, /SPICaMusic_update\.apk/);
  assert.equal(hasBareSpicaTopLevelPath(text), false);
});

test('patches both sites in a decoded apktool tree and clears bare paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spica-storage-'));
  try {
    const settingsPath = path.join(
      root,
      'smali_classes3/com/mineradio/app/LandscapeWebActivity$KAppBridge.smali',
    );
    const dbPath = path.join(
      root,
      'smali_classes3/com/mineradio/app/storage/impl/di/StorageModuleKt.smali',
    );
    const updatePath = path.join(
      root,
      'smali_classes3/com/mineradio/app/manager/CloudUpdateManager.smali',
    );
    for (const file of [settingsPath, dbPath, updatePath]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    }
    fs.writeFileSync(settingsPath, SETTINGS_SMALI, 'utf8');
    fs.writeFileSync(dbPath, DB_SMALI, 'utf8');
    fs.writeFileSync(updatePath, NON_PATH_SMALI, 'utf8');

    const result = patchSpicaStorageInDecodedDir(root);
    assert.equal(result.filesPatched, 2);
    assert.equal(result.replacements, 2);

    const settings = fs.readFileSync(settingsPath, 'utf8');
    const db = fs.readFileSync(dbPath, 'utf8');
    const update = fs.readFileSync(updatePath, 'utf8');

    assert.match(settings, new RegExp(`"${LEGAL_DIR}"`));
    assert.match(db, new RegExp(`"${LEGAL_DB_DIR}"`));
    assert.equal(update, NON_PATH_SMALI);

    // Second pass is a no-op but still succeeds (already legal)
    const again = patchSpicaStorageInDecodedDir(root);
    assert.equal(again.filesPatched, 0);
    assert.equal(again.replacements, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects decoded trees with neither legacy nor legal SPICa paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spica-storage-empty-'));
  try {
    const file = path.join(root, 'smali/com/example/Empty.smali');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '.class public Lcom/example/Empty;\n', 'utf8');
    assert.throws(() => patchSpicaStorageInDecodedDir(root), /No SPICaMusic storage paths/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
