# Agent instructions — Mineradio Android car (`android-car/`)

You are working on the **Huawei Android 12 car adaptation**, not a generic Electron port.

## Mandatory reading (before any edit)

1. [docs/BOUNDARIES.zh-CN.md](./docs/BOUNDARIES.zh-CN.md) — hard boundaries
2. [docs/DEVELOPMENT.zh-CN.md](./docs/DEVELOPMENT.zh-CN.md) — max subagents + git workflow
3. [docs/WALLPAPER-PLUGIN-DEVELOPMENT.zh-CN.md](./docs/WALLPAPER-PLUGIN-DEVELOPMENT.zh-CN.md) — 方案 3 的唯一任务、事务与证据规范
4. [docs/WALLPAPER-PLUGIN-PROGRESS.zh-CN.md](./docs/WALLPAPER-PLUGIN-PROGRESS.zh-CN.md) — 权威阶段、Gate、SHA 与下一循环

**B0 + B1 are non-negotiable:**

- **Strict git workflow:** `huawei-android12-car` is the integration branch; task branches use `codex/*`; push **only** to `origin`, never `upstream`; no APK/JKS/secrets/screenshots in commits; run `node --test android-car/tests/*.test.js` before commit.
- **Max subagents:** when ≥2 independent domains exist, fan out parallel agents; main session integrates and owns the final push.

## Wallpaper plugin fail-closed entry

- `WP-00`～`WP-12E` are implementation tasks, not documentation-review tasks. Do **not** start them while progress is `PLAN_REVIEW_REWORK`, `WP-PLAN-01` is not `DONE`, the plan PR is not merged/read back from `origin/huawei-android12-car`, or the non-weighted `WP-INFRA` Gate is not `DONE`.
- `WP-INFRA` must record the committed transaction runner SHA, catalog/schema test results, exact-SHA sync receipt, and exact `origin` readback before `WP-00` may enter RED.
- Scheme 3 implementation may sync only through the transaction CLI using exact SHA refspec + remote readback. The generic branch-push command in DEVELOPMENT is not an implementation entry for this track.

## Scope

- Repack `Mineradio_*.apk` via apktool + patches (manifest, SPICa storage, MENC HMI/visual runtime).
- Target device profile: landscape 1920×1080 @ 320dpi, user 12, Lyra install flow.

## Do not

- Claim Huawei OEM certification for HMI sizes.
- Bypass login / pirate streams.
- Port Wallpaper Engine, full desktop mode, or desktop lyrics as car defaults. Exception: the user-authorized sandbox may implement the isolated plugin process defined in `docs/WALLPAPER-PLUGIN-DEVELOPMENT.zh-CN.md`; never make it the default car path or commit sandbox binaries.
- Commit `out/`, `.signing/`, `verification/` binaries.
