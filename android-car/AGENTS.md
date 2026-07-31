# Agent instructions — Mineradio Android car (`android-car/`)

You are working on the **Huawei Android 12 car adaptation**, not a generic Electron port.

## Mandatory reading (before any edit)

1. [docs/BOUNDARIES.zh-CN.md](./docs/BOUNDARIES.zh-CN.md) — hard boundaries  
2. [docs/DEVELOPMENT.zh-CN.md](./docs/DEVELOPMENT.zh-CN.md) — max subagents + git workflow  

**B0 + B1 are non-negotiable:**

- **Strict git workflow:** branch `huawei-android12-car`, push **only** `origin`, never `upstream`; no APK/JKS/secrets/screenshots in commits; run `node --test android-car/tests/*.test.js` before commit.  
- **Max subagents:** when ≥2 independent domains exist, fan out parallel agents; main session integrates and owns the final push.

## Scope

- Repack `Mineradio_*.apk` via apktool + patches (manifest, SPICa storage, MENC HMI/visual runtime).  
- Target device profile: landscape 1920×1080 @ 320dpi, user 12, Lyra install flow.

## Do not

- Claim Huawei OEM certification for HMI sizes.  
- Bypass login / pirate streams.  
- Port Wallpaper Engine, full desktop mode, or desktop lyrics as car defaults.  
- Commit `out/`, `.signing/`, `verification/` binaries.
