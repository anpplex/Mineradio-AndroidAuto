# Windows 2.0.3 ↔ 车机 1.1.7 能力对齐矩阵（冻结）

> **冻结说明**：本表固化 `huawei-android12-car` 分支在文档写入时点的能力对齐共识。  
> 不是华为 OEM 认证声明，也不把未验收项写成已兼容。  
> 后续变更请改代码与验收后再修订本表，避免口头漂移。

| 维度 | 基线 |
| --- | --- |
| **上游 Windows** | [XxHuberrr/Mineradio](https://github.com/XxHuberrr/Mineradio) **v2.0.3** Electron 桌面正式版 |
| **车机产物** | 上游 APK **1.1.7.0** + `android-car/` 补丁（横屏、HMI 密度、视觉三模式、Lyra 安装） |
| **目标硬件** | Huawei `ICHU3200E15-ADV`，Android 12，1920×1080 @ 320dpi，应用用户 `12` |
| **适配形态** | 对用户提供的 Android APK **重打包/壳层注入**，不是把 Electron 工程直接编译成 Android |

### 列定义

| 列 | 含义 |
| --- | --- |
| **Windows 能力** | 上游 2.0.3 已具备或公开宣传的能力（`WIN-*`）或车机侧专属能力（`CAR-*`） |
| **Car 状态** | `已交付` / `部分` / `待验收` / `阻塞` / **`非目标`** |
| **Phase** | 交付阶段标签（见下） |
| **Notes** | 实现锚点、验收边界、已知缺口 |

### Phase 标签

| Phase | 含义 |
| --- | --- |
| **P0-壳** | 横屏启动、manifest、签名覆盖安装基线 |
| **P1-安装** | 华为车机 Lyra 安装路径 |
| **P2-HMI** | 密度感知壳层、触控热区、驾驶态底栏 |
| **P3-视觉** | drive / cruise / stage 视觉预算与上游 API |
| **P4-媒体** | 播放、音频焦点、本地库、存储持久化 |
| **P5-平台** | 账号、多源、更新、桌面专属子系统 |
| **NG** | 明确非目标，不排期对齐 |

---

## 1. CAR-* 车机专属 / 适配层

| ID | Windows 能力（对照） | Car 状态 | Phase | Notes |
| --- | --- | --- | --- | --- |
| **CAR-LANDSCAPE** | 窗口任意尺寸 / 全屏 | **已交付** | P0-壳 | 启动入口切到 `LandscapeWebActivity`；portrait Activity 改 landscape；`resizeableActivity=true`；`exported=true`（Android 12）。 |
| **CAR-LAUNCHER** | 桌面快捷方式 / 托盘 | **已交付** | P0-壳 | Intent 同时含 `LAUNCHER` + `CAR_LAUNCHER`。OEM Launcher 图标策略仍属待验收，不宣称全 OEM 兼容。 |
| **CAR-INSTALL-LYRA** | NSIS 安装器 | **已交付** | P1-安装 | 普通 `adb install` 被 HMI 拒绝；`install-huawei-car.sh` 按 Lyra：临时停 `PackageInstaller`，以 `com.huawei.appinstaller.car` 对 user 12 `pm install`。破坏性重装需显式 `CLEAN_REINSTALL` + `ALLOW_DATA_LOSS_REINSTALL`。 |
| **CAR-HMI-DENSITY** | 桌面 DPI / 缩放 | **已交付** | P2-HMI | 密度修复 + 车机 type/touch（64/76、曲名 24）；`--car-safe-top/bottom` 避状态栏/Docker。 |
| **CAR-HMI-LOGIN** | 登录模态 | **部分** | P2-HMI | 空首页「网易云扫码登录」；播放页藏 APEX/会员胶囊；真车扫码闭环待验收。 |
| **CAR-HMI-IA** | 桌面角区/模式条 | **已交付** | P2-HMI | TL Home+列表；底中「视觉控制台」抽屉；插件 FAB 仅空首页；**无**行车/巡航/舞台常驻条；底栏减负保曲名。见 [VISUAL-LAYER.zh-CN.md](./VISUAL-LAYER.zh-CN.md) §1.3。 |
| **CAR-VISUAL-MODES** | 单一桌面视觉控制台 | **已交付** | P3-视觉 | runtime 仍含 drive/cruise/stage 预算；**车机 UI 固定 stage showcase**（`setMode` API only）。 |
| **CAR-STAGE-MAX** | Showcase 拉满（非默认测试克制） | **已交付** | P3-视觉 | emily、coverRes **2.2**、ultra、FX 全开；smoke 曾 PASS。P0 后曲名/safe-bottom/APEX 再收敛，待重装验收。 |
| **CAR-MENC-INJECT** | 明文 `public/` 资源 | **已交付** | P0-壳 / P2-HMI | `car-hmi.css` + runtime 按 APK `MENC+IV+AES-256-CBC` 注入 `assets/mineradio/`；构建契约测加解密回环与幂等。 |
| **CAR-SPICA-STORAGE** | 用户数据目录 / 设置 JSON | **部分** | P4-媒体 | `patch-spica-storage.js` 将路径改到 `Music/SPICaMusic/`（MediaProvider 允许）；verify/smoke **无**顶层 SPICa 拒绝。真车读写闭环与本地库扫描仍待插入介质后单独验收，不得宣称全兼容。 |
| **CAR-USB-LOCAL** | 本地文件拖放 / 本地库 | **待验收** | P4-媒体 | 需插入含音乐的 U 盘后单独验收；与 SPICa 路径问题叠加。 |
| **CAR-AUDIO-FOCUS** | 系统音频会话 / 后台 | **部分** | P4-媒体 | Web `setAudioDuck` + media3→`CarAudioFocusBridge`→`evaluateJavascript`（`d9e82a0`）已注入；**真导航打断/蓝牙通道/熄屏恢复**仍待实车验收，不得宣称全通过。 |
| **CAR-OEM-BUS** | （无 Windows 对等） | **非目标** | NG | **不**接 OEM 车速/档位总线；无自动驻车切 stage。 |
| **CAR-SIGN-OVERLAY** | 代码签名发布 | **已交付**（流程） | P0-壳 | 覆盖安装必须与车机既有 `com.mineradio.app` 同证书；`.signing/` / `out/` / `verification/` Git 忽略。 |

---

## 2. WIN-* 上游 Windows 2.0.3 主能力分组

### WIN-SHELL — 壳与窗口

| ID | Windows 能力 | Car 状态 | Phase | Notes |
| --- | --- | --- | --- | --- |
| **WIN-SHELL-WINDOW** | Electron 主窗、全屏、多显示器 | **部分** | P0-壳 | 车机以全屏 `LandscapeWebActivity` 为基线；`--windowingMode 1` 规避华为副窗。无多显示器语义。 |
| **WIN-SHELL-INSTALLER** | `Mineradio-2.0.3-Setup.exe` NSIS、盘符安全策略 | **非目标** | NG | 车机走 Lyra APK 路径（**CAR-INSTALL-LYRA**）。 |
| **WIN-SHELL-UPDATE** | GitHub Release 检测 + 网盘线路打开 | **部分** | P5-平台 | APK 内若保留更新 UI，行为以 1.1.7.0 上游为准；车机适配**不**承诺桌面式安装包热更。 |
| **WIN-SHELL-TRAY** | 托盘 / 单实例聚焦 | **非目标** | NG | 车机无系统托盘模型。 |

### WIN-PLAY — 播放与队列

| ID | Windows 能力 | Car 状态 | Phase | Notes |
| --- | --- | --- | --- | --- |
| **WIN-PLAY-CORE** | 播放/暂停、上一首/下一首、队列 | **部分** | P2-HMI / P4-媒体 | HMI 底栏优先主播控；逻辑继承 APK 1.1.7.0。真车触控与连续播放待系统验收。 |
| **WIN-PLAY-GRAPH** | 音频图、淡入淡出、异常恢复 | **部分** | P4-媒体 | 不改原生音频链路；能力 = APK 内置，非 Electron 2.0.3 全量回移植。 |
| **WIN-PLAY-CUEFIELD** | Cuefield 混音 / DJ 时间线 | **部分** | P5-平台 | 以 APK 是否内置为准；车机壳不新增混音 UI。 |
| **WIN-PLAY-PODCAST-DJ** | 长播客 / DJ 视觉与分析 | **部分** | P3-视觉 / P5-平台 | 舞台模式可拉高视觉预算；分析管线不单独承诺对齐 2.0.3。 |

### WIN-HOME — 首页与发现

| ID | Windows 能力 | Car 状态 | Phase | Notes |
| --- | --- | --- | --- | --- |
| **WIN-HOME-DASH** | 每日推荐、继续听、画像、歌单入口 | **部分** | P2-HMI | HMI 放大首页卡片/搜索/最近播放；驾驶态关漂浮动画。内容源 = APK。 |
| **WIN-HOME-SEARCH** | 搜索与分页 | **部分** | P2-HMI / P5-平台 | 壳层放大搜索触控与字号；平台能力随 APK。 |
| **WIN-HOME-WEATHER** | 天气电台 | **部分** | P5-平台 | 未做车机专项适配；存在即继承 APK。 |

### WIN-LYRIC — 歌词舞台（应用内）

| ID | Windows 能力 | Car 状态 | Phase | Notes |
| --- | --- | --- | --- | --- |
| **WIN-LYRIC-STAGE** | 应用内歌词舞台、发光、节拍 | **部分** | P3-视觉 | drive 压低；cruise/stage 提升可读与舞台感（**CAR-STAGE-MAX**）。 |
| **WIN-LYRIC-CUSTOM** | 自定义歌词、字体、位置、遮罩 | **部分** | P5-平台 | APK 控制台入口保留；drive 降低存在感。设置落盘受 **CAR-SPICA-STORAGE** 影响。 |
| **WIN-LYRIC-DESKTOP** | **桌面歌词**（置顶窗、穿透、电影震动） | **非目标** | NG | 明确 **永不启用** 主路径；runtime 在 cruise/stage 侧主动关掉 `desktopLyrics` 类开关。见 §3。 |

### WIN-VISUAL — 粒子 / 预设 / 3D 架

| ID | Windows 能力 | Car 状态 | Phase | Notes |
| --- | --- | --- | --- | --- |
| **WIN-VISUAL-EMILY** | emily 预设、封面粒子、默认测试存档 | **部分** | P3-视觉 | stage：`setPreset(0)` + coverRes 1.55 等对齐上游惊艳路径（`ab08c20`）。drive 不拉满。 |
| **WIN-VISUAL-CINEMA** | 电影镜头 / cineshake / bloom | **部分** | P3-视觉 | 按模式预算；stage 拉高，drive 关闭或极弱。 |
| **WIN-VISUAL-SHELF** | 3D 歌单架（舞台/侧栏/常驻） | **部分** | P3-视觉 | drive 倾向 `off`；stage `stage`+`always`。真车触控与遮挡待验收。 |
| **WIN-VISUAL-FX-CONSOLE** | 完整视觉控制台 / 用户存档槽 | **部分** | P3-视觉 / P5-平台 | 入口保留；驾驶态弱化。存档路径受 SPICa 阻塞影响。 |
| **WIN-VISUAL-QUALITY** | 画质 low/mid/high/ultra、后台策略 | **部分** | P3-视觉 | stage 调 `ultra`；drive 倾向 `low`。 |
| **WIN-VISUAL-GESTURE-CAM** | 自由相机 / 手势相机 | **非目标** | NG | 触控安全：不主动开启。 |

### WIN-DESKTOP — 桌面子系统（Electron 专属）

| ID | Windows 能力 | Car 状态 | Phase | Notes |
| --- | --- | --- | --- | --- |
| **WIN-DESKTOP-FULL** | **完整桌面模式**（图标层、壁纸宿主、桌面交互） | **非目标** | NG | 车机不是 Windows 桌面壳。见 §3。 |
| **WIN-DESKTOP-WE** | **Wallpaper Engine** 库/场景/音频会话 | **非目标** | NG | 永不作为车机交付路径。见 §3。 |
| **WIN-DESKTOP-ICONS** | 桌面图标形状 / 原生图标层 | **非目标** | NG | Electron-only。 |
| **WIN-DESKTOP-WALLPAPER-MODE** | 壁纸模式 runtime | **非目标** | NG | 与 WE / 全桌面同束排除。 |

### WIN-ACCOUNT — 账号与平台源

| ID | Windows 能力 | Car 状态 | Phase | Notes |
| --- | --- | --- | --- | --- |
| **WIN-ACCOUNT-NETEASE** | 网易云登录 / 歌单 / 播客 | **部分** | P5-平台 | 壳层扫码入口；权益与 Cookie 以 APK 为准，车机适配不绕过会员。 |
| **WIN-ACCOUNT-QQ** | QQ 音乐登录与音源 | **部分** | P5-平台 | 继承 APK 1.1.7.0，非 2.0.3 全量功能回移植声明。 |
| **WIN-ACCOUNT-QISHUI** | 汽水本地会话 / 官方合并 | **部分** | P5-平台 | 桌面侧 2.0.x 能力更完整；车机以 APK 实际为准。 |
| **WIN-ACCOUNT-SPOTIFY** | Spotify 相关接入 | **部分** | P5-平台 | 同上。 |

### WIN-PERF — 性能与低配

| ID | Windows 能力 | Car 状态 | Phase | Notes |
| --- | --- | --- | --- | --- |
| **WIN-PERF-BUDGET** | 低占用、后台暂停、画质探针 | **部分** | P3-视觉 | 车机用 drive 预算 + `prefers-reduced-motion` 进一步压粒子；非完整桌面性能学说移植。 |

---

## 3. 明确非目标（NG）

以下能力**不在**车机 1.1.7 适配对齐范围内；文档、验收与对外表述均不得写成「计划对齐中」：

| 非目标 | 原因 |
| --- | --- |
| **Wallpaper Engine（WE）** | Windows 专属宿主与 DWM/场景管线；车机 WebView 无对等模型。 |
| **完整桌面模式（full desktop）** | 依赖 Electron 桌面图标层、壁纸模式与系统桌面交互。 |
| **桌面歌词（desktop lyrics）** | 依赖置顶透明窗与点击穿透；车机仅保留**应用内**歌词舞台。 |
| **OEM 车速/档位总线** | 无合法 Car API 接入承诺；模式切换为用户显式操作。 |
| **把 Electron 2.0.3 源码直接编成 Android** | 本目录只重打包/注入既有 APK。 |
| **绕过签名 / 清数据规避证书不匹配** | 默认禁止；破坏性重装必须双开关显式确认。 |

runtime 侧已体现：不强制系统壁纸路径、cruise/stage 关闭桌面歌词开关、视觉文档写明永不强制桌面歌词 / WE / 手势相机。

---

## 4. 关键提交与文档锚点

| 锚点 | 说明 |
| --- | --- |
| `90d6884` | `fix(android-car): match HMI overlay to density-scaled WebView` — **CAR-HMI-DENSITY** |
| `ff450e6` | `feat(android-car): add drive/cruise/stage visual mode runtime` — **CAR-VISUAL-MODES** |
| `ab08c20` | `feat(android-car): maximize stage mode via upstream APK visual APIs` — **CAR-STAGE-MAX** |
| `0ead07c` | Huawei car installer（Lyra）— **CAR-INSTALL-LYRA** |
| `6293fd5` | 横屏适配基线 — **CAR-LANDSCAPE** |
| [VISUAL-LAYER.zh-CN.md](./VISUAL-LAYER.zh-CN.md) | 三模式设计与底层逻辑 |
| [README.zh-CN.md](../README.zh-CN.md) | 安装、构建、SPICa 阻塞说明 |

---

## 5. 状态速览（冻结快照）

| 类别 | 已交付 | 部分 | 阻塞 | 待验收 | 非目标 |
| --- | --- | --- | --- | --- | --- |
| CAR-* 适配层 | 横屏、Lyra、密度 HMI、视觉 runtime、stage API、MENC、签名流程 | 登录入口、部分媒体 | **SPICa 存储** | USB 本地库、音频焦点/休眠 | OEM 总线 |
| WIN-* 播放/首页/歌词舞台/粒子 | — | 继承 APK + 壳层增强 | 设置落盘 | 真车连续播放与触控 | — |
| WIN-* 桌面子系统 | — | — | — | — | **WE / 全桌面 / 桌面歌词** |

**一句话**：车机 1.1.7 对齐的是「横屏可装可启 + 密度正确的音乐类 HMI + 可选舞台惊艳」，**不是** Windows 2.0.3 桌面子系统的完整复刻；**SPICa 存储仍阻塞**本地设置路径，**WE / 全桌面 / 桌面歌词为永久非目标**。
