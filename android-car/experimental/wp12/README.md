# WP-12A experimental tools (not core)

**Status:** experimental promotion of verification draft tools  
**Scope:** host-side official-APK runtime inventory import + fail-closed verify  
**Not core:** these paths are under `android-car/experimental/wp12/` and are **not** part of the default car build, install, or WP-00–WP-11C sandbox track.

## Layout

```text
android-car/experimental/wp12/
  README.md                          # this file
  runtime-import/
    manifest-map.schema.json         # inventory schema (wp12a-manifest-map/v1)
  scripts/
    import-official-runtime.sh       # APK → inventory.json (static dump)
    verify-imported-runtime.sh       # fail-closed inventory verifier
    tests/
      test-runtime-import.sh         # outline unit-like shell tests
```

Source drafts lived under:

`android-car/verification/wallpaper-plugin/runs/wp-12a-draft/`

Core plugin allowlist (later, separate worktree) still targets plugin-root
`runtime-import/` + `scripts/` as defined for WP-12A in
`docs/WALLPAPER-PLUGIN-DEVELOPMENT.zh-CN.md`. This experimental tree is a
Mineradio-side staging copy only.

## Tools

### `import-official-runtime.sh`

Static inventory from an official (or candidate) APK. Does not install or run.

```bash
./scripts/import-official-runtime.sh --apk PATH --out DIR
# writes DIR/inventory.json
```

Requires `aapt` and/or `aapt2` (Android SDK build-tools), `python3`, and
`shasum`/`sha256sum`.

### `verify-imported-runtime.sh`

Fail-closed verifier. Accepts draft-1 importer shape or schema-shaped
inventories.

```bash
./scripts/verify-imported-runtime.sh --inventory PATH --mode MODE
```

Modes:

| Mode | Expected |
| --- | --- |
| `positive` | exit 0 only when inventory is clean |
| `negative-missing-dex` | non-zero + stderr `MISSING_DEX` |
| `negative-auth-conflict` | non-zero + stderr `AUTHORITY_CONFLICT` |
| `negative-unknown-signature-permission` | non-zero + stderr `UNKNOWN_SIGNATURE_PERMISSION` |
| `negative-resource-id-conflict` | non-zero + stderr `RESOURCE_ID_CONFLICT` |

Fail-closed codes: `UNKNOWN_SIGNATURE_PERMISSION`, `AUTHORITY_CONFLICT`,
`MISSING_DEX`, `RESOURCE_ID_CONFLICT`.

### `tests/test-runtime-import.sh`

Outline harness with inline JSON fixtures (not catalog basenames yet).

```bash
./scripts/tests/test-runtime-import.sh
```

Optional APK smoke: set `OFFICIAL_WE_APK` or provide
`verification/wallpaper-plugin/runs/wp-12a-assets/base.apk` (local only;
never commit APKs).

## Boundaries

- Experimental only — do not wire into `build-car-apk.sh` / default verify.
- No APK, JKS, DEX extract, SO, screenshot, or logcat commits.
- Official runtime bytes stay local / ignored; only desensitized schema + tools here.
- WP-12A～E core implementation still requires WP-INFRA bootstrap + plugin worktree gates.

## Fixture plan (not in this tree yet)

See verification draft `FIXTURES.md` for the four negative basenames + one
positive inventory fixture. Catalog wiring and RED harness remain plugin-side.
