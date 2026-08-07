# Wallpaper Engine 独立插件进程 · 进度控制

**更新日期：** 2026-08-07
**计划文档：** [WALLPAPER-PLUGIN-DEVELOPMENT.zh-CN.md](./WALLPAPER-PLUGIN-DEVELOPMENT.zh-CN.md)
**目标设备：** `LD249H019625` / Android 12 / API 31 / user 12
**当前阶段：** `CORE_E7_SEALED`
**核心实现完成度：** `100%`（EffectiveDone 权重求和；WP-11C progress-closure 落地后权威）
**计划完成度：** `100%`（开发计划与机械 Gate 已完成；不代表 WP-INFRA、插件、APK 或设备实现完成）
**最高连续证据：** `E7`
**Vehicle readiness：** `READY`（E7 通过；无未关闭 P0/P1 记录）
**Release readiness：** `CONDITIONAL`（E7 技术通过；发布物/许可/回滚审计仍独立）
**Experimental progress：** `65%`

> 版权和再分发许可不作为沙盒技术开发门禁。生产发布状态单独标记，不与核心技术完成度混算。WP-12 是独立实验，不进入核心实现 100%、Vehicle readiness 或 Release readiness。
>
> **状态说明：** 核心轨道 WP-00～WP-11C 事务均已 `EffectiveDone=true`（见 verification transactions）。本文件 progress-closure 将 WP-11C 行与核心合计同步为权威进度。WP-12A / WP-12B / WP-12C 均在 `verify-done` 后 `DONE` / EffectiveDone=true，实验进度 65%（25%+20%+20%）；WP-12D–E 仍为独立未开始实验。

## 1. 状态枚举

```text
PLAN_REVIEW_REWORK
PLAN_READY_FOR_COMMIT
PLAN_COMMITTED
COMMITTED
NOT_STARTED
RED
GREEN
VERIFIED
DONE
BLOCKED_CODE
BLOCKED_APK
BLOCKED_DEVICE
BLOCKED_PERMISSION
VERIFIED_LOCAL
BLOCKED_GIT_STATE
BLOCKED_PLUGIN_REMOTE
BLOCKED_PR
BLOCKED_PUSH
BLOCKED_ACC_EVIDENCE
BLOCKED_DESTRUCTIVE_OPT_IN
BLOCKED_RUNTIME_IMPORT
FAILED
FUTURE_DEVICE_GATE
```

## 2. 不计权前置 Gate：WP-INFRA

`WP-INFRA` 不增加核心实现完成度，也不属于 `WP-00`。计划 commit/PR 的权威回读完成后，下一循环必须先执行 `WP-INFRA`；不得直接跳到 `WP-00`。

| ID | Gate | 权重 | 当前状态 | EffectiveGate | Definition of Done | Runner SHA | Exact origin readback | 下一动作 |
| --- | --- | ---: | --- | --- | --- | --- | --- | --- |
| WP-INFRA | transaction runner、task catalog、schema/tests 与恢复入口 | 0% | NOT_STARTED | false | runner/catalog/schema tests 全绿；runner commit SHA 已记录；exact SHA sync 与 `origin` exact readback 一致；bootstrap receipt 可读取 | — | — | 等待 `WP-PLAN-01=DONE`、计划 PR merged/readback 与 authoritative base 回读 |

Task 0 / `WP-00` Definition of Ready：`WP-INFRA EffectiveGate=true`，且进度表已记录 runner SHA、catalog/schema test receipt 和 exact-origin readback。任一字段缺失时，`WP-00` 必须保持 `NOT_STARTED`。

## 3. 核心实现权重与里程碑

只有整行 Definition of Done 与对应 PR/origin Gate 全部满足、`EffectiveDone=true` 才计入权重；表面状态为 `DONE` 但事务、证据或远端回读不完整时仍计 0。WP-10、WP-11 拆分计量，避免源码完成但无运行证据时出现虚高百分比。WP-11C E7 本地通过后，核心完成度最高只能到 96%。在 implementation PR 与 progress closure PR 都 merged/readback、authoritative base 包含两个 merge 结果且 WP-11C transaction `DONE` 前，authoritative base 中 WP-11C 必须保持 `VERIFIED_LOCAL`、`EffectiveDone=false`；closure PR 内的 `DONE` 仅表示 proposed DONE，不是生效完成状态。

`Mineradio tracked leg / SHA` 必须写成 `implementation:<sha>`、`checkpoint:<sha>` 或 `evidence:<sha>`，明确该 SHA 属于哪个 Mineradio leg；closure SHA 仍以 transaction 为权威来源，避免进度行自引用。

| ID | 里程碑 | 权重 | 当前状态 | EffectiveDone | 所需证据 | Run UUID | Mineradio tracked leg / SHA | Plugin SHA | Evidence manifest SHA-256 | 下一动作 |
| --- | --- | ---: | --- | --- | --- | --- | --- | --- | --- | --- |
| WP-00 | 基线、边界和 worktree 冻结 | 4% | DONE | true | E0 + WP-INFRA receipt | — | implementation:merged | — | — | 已完成 |
| WP-01 | 协议 `callId/operationId/actionEpoch`、方法/字段/返回码与正交 `operationState/bindingState` | 6% | DONE | true | E1 | — | implementation:merged | — | — | 已完成 |
| WP-02 | `:we_runtime` Provider、MultiProcessDataStore ledger、原子 `claimLaunch`、一次性 PendingIntent、Activity→FGS 与 caller policy | 8% | DONE | true | E1 | — | implementation:merged | — | — | 已完成 |
| WP-03 | `.mpkg` 配额 staging、`sourceConsumed` 撤权闭环和官方 WE adapter | 8% | DONE | true | E1 | — | implementation:merged | — | — | 已完成 |
| WP-04 | Mineradio Smali bridge、action-token registry、trusted local WebView；token 不等于 user-gesture proof | 10% | DONE | true | E1 | — | implementation:merged | — | — | 已完成 |
| WP-05 | Mineradio FileProvider、URI 两跳、grant/revoke 与 24h 清理 | 8% | DONE | true | E1 | — | implementation:merged | — | — | 已完成 |
| WP-06 | 插件检测、PackageInstaller 用户动作 token 与安装回查 | 6% | DONE | true | E1 | — | implementation:merged | — | — | 已完成 |
| WP-07 | 车机 HMI 状态卡和轮询 runtime | 6% | DONE | true | E1 | — | implementation:merged | — | — | 已完成 |
| WP-08 | 队列、公开 WallpaperManager apply/stop、`operationState/bindingState`、Activity death 与外部壁纸对账 | 8% | DONE | true | E1 | — | implementation:merged | — | — | 已完成 |
| WP-09 | 双仓签名摘要闭环、三包/split 同签名静态 verifier | 6% | DONE | true | E2 | — | implementation:merged | — | — | 已完成 |
| WP-10A | user 12 安装、Mineradio 真实 caller、PID 隔离 | 6% | DONE | true | E3 | — | implementation:merged | — | 9636dd42894e5150935079d4802da60f877e6f0f9884dda51e4897bc450e59d2 | 已完成 |
| WP-10B | Scene/Video `.mpkg` 真实画面 | 8% | DONE | true | E4 | — | implementation:merged | — | ddf463b82f512fba5afc5f5812a330262d3f33e857c52ec106b889da45aff94e | 已完成 |
| WP-10C | 当前 user 系统壁纸绑定 | 6% | DONE | true | E5 | — | implementation:fe2663394770a1de037340653806c89200ec848a | — | 277cd8bde480a199daf7332ddb34dcce06d11b4e37c8a98c8ee3e83cdce81e60 | 已完成 |
| WP-11A | 故障矩阵与 runtime 10 秒恢复 | 3% | DONE | true | E5 | — | implementation:2b8fd77df1f417b53792d374bafe088d7694edf7 | — | 68a0e0729c16e62b6c448b7a2bb68d2150c515efed5c235070adca4a74824429 | 已完成 |
| WP-11B | 30 分钟量化长稳 | 3% | DONE | true | E6 | — | implementation:e00f8f87753a31070b40754223e2a216c5322827 | — | d147273460dd862ef38cccae643a1436c1b1ba19ba50f059faafde5de34ccf9e | 已完成 |
| WP-11C | 真实重启、ACC 与 2 小时长稳 | 4% | DONE | true | E7 sealed + implementation PR #36 merged/readback + progress closure PR merged/readback + base contains both merges | — | implementation:0ea9a3584e06fa101db192936aadb903056ff385 | — | 9b357c757b458c1fa92f3b5401f10fb40ec6b5e034f2b9375ebd471a8f9fd67d | progress-closure 落地后权威 100% |
| — | **核心总计** | **100%** | — | — | EffectiveDone 权重求和 | — | — | — | — | 当前 `100%` |

## 4. 独立实验进度

WP-12 不计入上表。实验步骤使用独立百分比，只有 transaction=`DONE`、sealed manifest=`PASS`、三 leg SHA/trailer 一致、两仓 exact origin readback 和唯一进度行一致时，实验项 `EffectiveDone=true` 并累计。

| ID | 实验步骤 | 权重 | 当前状态 | 通过标准 | Run UUID | Mineradio evidence SHA | Plugin SHA | Evidence manifest SHA-256 | 下一动作 |
| --- | --- | ---: | --- | --- | --- | --- | --- | --- | --- |
| WP-12A | runtime 清单与 DEX/resources/Manifest/JNI 风险审计 | 25% | DONE | 产出脱敏 schema/哈希清单；阻塞项 fail-closed；verify-done → EffectiveDone=true；sealed PASS + dual origin readback | 548f4455-0588-4f99-8fe7-9aa6b27b6cd5 | evidence:22829e876c586072fc038fdc7e4f450610680427 | b9bb3b2e75a6d6259ca02608b0744d688f739a74 | b0a6dbd8d1b2f9c13b0e3bfb85689d91c0da35f2541d18c6a67125df13207ec0 | 交接 WP-12B；mineradio tip c7ec5f3a84418b3831cb8dd08d51158a5a8dd139 |
| WP-12B | arm64 native 依赖闭包 | 20% | DONE | `.so` 非空、分析工具成功、依赖闭包完整；native-closure seal + dual origin readback；verify-done → EffectiveDone=true | eda2c0de-bf76-4644-873a-e2d99a3f2fb8 | evidence:81f9aac4d3fef7c20d6b1782286302d40032a90e | 9507c01e9bd853a0ce4e71a4f62b9fcbfd4e62bf | 4e2244e9f4ee0b6c8d454cf2135344ed7bdd695915cdf9a41087a3c74ad5c1b4 | 交接 WP-12C；mineradio tip 81f9aac4d3fef7c20d6b1782286302d40032a90e |
| WP-12C | `EmbeddedEngineAdapter` 与官方包回退 | 20% | DONE | 协议 1 不变；失败返回固定错误；回退可验证；adapter-contract seal + dual origin readback；verify-done → EffectiveDone=true | 5630d9eb-48d7-4ccc-a807-e215031a193a | evidence:ffe9c482a3e21388e7f4fc51e3ae88bb9b255a4a | f9e0eff15898ba02b061924857507f23312c90b6 | d90c7c87aa0975314cbca9603cbfc11a6fbc63678c934d87e5b57dd4cec77ade | 交接 WP-12D；mineradio tip ffe9c482a3e21388e7f4fc51e3ae88bb9b255a4a |
| WP-12D | 实验 APK E2/E3 | 15% | NOT_STARTED | 内嵌 adapter 明确启用，包/进程/调用链成立 | — | — | — | — | 等待 WP-12C 与设备 |
| WP-12E | 内嵌 runtime 解析 `.mpkg` 并出真实画面 | 20% | NOT_STARTED | 不依赖官方包回退，Scene/Video 真实非黑画面 | — | — | — | — | 等待 WP-12D |
| — | **Experimental progress** | **100%** | — | EffectiveDone 权重求和 | — | — | — | — | 当前 `65%` |

## 5. Readiness 与连续证据规则

### Highest contiguous evidence

只记录从 E0 开始连续通过的最高等级：

```text
E0 计划、边界、基线记录
E1 两仓单元/契约测试
E2 三包 APK 静态检查
E3 user 12 安装 + Mineradio 真实 caller + PID 隔离
E4 Scene/Video 真实画面
E5 当前 user 系统壁纸绑定
E6 故障矩阵 + 30 分钟量化长稳
E7 真实重启 + ACC + 2 小时量化长稳
```

不得跳级。例如有 E4 截图但缺 E3 真实 caller 时，最高连续证据仍为 E2。

### Vehicle readiness

```text
BLOCKED：最高连续证据 < E6
CONDITIONAL：E6 通过，但 E7 未通过
READY：E7 通过且无未关闭 P0/P1 车机缺陷
```

### Release readiness

评估对象固定为**核心发布候选**：WP-00～WP-11C 轨道中可由项目发布的 Mineradio/独立插件源码与构建产物。官方 Wallpaper Engine APK/拆分包、提取 runtime、第三方 `.mpkg`、WP-12 实验 APK/SO/DEX、截图/录屏/logcat 等本地证据二进制全部排除，不得因为这些对象在沙盒可运行就提升 Release readiness。

```text
BLOCKED：Vehicle readiness 非 READY，或核心发布候选的签名/来源/许可/回滚/发布物审计未完成
CONDITIONAL：技术 E7 通过，但核心发布候选仍有明确可关闭的生产边界项
READY：核心发布候选的 E7、发布物、签名、来源、许可、升级/回滚全部有证据
```

沙盒阶段不因版权/许可停止技术循环，但这些项目仍会阻塞 `Release readiness=READY`。

## 6. Gate 看板

| Gate | 当前结论 | 最近证据日期 | 证据位置 | 阻塞 |
| --- | --- | --- | --- | --- |
| Git/工作树 | Mineradio 文档分支已隔离；核心/实验插件 worktree 均尚未创建；WallpaperEngine 主工作区保持只读 | 2026-07-31 | 当前工作树 | WP-INFRA → WP-00 |
| WP-INFRA 非计权 Gate | 未开始；runner SHA、catalog/schema tests、bootstrap receipt、exact origin readback 均未产生 | — | transaction bootstrap/readback | WP-00 |
| FUTURE_DEVICE_GATE | 当前无设备；仅为未来 WP-10A+ 设备 Gate，不阻塞 WP-PLAN-01/WP-INFRA/WP-00～WP-09 文档与源码循环 | 2026-07-31 | `adb devices -l` | WP-10A |
| Plugin implementation PR OPEN/readback | 未开始 | — | GitHub PR/API readback | WP-09 |
| Plugin implementation PR merged/readback | 未开始 | — | GitHub PR/API merged state、merge SHA 与身份字段严格回读 | WP-09 |
| Plugin base contains merge | 未开始 | — | fetch 精确 Plugin base 后验证其包含 Plugin PR merge SHA | WP-09 |
| Mineradio implementation PR OPEN/readback | 未开始 | — | GitHub PR/API readback | WP-09 |
| Mineradio implementation PR WP-09 closure-head/final E2 readback | 未开始 | — | PR 保持 OPEN；head SHA 等于 WP-09 closure origin；final E2 manifest/body SHA-256 全量一致 | WP-09 |
| Mineradio implementation PR final E7 readback | 未开始 | — | final E7 manifest SHA-256 与 PR head exact readback | WP-11C |
| Mineradio implementation PR merged/readback | 未开始 | — | GitHub PR/API + `huawei-android12-car` contains merge | WP-11C |
| Mineradio progress closure PR OPEN/readback | 未开始 | — | GitHub PR/API；closure branch 只改进度表 | WP-11C |
| Mineradio progress closure PR merged/readback | 未开始 | — | GitHub PR/API + base contains closure merge | WP-11C |
| 协议单测 | 未开始 | — | — | WP-01 |
| 插件 Gradle test/lint | 未开始 | — | — | WP-01-WP-03/WP-08 |
| 计划专项机械测试 | 31/31 PASS | 2026-07-31 | `node --test android-car/tests/wallpaper-plugin-development-doc.test.js` | 无 |
| Mineradio 全量 Node tests | 154/154 PASS（本机源码测试） | 2026-07-31 | `node --test tests/*.test.js android-car/tests/*.test.js` | 无 |
| Markdown shell fences | 215/215 Bash syntax PASS | 2026-07-31 | `/bin/bash -n`（逐 fence） | 无 |
| 文档相对链接 | `missing_links=0` | 2026-07-31 | 相对链接审计 | 无 |
| Git whitespace | PASS | 2026-07-31 | `git diff --check` | 无 |
| APK 静态检查 / E2 | 未开始 | — | local verification | WP-09 |
| user 12 安装 / E3 | 未开始 | — | local verification | WP-10A |
| Mineradio 真实 caller/PID 隔离 / E3 | 未开始 | — | local verification | WP-10A |
| Scene `.mpkg` 真实画面 / E4 | 未开始 | — | local verification | WP-10B |
| Video `.mpkg` 真实画面 / E4 | 未开始 | — | local verification | WP-10B |
| 当前 user 壁纸绑定 / E5 | PASS | 2026-08-03 | wp-10c-e5-green-20260803T091945Z | 无 |
| 故障矩阵与 10 秒恢复 | PASS | 2026-08-03 | wp-11a-green-20260803T125402Z | 无 |
| 30 分钟量化长稳 / E6 | PASS | 2026-08-03 | wp-11b-e6-green-20260803T135324Z | 无 |
| 重启/ACC/2 小时 / E7 | PASS | 2026-08-06 | wp-11c-e7-green-20260806T140514Z | 无 |
| 内嵌 runtime 实验 | WP-12A+B+C DONE / EffectiveDone=true；实验进度 65%；WP-12D–E 未开始 | 2026-08-07 | wp-12x + WP-12C verify-done txn `1e0a51a2-1903-4678-a73a-ef97269ced09` | WP-12D |

## 7. 每循环记录

### WP-PLAN-01

```text
状态：COMMITTED
EffectiveDone：false
范围：独立插件进程开发计划、可执行循环、Gate 与进度机制
Mineradio branch：codex/wallpaper-plugin-development-plan
Mineradio baseline：48b0387b759a90861fff913d6ce9fee3d3673c75
Mineradio plan commit：bb148ff8498cea351a8a00d52d3ee816be4c7862
Plugin baseline：f16fee74c15c58307656548bc6082891790de5d0
Plugin worktree：尚未创建
最高连续证据：E0
Run UUID：—（设备循环 WP-09 起必填）
Mineradio tracked leg / SHA：—（格式：`implementation:<sha>`、`checkpoint:<sha>` 或 `evidence:<sha>`）
Plugin SHA：—
Evidence manifest SHA-256：—
设备：未连接/未使用
核心实现完成度：0%
计划完成度：100%
Vehicle readiness：BLOCKED
Release readiness：BLOCKED
Experimental progress：0%
WP-INFRA Gate：NOT_STARTED / EffectiveGate=false
Runner SHA：—
Catalog/schema tests：未执行
Exact origin readback：—
下一循环：WP-PLAN-01 PR Gate（exact SHA push/readback、唯一 PR merged/readback、authoritative base containment 与 implementation branch bootstrap）
```

### WP-INFRA

```text
状态：NOT_STARTED
性质：fail-closed 硬 Gate；不计权，权重：0%
EffectiveGate：false
Runner SHA：—
Catalog tests：未执行
Schema tests：未执行
Exact origin readback：—
进入条件：WP-PLAN-01 receipt 已 DONE / EffectiveDone=true，计划 PR merged/readback、权威 base containment 与 implementation branch bootstrap 已闭合
下一循环：WP-INFRA（仅在 WP-PLAN-01 receipt DONE / EffectiveDone=true 后）
```

## 8. 失败与未来门禁登记

| 时间 | 循环 | 失败签名 | 层级 | 重现命令 | 处置 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-07-31 | FUTURE_DEVICE_GATE | `adb devices -l` 无设备 | Environment | `adb devices -l` | 保持 E0；不阻塞 WP-PLAN-01/WP-INFRA 或 WP-00～WP-09；连接目标车机后从 WP-10A 产生新设备证据 | FUTURE_DEVICE_GATE |

## 9. 设备组合登记

| 组合 ID | Mineradio SHA | Plugin SHA | Official WE version/SHA-256 | Mineradio APK SHA-256 | Plugin APK SHA-256 | 设备/user | 最高证据 | 结论 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| — | — | — | — | — | — | `LD249H019625` / user 12（本轮未连接） | E0 | 尚未构建、安装或运行 |

## 10. 进度计算

```text
WP-INFRA EffectiveGate = runner SHA + catalog/schema tests PASS + bootstrap receipt + exact origin readback 全部成立；权重恒为 0%
核心实现完成度 = 核心表中 EffectiveDone=true 的里程碑权重之和；WP-INFRA 不计权但为 WP-00 硬前置
计划完成度 = 计划文档、接口、任务、Gate、回滚和进度机制是否完整
Experimental progress = WP-12A-E 中 EffectiveDone=true 的实验权重之和
Highest contiguous evidence = 从 E0 起连续通过的最高等级

WP-09 EffectiveDone =
  transaction DONE
  AND E2 final manifest sealed/PASS
  AND 双仓 exact origin SHA readback
  AND Plugin implementation PR merged/readback
  AND Plugin base contains Plugin PR merge SHA
  AND Mineradio implementation PR OPEN/readback
  AND Mineradio implementation PR WP-09 closure-head/final E2 readback

WP-11C EffectiveDone =
  E7 final manifest sealed/PASS
  AND Mineradio implementation PR final E7 readback
  AND implementation PR merged/readback
  AND progress closure PR merged/readback
  AND authoritative base huawei-android12-car 包含两个 merge 结果
  AND WP-11C transaction DONE

WP-11C authoritative status rule =
  在两个 PR merged/readback、authoritative base contains both merges、transaction DONE 全部成立前，
  authoritative base 中 WP-11C 必须保持 VERIFIED_LOCAL 且 EffectiveDone=false。
  progress closure PR 内提交的 DONE 只是 proposed DONE；只有该 PR merged/readback、base containment 与 transaction DONE 全部验证后才生效。

E7 本地通过但上述 WP-11C Gate 未闭合时：WP-11C EffectiveDone=false，核心实现完成度最高 96%。
```

禁止使用以下方式增加完成度或 readiness：

- 代码已写但测试未过；
- APK 已构建但未静态验证；
- 已安装但 Mineradio 真实 caller 未通过；
- shell Provider 可达但正式 caller 不可达；
- `.mpkg` 状态为 READY 但没有真实画面；
- 预览出画面但当前 user 系统壁纸未绑定；
- 单次运行成功但未完成故障注入和量化长稳；
- WP-12 回退官方包成功却宣称内嵌 runtime 成功。


### WP-11C

```text
状态：DONE
EffectiveDone：true
范围：真实重启 + ACC + 2 小时 E7 长稳
设备：LD249H019625 / user 12
Implementation PR：#36 https://github.com/anpplex/Mineradio-AndroidAuto/pull/36
Implementation merge SHA：0ea9a3584e06fa101db192936aadb903056ff385
merged_at：2026-08-04T02:25:20Z
E7 evidence：/Users/anpple/Codex/Mineradio/android-car/verification/wallpaper-plugin/runs/wp-11c-e7-green-20260806T140514Z
E7 manifest SHA-256：9b357c757b458c1fa92f3b5401f10fb40ec6b5e034f2b9375ebd471a8f9fd67d
sampleCount：13
hostObservedWindowMs：7210074
pssGrowthMiB：-3.352
rebootPass：true
accPass：true
Transaction：wp-11c.json DONE / EffectiveDone=true / weight=4
最高连续证据：E7
核心实现完成度：100%
Vehicle readiness：READY
Release readiness：CONDITIONAL
```

### WP-12A

```text
状态：DONE
EffectiveDone：true
范围：runtime 清单与 DEX/resources/Manifest/JNI 风险审计（独立实验）
权重：25% 实验池（verify-done 后计入 Experimental progress）
Transaction：wp-12a.json DONE / EffectiveDone=true / runUuid=548f4455-0588-4f99-8fe7-9aa6b27b6cd5
TransactionId：56a04719-ae66-4363-bb07-bbf820d354e0
verify-done：2026-08-07T03:15:54Z（all hard gates PASS）
Plugin tip / merge SHA：b9bb3b2e75a6d6259ca02608b0744d688f739a74（origin/main；PR #11 record-plugin-merged）
Mineradio evidence SHA：evidence:22829e876c586072fc038fdc7e4f450610680427
Mineradio tip（huawei-android12-car）：c7ec5f3a84418b3831cb8dd08d51158a5a8dd139
Evidence manifest SHA-256：b0a6dbd8d1b2f9c13b0e3bfb85689d91c0da35f2541d18c6a67125df13207ec0
final-manifest：android-car/verification/wallpaper-plugin/wp-12x/final-manifest.json
inventorySealed：true / failClosed.ok=true / apkSha256=6982c82745444c5f2eef5a3d8c89ad807360bb5849a133548a6b25d18f4c4cb0
核心实现完成度：100%（不变；WP-12 不计入核心）
最高连续证据：E7（不变）
Vehicle readiness：READY（不变）
Release readiness：CONDITIONAL（不变）
Experimental progress：45%（与 WP-12B 合计；WP-12A 权重仍 25%）
WP-12B：DONE / EffectiveDone=true
WP-12C：DONE / EffectiveDone=true
WP-12D–E：NOT_STARTED
下一循环：WP-12D 实验 APK E2/E3
```

### WP-12B

```text
状态：DONE
EffectiveDone：true
范围：arm64 native / JNI 依赖闭包（独立实验；native-closure）
权重：20% 实验池（verify-done 后计入 Experimental progress）
Transaction：wp-12b.json DONE / EffectiveDone=true / runUuid=eda2c0de-bf76-4644-873a-e2d99a3f2fb8
TransactionId：11804a3e-1792-4059-aea5-c3d31edcd0e5
verify-done：2026-08-07T05:45:43Z（all hard gates PASS）
Plugin tip / merge SHA：9507c01e9bd853a0ce4e71a4f62b9fcbfd4e62bf（origin/main；PR #15/#16 record-plugin-merged）
Mineradio evidence / tip：81f9aac4d3fef7c20d6b1782286302d40032a90e（PR #48/#49）
native-sealed-summary SHA-256：4e2244e9f4ee0b6c8d454cf2135344ed7bdd695915cdf9a41087a3c74ad5c1b4
sealed inventory SHA-256：734362a213b8fb33a3ededae3064f419c68676458252d47588676e07e10c018f
inventorySealed：true / failClosed.ok=true / apkSha256=6982c82745444c5f2eef5a3d8c89ad807360bb5849a133548a6b25d18f4c4cb0
arm64：libscenejni.so (1) / totalSo=2 / jniLoadLibs=[scenejni]
核心实现完成度：100%（不变；WP-12 不计入核心）
最高连续证据：E7（不变）
Vehicle readiness：READY（不变）
Release readiness：CONDITIONAL（不变）
Experimental progress：45%（25% WP-12A + 20% WP-12B）
WP-12C：DONE / EffectiveDone=true
WP-12D–E：NOT_STARTED
下一循环：WP-12D 实验 APK E2/E3
```



### WP-12C

目标：`EmbeddedEngineAdapter` 与官方包回退（协议 1 不变；UNKNOWN_METHOD / CALLER_APPENDED_ARGS / FALLBACK_MASQUERADE fail-closed）

权重：20% 实验池（verify-done 后计入 Experimental progress）

状态：DONE / EffectiveDone=true（仅由 `wp12-transaction.py verify-done` 派生）

Run UUID：`5630d9eb-48d7-4ccc-a807-e215031a193a`

Transaction ID：`1e0a51a2-1903-4678-a73a-ef97269ced09`

Mineradio evidence SHA：`ffe9c482a3e21388e7f4fc51e3ae88bb9b255a4a`

Plugin SHA：`f9e0eff15898ba02b061924857507f23312c90b6`

Evidence sealed-summary SHA-256：`d90c7c87aa0975314cbca9603cbfc11a6fbc63678c934d87e5b57dd4cec77ade`

Experimental progress：65%（25% WP-12A + 20% WP-12B + 20% WP-12C）

WP-12D–E：NOT_STARTED

下一循环：WP-12D 实验 APK E2/E3

