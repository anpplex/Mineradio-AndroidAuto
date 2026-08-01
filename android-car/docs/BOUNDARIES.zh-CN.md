# 车机适配 · 必须遵守的边界

**效力：** 硬约束。违反任一条即视为不合格变更，不得合并/推送。
配合 [DEVELOPMENT.zh-CN.md](./DEVELOPMENT.zh-CN.md) 使用。方案 3 还必须同时读取 [WALLPAPER-PLUGIN-DEVELOPMENT.zh-CN.md](./WALLPAPER-PLUGIN-DEVELOPMENT.zh-CN.md) 与 [WALLPAPER-PLUGIN-PROGRESS.zh-CN.md](./WALLPAPER-PLUGIN-PROGRESS.zh-CN.md)。

---

## 0. 两条总纲（最高优先级）

| # | 边界 | 含义 |
| --- | --- | --- |
| **B0** | **严格 Git Workflow** | `huawei-android12-car` 为集成分支，任务分支使用 `codex/*`；仅 push `origin`；提交前测试；禁止密钥与 APK 入库；禁止 push `upstream`。详见 DEVELOPMENT §2。 |
| **B1** | **Max Subagents** | ≥2 独立工作域时**必须**最大合理并行 subagents；主会话集成；禁止无协调抢改同一关键文件。详见 DEVELOPMENT §1.1。 |

其余边界按域展开。

---

## 1. 仓库与远端

| ID | 边界 |
| --- | --- |
| B-GIT-01 | 推送目标 **仅** `origin`（`anpplex/Mineradio-AndroidAuto`）。 |
| B-GIT-02 | **禁止** 向 `upstream`（`XxHuberrr/Mineradio`）push、开 PR 除非用户明确授权单独流程。 |
| B-GIT-03 | 本项目**绝对禁止** `git push --force`、`git push --force-with-lease` 和改写任何已推送历史；不设用户确认例外。 |
| B-GIT-04 | 提交前必须通过 DEVELOPMENT §2.2 门禁。 |
| B-GIT-05 | 一次 commit 只含源码/测试/文档；**零**密钥、零安装包、零登录态。 |
| B-GIT-06 | 方案 3 在 `WP-INFRA` 之后采用 **transaction-only exact sync**：implementation/evidence/closure 只能由 transaction CLI 以 exact SHA refspec 同步并回读；禁止普通 branch push、手工 PR mutation 或跨中断重复非幂等动作。 |

---

## 2. 禁止入库与禁止泄露

| ID | 禁止 |
| --- | --- |
| B-SEC-01 | `*.apk`、`*.jks`、`android-car/.signing/**`、`android-car/out/**` |
| B-SEC-02 | 密钥库密码、`MINERADIO_CAR_KEYSTORE_PASSWORD` 写入脚本/文档/日志 |
| B-SEC-03 | Cookie、Token、扫码登录态、用户个人曲库导出 |
| B-SEC-04 | 实车截图/logcat 进 Git（仅 `verification/` 本地） |
| B-SEC-05 | 在聊天/commit 中粘贴完整密钥或证书私钥 |

---

## 3. 产品与合规

| ID | 边界 |
| --- | --- |
| B-PRD-01 | **不**宣称华为 OEM 官方认证或强制 HMI 规范；只写「项目车机目标」。 |
| B-PRD-02 | **不**绕过登录、伪造会员、破解音质、二次分发受版权保护的音源。 |
| B-PRD-03 | 登录入口仅调用应用既有能力（如 `showLoginModal()`），不伪造票据。 |
| B-PRD-04 | 安全与惊艳：历史默认可为 **行车**；**当前车机产品决策为固定 stage showcase**（无 on-screen 三模式条）。drive/cruise 预算可 API 或 FX「弱动效」调用；改默认须同步 VISUAL-LAYER / FEATURE-MATRIX / ALIGNMENT-WINDOWS。 |
| B-PRD-05 | **默认/生产车机主路径永不移植** Wallpaper Engine、完整桌面 WorkerW、桌面歌词独立窗、系统托盘热更安装包。用户明确授权的沙盒可在 `codex/wallpaper-*` 隔离分支/worktree 中开发**独立 Wallpaper Engine 插件进程**；不得设为默认播放入口，不得把沙盒二进制并入生产提交或发布物。 |
| B-PRD-06 | 方案 3 的 `Release readiness` 只评估核心轨道的可发布候选，且必须排除官方 Wallpaper Engine 包/拆分包、提取 runtime、第三方 `.mpkg`、WP-12 实验 APK/SO/DEX 及本地证据二进制；沙盒技术完成不得自动推导公开发布可行。 |

---

## 4. 技术边界

| ID | 边界 |
| --- | --- |
| B-TECH-01 | 车机包 = **APK 重打包适配**，不是 Electron 交叉编译；勿假设 `public/js/modules` 已在车机运行。 |
| B-TECH-02 | HMI media query 使用 **CSS 像素**（320dpi → 约 960×540），禁止再引入物理像素门槛（如 1548px）。 |
| B-TECH-03 | MENC 资源改完必须重新加密；禁止最终 APK 依赖明文 `assets/mineradio` 敏感逻辑外泄策略变更而不更新构建。 |
| B-TECH-04 | SPICa 路径仅允许合法共享目录（如 `Music/SPICaMusic`）或 app-specific；**禁止**靠 ADB 建非法顶级目录冒充兼容。 |
| B-TECH-05 | 破坏性重装必须双开关：`CLEAN_REINSTALL=1` + `ALLOW_DATA_LOSS_REINSTALL=YES`。 |
| B-TECH-06 | WebGL 舞台清晰度：禁止用 CSS `opacity<1` 作用在主 canvas 上制造「假降载」（Android WebView 会糊）。 |
| B-TECH-07 | 多 agent 并行时关键文件独占：`patch-car-hmi-assets.js`、`car-visual-runtime.js`、`build-car-apk.sh`、`patch-spica-storage.js` 同一时刻仅一个写者。 |
| B-TECH-08 | 方案 3 fail-closed：进度表未达到 `PLAN_COMMITTED`、`WP-PLAN-01=DONE`、计划 PR merged/readback 且 `WP-INFRA=DONE` 时，不得执行 `WP-00` 或任何实现/设备任务。`WP-INFRA` 不计核心权重，但必须持久化 runner SHA、catalog/schema 测试与 exact-origin readback。 |
| B-TECH-09 | worktree 隔离不可混用：`WP-00`～`WP-11C` 使用 `mineradio-plugin-sandbox` 核心 worktree；`WP-12A`～`WP-12E` 使用 `mineradio-plugin-embedded-runtime` 与 `wallpaper-plugin-experimental` 两个实验 worktree；WallpaperEngine 主工作区始终只读。 |

---

## 5. 实车与设备

| ID | 边界 |
| --- | --- |
| B-DEV-01 | 默认设备假设：`LD249H019625`、user **12**、Lyra 安装器身份；改用户/序列号须文档与脚本默认同步。 |
| B-DEV-02 | 普通 `adb install` 在本车机不可靠；使用仓库 Lyra 脚本。 |
| B-DEV-03 | 验收脚本默认非破坏；不得在 verify 里夹带 uninstall。 |
| B-DEV-04 | 不猜测/爆破 keystore 密码；密码仅本机 keychain 或用户提供的环境变量。 |
| B-DEV-05 | 文档/事务基础设施阶段无设备仅登记为 `FUTURE_DEVICE_GATE`；它不阻塞 `WP-PLAN-01` 或 `WP-INFRA`，也不得伪装成设备已通过。设备上下文 Gate 从 WP-10A 起逐循环强制。 |

---

## 6. Subagents 边界

| ID | 边界 |
| --- | --- |
| B-AGENT-01 | 满足并行条件时 **必须 max subagents**，禁止无故单线程拖延。 |
| B-AGENT-02 | 每个 agent prompt 必须带：分支、DEVELOPMENT+BOUNDARIES、独占文件、是否允许 commit。 |
| B-AGENT-03 | Agent **不得**自行 push `upstream`；任何会话均不得执行 `git push --force`、`git push --force-with-lease` 或改写已推送历史。 |
| B-AGENT-04 | Agent 产出的密钥、截图路径不得被主会话 `git add`。 |
| B-AGENT-05 | 主会话负责最终测试与一次干净 push；避免 N 个 agent 交错 push 造成半成品远端。 |

---

## 7. 违规处理

1. 发现密钥/APK 已进入提交：立即从索引移除、轮换密钥（如适用）、重写或新 commit 清理（按用户授权处理历史）。
2. 发现 push 到错误远端：停止后续推送，与用户确认回滚策略。
3. 未跑测试的合并请求：打回，补门禁。

---

## 8. 检查清单（每次 PR / 会话结束前）

- [ ] 已读 DEVELOPMENT + BOUNDARIES
- [ ] 独立任务已 max subagents 拆分（或书面说明为何串行）
- [ ] `node --test android-car/tests/*.test.js` 全绿
- [ ] `git status` 无 apk/jks/verification 截图
- [ ] 仅 push `origin`；当前分支为 `codex/*` 任务分支或 `huawei-android12-car` 集成分支
- [ ] 未向用户或日志泄露密码
