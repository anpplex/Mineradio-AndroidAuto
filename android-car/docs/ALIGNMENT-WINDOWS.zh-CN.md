# Windows Mineradio ↔ 车机功能对齐（边界内）

> **效力：** 在 [BOUNDARIES.zh-CN.md](./BOUNDARIES.zh-CN.md) 约束下，把 **Windows 2.0.3 用户能力** 映射到 **APK 1.1.7.0 + android-car 壳**。  
> **不是** Electron 交叉编译；**不是** OEM 认证；**不是** 把 NG 桌面子系统搬上车机。

| 基线 | 值 |
| --- | --- |
| Windows | 上游 `XxHuberrr/Mineradio` **v2.0.3**（只读对照；禁止 push `upstream`） |
| 车机 | APK **1.1.7.0** 重打包 + `android-car/` 补丁 |
| 分支 | `origin/huawei-android12-car` only（B0） |
| 形态 | WebView 壳 + MENC 注入 + 有限 smali（SPICa / AudioFocus） |

---

## 1. 对齐原则（硬边界）

| # | 原则 | 出处 |
| --- | --- | --- |
| 1 | 能对齐的 = **APK 已有 API/UI** + 车机壳可达 + 安全触控 | B-TECH-01 |
| 2 | **永不** WE / 全桌面 / 桌面歌词 / 托盘 / 手势相机主路径 | B-PRD-05 |
| 3 | **不**绕过登录、伪造会员、破解音质 | B-PRD-02/03 |
| 4 | 惊艳默认 **stage showcase**（产品决策）；drive/cruise 预算 API 保留 | VISUAL-LAYER §3 |
| 5 | 驾驶安全：底栏少控件、大热区、safe inset；低频进二级 | B-TECH-02、HMI |
| 6 | 状态诚实：未真车验收写 **部分/待验收**，不写已兼容 | FEATURE-MATRIX |

---

## 2. 能力映射总表

| Windows 能力 | 车机策略 | 状态 | 车机入口 / 实现 |
| --- | --- | --- | --- |
| 播放/暂停/上下曲/队列 | 对齐 | **部分** | 底栏 `#play-btn` 等；`#mini-queue-btn` |
| 进度条 seek | 继承 APK | **部分** | `#progress-bar` |
| 搜索 | 对齐壳 | **部分** | `#car-search-entry` → `#search-input` |
| 首页推荐/最近/本地/歌单 | 继承 + 大卡片 | **部分** | `#empty-home` 卡片 |
| 网易云/QQ 等登录 | 入口壳 + 插件 | **部分** | 空首页扫码；插件管理（空首页 FAB） |
| 应用内歌词舞台 | 对齐 stage | **部分** | 粒子歌词探针 + 底栏「词」 |
| 歌词样式/自定义 | 控制台 | **部分** | FX 抽屉 `#fx-lyric-fold` |
| **桌面歌词** | **禁止** | **非目标** | runtime `desktopLyrics=false` |
| emily / 默认测试 / 密粒子 | stage 拉满 | **部分** | `setPreset(0)`、coverRes 2.2、默认测试存档 best-effort |
| 电影镜头 / bloom / 架 | stage 预算 | **部分** | `toggleFx` / `setShelfMode('stage')` |
| 视觉控制台 / 预设 / 存档 | 对齐可达 | **部分** | 底中胶囊 → `#fx-panel` 底抽屉 |
| 音质 / EQ / 音量 / 喜欢 / 收藏 / 循环 | 二级对齐 | **部分** | FX 内「播控·更多」代理 |
| 画质 ultra | stage | **部分** | data-rq + API 探测 |
| **Wallpaper Engine / 全桌面** | **禁止** | **非目标** | — |
| 托盘 / 多显示器 / NSIS | 车机替代 | **非目标**/已交付 | Lyra 安装、全屏 Activity |
| 音频会话 / 导航 duck | 车机增强 | **部分** | `setAudioDuck` + native bridge |
| 设置落盘 | 路径修复 | **部分** | `Music/SPICaMusic`；真车读写待验 |
| U 盘本地库 | 继承 | **待验收** | 需介质 |
| OEM 车速总线 | — | **非目标** | — |

---

## 3. 非目标（禁止「对齐中」表述）

- Wallpaper Engine  
- 完整桌面模式 / 桌面图标层  
- 桌面歌词独立窗  
- Electron 托盘与单实例  
- Electron 源码直接编 Android  
- 破解会员 / 绕过登录  

---

## 4. 车机已落地的「Windows 主路径」壳

| 区域 | Windows 对应 | 车机实现 |
| --- | --- | --- |
| 播放 | 底栏播控 | 封面+曲名+上播下+队列+词+时间 |
| 搜 | 顶栏搜索 | TL 搜索钮，非常驻条 |
| 视觉 | 右下/侧栏控制台 | 底中「视觉控制台」+ 底抽屉 |
| 次要播控 | 底栏次要图标 | FX「播控·更多」 |
| 账号 | 用户胶囊 | 空首页登录；播放页藏 APEX |
| 安装扩展 | 插件 | 空首页 `#plugin-fab` |

---

## 5. 仍差一截（边界内 backlog）

| 优先级 | 项 | 说明 |
| --- | --- | --- |
| P1 | 真车验收播放/登录/SPICa/AF | 不宣称全兼容 |
| P1 | FX 抽屉内 Windows 控制台密度 | 大字大钮（已部分） |
| P2 | 弱动效 ↔ drive 预算 | 可选入口（实现见 runtime「弱动效/舞台」） |
| P2 | 多源搜索 tab 在 focus 时车机化 | 已有 focus-within 规则 |
| NG | WE / 桌面歌词 | 永不做 |

---

## 6. 验收（对齐「功能」而非截图像不像）

- [ ] 能搜、能播、能切队列、能看应用内歌词  
- [ ] 能开视觉控制台并换预设 / 调参  
- [ ] 能从 FX 更多进音质/EQ/音量/喜欢  
- [ ] 冷启动默认舞台 showcase（无模式条）  
- [ ] 日志无桌面歌词/WE 强开  
- [ ] 无 SPICa 顶级目录拒绝（Music/SPICaMusic）  
- [ ] **不**出现 WE/桌面歌词主路径  

---

## 7. 文档与代码锚点

| 文件 | 职责 |
| --- | --- |
| [FEATURE-MATRIX.zh-CN.md](./FEATURE-MATRIX.zh-CN.md) | 能力状态表 |
| [VISUAL-LAYER.zh-CN.md](./VISUAL-LAYER.zh-CN.md) | 视觉与 HMI IA |
| [BOUNDARIES.zh-CN.md](./BOUNDARIES.zh-CN.md) | 硬边界 |
| `scripts/car-visual-runtime.js` | stage 探针 / duck / 搜索 / FX 更多 |
| `scripts/patch-car-hmi-assets.js` | 车机 CSS 壳 |

更新本文件时同步改 FEATURE-MATRIX 状态列，避免口头漂移。
