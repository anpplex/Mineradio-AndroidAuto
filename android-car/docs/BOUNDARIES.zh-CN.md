# 车机适配 · 必须遵守的边界

**效力：** 硬约束。违反任一条即视为不合格变更，不得合并/推送。  
配合 [DEVELOPMENT.zh-CN.md](./DEVELOPMENT.zh-CN.md) 使用。

---

## 0. 两条总纲（最高优先级）

| # | 边界 | 含义 |
| --- | --- | --- |
| **B0** | **严格 Git Workflow** | 仅 `origin` / `huawei-android12-car`；提交前测试；禁止密钥与 APK 入库；禁止 push `upstream`。详见 DEVELOPMENT §2。 |
| **B1** | **Max Subagents** | ≥2 独立工作域时**必须**最大合理并行 subagents；主会话集成；禁止无协调抢改同一关键文件。详见 DEVELOPMENT §1.1。 |

其余边界按域展开。

---

## 1. 仓库与远端

| ID | 边界 |
| --- | --- |
| B-GIT-01 | 推送目标 **仅** `origin`（`anpplex/Mineradio-AndroidAuto`）。 |
| B-GIT-02 | **禁止** 向 `upstream`（`XxHuberrr/Mineradio`）push、开 PR 除非用户明确授权单独流程。 |
| B-GIT-03 | **禁止** 无用户确认的 force-push、改写已推送历史。 |
| B-GIT-04 | 提交前必须通过 DEVELOPMENT §2.2 门禁。 |
| B-GIT-05 | 一次 commit 只含源码/测试/文档；**零**密钥、零安装包、零登录态。 |

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
| B-PRD-04 | 默认 **行车** 模式优先安全；**舞台** 惊艳必须用户显式选择（或明确产品决策后改默认并更新文档）。 |
| B-PRD-05 | **永不移植** 到车机主路径：Wallpaper Engine、完整桌面 WorkerW、桌面歌词独立窗、系统托盘热更安装包。 |

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

---

## 5. 实车与设备

| ID | 边界 |
| --- | --- |
| B-DEV-01 | 默认设备假设：`LD249H019625`、user **12**、Lyra 安装器身份；改用户/序列号须文档与脚本默认同步。 |
| B-DEV-02 | 普通 `adb install` 在本车机不可靠；使用仓库 Lyra 脚本。 |
| B-DEV-03 | 验收脚本默认非破坏；不得在 verify 里夹带 uninstall。 |
| B-DEV-04 | 不猜测/爆破 keystore 密码；密码仅本机 keychain 或用户提供的环境变量。 |

---

## 6. Subagents 边界

| ID | 边界 |
| --- | --- |
| B-AGENT-01 | 满足并行条件时 **必须 max subagents**，禁止无故单线程拖延。 |
| B-AGENT-02 | 每个 agent prompt 必须带：分支、DEVELOPMENT+BOUNDARIES、独占文件、是否允许 commit。 |
| B-AGENT-03 | Agent **不得**自行 push `upstream` 或 force-push。 |
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
- [ ] 仅 push `origin huawei-android12-car`  
- [ ] 未向用户或日志泄露密码  
