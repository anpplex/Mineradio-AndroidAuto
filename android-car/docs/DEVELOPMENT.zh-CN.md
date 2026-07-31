# 车机适配 · 开发文档（强制）

本文档约束 **本仓库 `android-car/` 及 `huawei-android12-car` 分支上的全部开发**（含人类与 AI/coding agent）。  
与 [BOUNDARIES.zh-CN.md](./BOUNDARIES.zh-CN.md) 一并视为**必读且必须遵守**。

| 关联文档 | 内容 |
| --- | --- |
| [BOUNDARIES.zh-CN.md](./BOUNDARIES.zh-CN.md) | 硬边界、禁止项、安全与分发 |
| [FEATURE-MATRIX.zh-CN.md](./FEATURE-MATRIX.zh-CN.md) | Windows 2.0.3 ↔ 车机 1.1.7 对齐 |
| [VISUAL-LAYER.zh-CN.md](./VISUAL-LAYER.zh-CN.md) | 行车/巡航/舞台视觉架构 |
| [STAGE-GAPS.zh-CN.md](./STAGE-GAPS.zh-CN.md) | 舞台缺口清单 |
| [../README.zh-CN.md](../README.zh-CN.md) | 构建 / 安装 / 验收命令 |

---

## 1. 开发模式总则

### 1.1 最大并行 Subagents（强制默认）

在 **具备 ≥2 个可独立并行的工作域** 时，**必须**使用最大合理数量的 subagents 并行推进，而不是串行单线程啃完整任务。

| 规则 | 要求 |
| --- | --- |
| **何时必须并行** | 2+ 独立问题域（不同文件/子系统、无共享写冲突） |
| **并行粒度** | 一域一 agent：如 SPICa smali / HMI CSS / 验收脚本 / 文档 / 实车验证 |
| **主会话职责** | 拆任务、防冲突、集成、跑全量门禁、Git 提交与 push |
| **禁止** | 多个 agent 同时无协调地改同一文件（尤其 `patch-car-hmi-assets.js`、`car-visual-runtime.js`、`build-car-apk.sh`） |
| **串行例外** | 同一 APK **构建 → 签名 → Lyra 安装 → 截图验收** 链路；共享密钥/设备的互斥操作 |

**推荐并行扇出示例：**

```text
Agent A  explore/smali   存储或原生路径
Agent B  general         HMI / 视觉 runtime（独占相关脚本）
Agent C  general         测试与 verify 脚本
Agent D  general         文档 / 矩阵
Agent E  execute         实车 adb 验收（不改业务源码）
主会话              合并、node --test、commit、push origin
```

用户指令 **「max subagents」** 与本文等效：默认拉满并行，不得无故降级为单 agent。

### 1.2 产品视角

- 默认 **华为车机音乐类** 可用性（安全、大热区、少分心）。
- Mineradio「自由 / 开放 / 惊艳」放在 **舞台 mode** 最大化，不得默认行车全开。
- HMI 尺寸为**项目目标**，**不得**表述为华为 OEM 官方强制规范。

---

## 2. Git Workflow（强制）

### 2.1 分支与远端

| 项 | 规定 |
| --- | --- |
| 工作分支 | `huawei-android12-car`（默认） |
| 可推送远端 | **仅** `origin` → `anpplex/Mineradio-AndroidAuto` |
| 禁止推送 | **`upstream`**（`XxHuberrr/Mineradio`）— push 已 DISABLED，不得强行开启或 push |
| 基线参考 | 可 `git fetch upstream` 只读对齐 Windows 2.0.x 能力，**不**把车机补丁强推上游 |

### 2.2 提交前门禁（缺一不可）

每次修改后、`git commit` 之前必须：

```sh
# 1) 单元 / 契约测试
node --test android-car/tests/*.test.js

# 2) 脚本语法（若改动了 shell）
bash -n android-car/scripts/build-car-apk.sh
bash -n android-car/scripts/install-huawei-car.sh
bash -n android-car/scripts/verify-huawei-car.sh
bash -n android-car/scripts/verify-stage-showcase.sh

# 3) Node 语法（若改动了 js）
node --check android-car/scripts/patch-car-hmi-assets.js
node --check android-car/scripts/car-visual-runtime.js
# 以及本次改动的其他 .js

# 4) 空白/冲突标记
git diff --check

# 5) 确认干净提交面
git status --short --branch
```

**失败不得 commit。** 实车安装失败可记录，但不得用「跳过测试」换合并。

### 2.3 允许提交的路径

| 允许 | 禁止提交（即使本地存在） |
| --- | --- |
| `android-car/scripts/**` | `android-car/out/**`、`*.apk`、`*.idsig` |
| `android-car/tests/**` | `android-car/.signing/**`、`*.jks`、密码、`.env` |
| `android-car/docs/**`、`android-car/README.zh-CN.md` | `android-car/verification/**` 截图 / logcat / 二进制 |
| 与车机无关但同 PR 的必要文档 | Cookie、Token、网易云/QQ 登录态 |
| `.gitignore` 中合理排除项的更新 | 明文 MENC 资源、解密后的 bulk 资产 |

### 2.4 提交信息

- 使用约定式前缀：`feat(android-car):` / `fix(android-car):` / `docs(android-car):` / `test(android-car):`
- 说明**为什么**（车机约束、Android 12、密度、舞台清晰度等），而非只列文件名。
- 一次逻辑变更一次 commit；避免「杂糅大包」除非用户明确要求 squash。

### 2.5 推送

```sh
git push origin huawei-android12-car
```

- **禁止** `git push upstream`
- **禁止** force-push 已共享的 `origin/huawei-android12-car`（除非用户书面明确要求并知悉风险）
- 推送前再次确认 `git status` 无密钥/APK 误加

### 2.6 破坏性实车操作

| 操作 | 要求 |
| --- | --- |
| 普通覆盖安装 | `./android-car/scripts/install-huawei-car.sh`（Lyra 流程） |
| 清除数据重装 | 必须 `CLEAN_REINSTALL=1` **且** `ALLOW_DATA_LOSS_REINSTALL=YES`，并已告知用户数据会丢 |
| 默认安装脚本 | **不得**静默 uninstall |

### 2.7 截图与验收产物

- 截图、logcat、screencap **只**落在 `android-car/verification/`（gitignore）。
- **不得** `git add` 验证截图。
- 验收结论写进 commit message 或 `docs/` 文字说明即可。

---

## 3. 构建与验收（开发闭环）

```sh
# 构建（本机注入密钥，禁止写入仓库）
export JAVA_HOME=...
export APKTOOL_JAR=...
export MINERADIO_CAR_KEYSTORE=android-car/.signing/....jks
export MINERADIO_CAR_KEY_ALIAS=...
export MINERADIO_CAR_KEYSTORE_PASSWORD='…'   # keychain / 环境变量，勿入库

./android-car/scripts/build-car-apk.sh /path/to/Mineradio_1.1.7.0.apk
./android-car/scripts/install-huawei-car.sh LD249H019625 \
  ./android-car/out/Mineradio-1.1.7.0-huawei-android12-car.apk
./android-car/scripts/verify-huawei-car.sh LD249H019625
# 舞台 showcase 实车 smoke（截图/logcat 仅落 verification/，不入库）
./android-car/scripts/verify-stage-showcase.sh LD249H019625
```

构建链顺序（不得擅自调换关键补丁顺序而不更新文档与测试）：

```text
apktool d
  → patch-apk-manifest.js
  → patch-spica-storage.js      # SPICa → Music/SPICaMusic
  → patch-audio-focus-bridge.js # media3 AF → setAudioDuck JS
  → patch-car-hmi-assets.js     # MENC CSS + car-visual-runtime
  → apktool b → apksigner
```

---

## 4. 与 AI Agent 的约定

| Agent 类型 | 典型用途 |
| --- | --- |
| explore | 只读摸底、逆向字符串、缺口审计 |
| general-purpose | 实现补丁、测试、文档（划定独占文件） |
| execute | 实车 adb、安装、截图（不擅自 force-push） |

每个 subagent 的 prompt **必须**包含：

1. 工作目录与分支 `huawei-android12-car`
2. **遵守本 DEVELOPMENT + BOUNDARIES**
3. 独占文件列表或「禁止改 X」
4. 门禁命令与是否允许 commit/push（仅 `origin`）

主会话在 agent 返回后：**跑全量 `node --test android-car/tests/*.test.js`**，再统一提交，避免多 agent 交错破坏历史。

---

## 5. 修订

- 本文档变更本身也走 §2 Git Workflow，并 `docs(android-car):` 提交。
- 若与用户当次口头指令冲突：**用户当次明确指令优先**；之后应回写本文消除歧义。
