# 舞台模式最大化差距审计（只读）

> 范围：仅 **STAGE 模式最大化 / APK 能力填空**。  
> 对照三源：
>
> 1. **上游 Windows Mineradio 2.0.3**（`public/js/modules/**`、`README.md`、`public/default-user-fx-archive.json`「默认测试」）
> 2. **车机当前实现**（`android-car/scripts/car-visual-runtime.js`、`patch-car-hmi-assets.js` 内 `CAR_HMI_STYLESHEET`、`docs/VISUAL-LAYER.zh-CN.md`）
> 3. **APK 1.1.7.0 能力**（`android-car/work/index.html.dec` 解密壳 + 已注入 overlay 契约）
>
> 状态：P0 已在 runtime/HMI 实现（见 `car-visual-runtime.js` / `patch-car-hmi-assets.js`）。日期：2026-07-31 起持续更新。

---

## 0. 基线摘要

| 维度 | 上游 2.0.3「默认测试 / emily」 | 车机 stage 预算（现状） | APK 1.1.7.0 |
| --- | --- | --- | --- |
| 预设 | `preset: 0` emily专辑封面 | `setPreset(0)` + 重试 | `#preset-grid` / 全局 `setPreset`（onclick 契约） |
| 封面粒子分辨率 | `coverResolution: 1.55` | `fx-coverres → 1.55` | 滑条 `min=0.75 max=1.55` 存在 |
| 电影镜头 | `cinema: true`，`cinemaShake: 0.5` | on + `0.55` | `#t-cinema` / `fx-cineshake` |
| 歌词溢光 | on，`lyricGlowStrength: 0.28`，鼓点 on，光粒 **off** | on + `0.42`，鼓点/光粒 **on**，镜头绑定 **on** | 对应 toggle + 滑条齐全 |
| bloom / edge / floatLayer | **均为 false** | **强制 on**（showcase 拉满） | toggle 齐全 |
| 粒子主参数 | intensity 0.85 / depth **0.2** / point **1** / speed **1** / twist **0** / scatter **0** / color **1.1** / bgFade 0.2 / bgOpacity **1** | intensity 0.92 / depth **0.72** / point **0.78** / speed **0.68** / twist **0.45** / scatter **0.48** / **color 未写** / bgfade 0.28 / bgopacity **0.28** | 滑条 ID 与上游一致（`fx-*`） |
| 3D 架 | `shelf: side`，presence 语义偏 `auto` | `shelf: stage` + `always` | `#shelf-seg` off/side/stage；presence **仅 always/hover**（无 auto） |
| 画质 | `performanceQuality: eco`（`setPerformanceQualityMode` + `data-performance-quality`） | 调用 **`setRenderQuality('ultra')`**，fallback `#render-quality-seg [data-rq=ultra]` | **仅有** `data-rq=light\|low\|medium\|high\|fine\|ultra`，**无** `setRenderQuality` 名、**无** eco/balanced API |
| 歌词舞台 | `particleLyrics: true` + cinema 显示模式等 | **未探测** particle lyrics；底栏「词」按钮被 HMI **隐藏** | `toggleLyricsPanel` / 粒子歌词链路在壳层存在；样式为 `setLyricStyle(0..3)` |
| 星河 / 竖向浮动 | 默认 on（2.0.3 有 toggle） | 未调用 | **HTML 无** `t-backgroundStarRiver` / `t-lyricVerticalFloat` |
| 桌面歌词 / WE / 手势相机 | 桌面专属 | 显式关闭（正确） | toggle 存在但应保持 off |
| 持久化 | 本地用户目录 / 存档 | `localStorage['mineradio.car.visualMode']` | 日志显示 `SPICaMusic/mineradio_settings.json` 在 Android 12 被 MediaProvider 拒绝 → **APK 本体设置落盘可能失败** |

**已做对的部分（不进差距列表，仅作边界）：**

- stage 三模式状态机、CSS 全开 canvas、玻璃底栏/歌词 drop-shadow、模式切换 UI。
- `STAGE_RETRY_MS` + 6s 再断言，覆盖 splash 晚绑定。
- 调用链方向正确：`setPreset` / `toggleFx` / `setShelfMode` / 滑条 `input+change` / quality DOM fallback。
- 明确不启桌面歌词、WE、手势相机。

---

## P0 — 不修则「舞台」名不副实或探针失效

> **实现状态（2026-07-31）：** P0-1…P0-5 已合入 `car-visual-runtime.js`（data-rq 优先、writeFxBudget、setParticleLyricsSilently、shelf 重断言、visibility/play 再拉满）+ stage 下恢复歌词按钮 CSS；SPICa 路径已由 `patch-spica-storage.js` 处理。下列条文保留为设计说明与回归验收标准。

### P0-1. 画质 API 名与档位契约错位（`setRenderQuality` 在 APK 中不存在）

| 项 | 内容 |
| --- | --- |
| 现象 | runtime 优先 `global.setRenderQuality('ultra')`。上游 2.0.3 真实 API 是 `setPerformanceQualityMode` + `eco\|balanced\|high\|ultra`；APK 1.1.7.0 是 `#render-quality-seg button[data-rq=...]`（light/low/medium/high/fine/ultra），HTML 按钮无 inline onclick，依赖 bundle 绑定。 |
| 风险 | 全局函数路径恒失败；仅靠 `click()`。若绑定未完成或点击未同步 `fx`/`renderer`，舞台仍停在默认「中档」。 |
| 改动 | **`android-car/scripts/car-visual-runtime.js` → `applyQuality(quality)`** |
| 具体 | 1) 先写 `global.fx.performanceQuality` / `global.fx.renderQuality` / `global.fx.rq`（按 `typeof` 探测实际字段）；2) 优先 click `#render-quality-seg button[data-rq="${quality}"]`（APK）；3) 再试 `setPerformanceQualityMode`（若未来壳升级）；4) 再试误名 `setRenderQuality`；5) 调用 `applyRendererPowerMode` / `updatePerformanceControls` / `updateFxInputs`（若存在）。 |
| 验收 | stage 后 `#render-quality-seg [data-rq=ultra].active` 且 WebGL DPR/预算上升（或至少 button active 稳定）。 |

### P0-2. 粒子歌词未强制开启 + 底栏歌词开关被 HMI 隐藏

| 项 | 内容 |
| --- | --- |
| 现象 | 上游舞台核心是 **粒子歌词**（`particleLyrics: true`，`toggleLyricsPanel` / `setParticleLyricsSilently`）。stage runtime **不调用**任一 API。车机 CSS 隐藏 `#bottom-bar .lyrics-toggle-btn`，用户无法从主路径重开「词」。 |
| 风险 | 无歌词时 stage 只剩粒子底 + 播控，对齐「歌词舞台」失败。 |
| 改动 | **`car-visual-runtime.js` → `applyFxProbes`（stage 分支）**；可选 **`patch-car-hmi-assets.js` `CAR_HMI_STYLESHEET`** stage 下显示歌词按钮或提供替代入口。 |
| 具体 | stage：`callGlobal('setParticleLyricsSilently', [true])` 或 `toggleLyricsPanel(true)`；读 `global.fx.particleLyrics` / `lyricsVisible` 校验；失败则模拟点击 `.lyrics-toggle-btn`（若仍隐藏则 CSS 在 stage 恢复可见）。 |
| 验收 | 有歌词曲目播放时 stage 可见当前行；关闭歌词后再切 stage 会重新打开。 |

### P0-3. 探针只打 DOM，未直写 `fx` + `syncFxUniforms`（绑定竞态）

| 项 | 内容 |
| --- | --- |
| 现象 | 滑条靠 `dispatchEvent(input/change)`；toggle 靠 `toggleFx` 翻转。splash/初始化前 listener 未挂时事件空转；`toggleFx` 在 `readFxFlag==null` 时可能多翻一次。 |
| 风险 | 重试窗口内仍可能落到半套参数（尤其 coverRes 未触发 `applyCoverParticleResolution`）。 |
| 改动 | **`car-visual-runtime.js`**：新增 `writeFxBudget(budget)`，在 `applySliders` / `ensureFxKey` 之后调用。 |
| 具体 | 若 `global.fx` 存在：映射 `intensity`、`cinemaShake←cineshake`、`bloomStrength←bloom`、`coverResolution←coverRes`、`depth`、`lyricGlowStrength←lyricGlow`、`point/speed/twist/scatter/bgFade/backgroundOpacity/color` 等；布尔键直接赋值而非 flip。随后：`applyCoverParticleResolution(fx.coverResolution,{reload:true})`（存在时）、`syncFxUniforms()`、`updateFxInputs()`、`createFloatLayer`/`destroyFloatLayer` 按 `floatLayer`。DOM 探针保留作 UI 同步。 |
| 验收 | 在 0ms 与 8s 重试后 `fx.coverResolution===1.55` 且 `fx.cinema===true` 可脚本读出。 |

### P0-4. `setShelfMode('stage')` / presence 在架管理器未就绪时无效

| 项 | 内容 |
| --- | --- |
| 现象 | `applyShelf` 调 `setShelfMode` / `setShelfPresence` 或 click seg。APK presence UI 为 **always/hover**；上游 2.0.3 `normalizeShelfPresence` 只认 **always/auto**。若 `shelfManager` 晚于第一次探针创建，mode 可能仍停在 HTML 默认 `off`。 |
| 风险 | 无 3D 舞台架 → 与 hint「3D 架」不符。 |
| 改动 | **`car-visual-runtime.js` → `applyShelf` + `scheduleStageMaximize`** |
| 具体 | 重试条件增加：`#shelf-seg [data-shelf=stage].active` 或 `fx.shelf==='stage'`；失败则再 `setShelfMode('stage')` + `setShelfPresence('always')` + click always；`exitImmersiveIfBlockingShelf` 保留。不要写 APK 没有的 `auto`。 |
| 验收 | stage 后 `search-area`/`bottom-bar` 带 `stage-mode` class（APK `setShelfMode` 副作用）。 |

### P0-5. SPICaMusic 设置落盘失败 → save 后回读可能冲掉 stage

| 项 | 内容 |
| --- | --- |
| 现象 | 实车日志：`FileNotFoundException: .../SPICaMusic/mineradio_settings.json`。runtime 在探针末尾调用 `saveFxState` / `saveLyricLayout`。若 APK 从失败路径回退到默认/残缺快照，重进或切歌可能丢掉 ultra/emily/toggles。车机模式本身在 `localStorage` 可存，但 **FX 本体**不在 car key 下。 |
| 风险 | 「切到舞台看起来对了，过一会儿又回去了」。 |
| 改动 | **`car-visual-runtime.js` → `persistFxIfPossible` / `scheduleStageMaximize`**；（中期）原生路径不在本审计实现范围，仅标注。 |
| 具体 | 1) stage 下 `save*` 改为 best-effort，失败不阻断；2) 监听 `mineradio:car-visual-mode` 外，增加 **visibility/pageshow/播放开始** 时若 mode===stage 再 `applyFxProbes`；3) 文档注明完整 FX 持久化依赖 APK 存储修复（app-specific 目录），**非** overlay 可单独保证。 |
| 验收 | 杀进程重进：car mode 仍为 stage，且 8s 内 FX 再次被拉满。 |

---

## P1 — 与「默认测试 / 惊艳」观感差一截

### P1-1. stage 预算与「默认测试」主粒子曲线偏离（过猛 + 过弱混杂）

| 项 | 内容 |
| --- | --- |
| **产品决策（2026-07-31）** | **Showcase 拉满** — 明确不要求对齐「默认测试」克制曲线；舞台以惊艳为第一目标。 |
| 实现 | `MODE_BUDGET.stage`：`intensity/point/speed=1`，`cineshake 0.85`，`bloom 0.95`，`coverRes **2.2**`，`depth 0.9`，`twist/scatter` 高开，float/cinema/溢光/bloom/edge **全开**，`quality: ultra`，`showcase: true`。 |
| 验收 | 点「舞台」后粒子/镜头/架/歌词存在感明显高于巡航；cover 网格走车机密级 clamp。 |

### P1-2. 未应用歌词「流光」样式 / 未对齐上游 cinema 歌词模式

| 项 | 内容 |
| --- | --- |
| 现象 | 上游默认 `lyricDisplayMode: 'cinema'` 等（2.0.3 体系）。APK 1.1.7.0 为 `setLyricStyle(0..3)`（逐句填充/流光溢彩/整排/逐字），stage **未调用**。 |
| 改动 | **`car-visual-runtime.js` → `applyFxProbes`** |
| 具体 | stage：`callGlobal('setLyricStyle', [1])` 或 click `#lsb1`（流光溢彩）；若存在 `setLyricDisplayMode('cinema')` 再双写。 |
| 验收 | 播放中歌词为流光/高存在感样式，非默认逐句干读。 |

### P1-3. 未加载「默认测试」用户存档快照（整包对齐捷径）

| 项 | 内容 |
| --- | --- |
| 现象 | 上游一键体验来自 `applyUserFxArchive` / `applyFxArchiveSnapshot` + 预置「默认测试」。stage 手写散装预算，易漏字段（color、lyric palette、shelf 细节等）。 |
| 改动 | **`car-visual-runtime.js` → `applyStageNow` / stage `applyFxProbes` 前半** |
| 具体 | 探测 `userFxArchives` / `applyUserFxArchive(0)` / `applyFxArchiveSnapshot`；成功则以存档为 base，再叠加 car stage 差异（`shelf=stage`、`presence=always`、quality=ultra、关 desktopLyrics）。无存档则回退当前散装预算。 |
| 验收 | 有预置存档时 stage ≈ 默认测试 + 舞台架 + 极致画质。 |

### P1-4. CSS 对 `#canvas-container` 的 `opacity` 连坐整幅 WebGL（含歌词 mesh）

| 项 | 内容 |
| --- | --- |
| 现象 | `CAR_HMI_STYLESHEET` 用 `opacity: var(--car-particle-opacity)` 打在 `#canvas-container`。粒子歌词若在同一 WebGL 树，drive 压暗会连歌词一起压；stage 虽设 1，但中间态/切换闪烁仍伤体验。 |
| 改动 | **`patch-car-hmi-assets.js` → `CAR_HMI_STYLESHEET` 视觉预算段** |
| 具体 | stage 保持 opacity:1 + filter:none（已有）；评估 drive 改为只压 `.particle-background` / 非歌词层，或对 canvas 使用更低 scrim 而非整层 opacity。至少 **stage 选择器优先级**确保不被 `#canvas-container { opacity: var(...) }` 与其它规则打架（检查是否需 `!important` 双写已存在）。 |
| 验收 | stage 歌词亮度不被全局 opacity 吃掉；切 drive↔stage 无 0.35s「歌词一起淡出」错觉（或可接受则文档化）。 |

### P1-5. DIY 门闩可能挡住人工微调 / 部分控制台路径

| 项 | 内容 |
| --- | --- |
| 现象 | APK 有 DIY 模式；上游 `toggleFxPanel` 在非 DIY 时拒绝打开。runtime 不依赖开面板，但实车验收/用户微调舞台参数需要面板。 |
| 改动 | **`car-visual-runtime.js` stage 进入时** |
| 具体 | 若 `diyPlayerMode===false`，`callGlobal('toggleDiyMode')` 或 click `#diy-mode-btn` **一次**（仅 stage，离开 stage 可恢复）。 |
| 验收 | stage 下点 `#fx-fab` 能打开视觉控制台。 |

### P1-6. 缺少 stage 健康检查 / 失败可见反馈

| 项 | 内容 |
| --- | --- |
| 现象 | 探针静默失败；验收只能靠肉眼。 |
| 改动 | **`car-visual-runtime.js` → `applyFxProbes` 末尾 `reportStageHealth()`** |
| 具体 | 收集：`preset/quality/shelf/fx flags/coverRes`；`console.info('[MineradioCarVisual]', …)`；可选短 toast「舞台已最大化」/「舞台部分参数未生效」。测试：**`android-car/tests/car-hmi-assets.test.js`** 增加对 `writeFxBudget`/`setParticleLyrics`/`data-rq` 字符串契约。 |
| 验收 | remote debug 能看到 health 对象；单测锁住 P0 API 名。 |

### P1-7. `bgopacity: 0.28` 可能误伤封面/背景氛围

| 项 | 内容 |
| --- | --- |
| 现象 | 默认测试背景不透明度 1。stage 压到 0.28 易导致发灰、家页透底混乱。 |
| 改动 | 同 P1-1 预算表；**优先改 `MODE_BUDGET.stage.bgopacity` → 0.85–1.0**，靠 scrim 与粒子本身透气，而不是砸背景 alpha。 |

---

## P2 — 增强 / 性能 / 非阻塞对齐

### P2-1. ultra + coverRes 1.55 在车机 GPU 上的性能护栏

| 项 | 内容 |
| --- | --- |
| 改动 | **`car-visual-runtime.js`**：stage 可先 `fine` 再升 `ultra`；或连续掉帧时降到 `high`/`fine` 并保留视觉开关。 |
| 说明 | 文档 `LOW_SPEC` 原则与默认测试用 eco 冲突；车机 showcase 要 ultra 时需可降级。 |

### P2-2. 上游 2.0.3 有、APK 1.1.7.0 无的视觉键（不可填则文档化）

| 能力 | 上游 | APK 壳 | stage 策略 |
| --- | --- | --- | --- |
| `backgroundStarRiver` | 有 | 无 toggle | 跳过；勿瞎 `toggleFx` |
| `lyricVerticalFloat` | 有 | 无 toggle | 跳过 |
| `lyricDisplayMode cinema` 等 | 有 | 改为 `setLyricStyle` | P1-2 |
| `performanceQuality eco…` | 有 | `data-rq` 六档 | P0-1 |
| `shelfPresence auto` | 有 | UI 为 hover | 只用 always/hover |
| Desktop lyrics / WE / 全桌面 | 有 | 有害 | 保持 off（已做） |
| Sonic 音域回响网格 1000²+ | 有 | 有设置 UI | **不要**在 stage 默认拉满（车机散热） |

### P2-3. 舞台架触控遮挡与 `shelf-touch-shield`

| 项 | 内容 |
| --- | --- |
| 现象 | drive 将 `#shelf-touch-shield` pointer-events:none；stage 未显式处理。shelf=stage+always 可能挡播控。 |
| 改动 | **`CAR_HMI_STYLESHEET` stage 段**：评估 shield 区域与底栏 88px 避让；必要时缩小架命中区或提高底栏 z-index（已有播控优先原则）。 |

### P2-4. 电影镜头 / 自由相机基线

| 项 | 内容 |
| --- | --- |
| 现象 | stage 强制 cam off（正确）。`setPreset(0)` 可能改 orbit 基线；若用户曾拖镜头，表现不一致。 |
| 改动 | 可选 `setPreset(0, { preserveCamera: false })` 已默认；可在 stage 调用 `applyPresetOrbitBaseline(0)` 若暴露。 |

### P2-5. 颜色/高亮未对齐默认测试

| 项 | 内容 |
| --- | --- |
| 现象 | 默认测试 / 变更日志：`lyricHighlight #fac900`、`lyricGlow #008aff`（存档 JSON 内部分字段仍为旧值，以 CHANGELOG/fxDefaults 为准需再核对）。runtime 不调 `setLyricHighlightCustom` / glow picker。 |
| 改动 | stage 可选 click/赋值 lyric highlight & glow；低优先级。 |

### P2-6. 模式切换时序：preset 与 slider 顺序

| 项 | 内容 |
| --- | --- |
| 现状 | sliders → quality → fx flags → shelf → preset。`setPreset` 不重写滑条，顺序可接受。 |
| 建议 | 若引入 `applyFxArchiveSnapshot`（P1-3），应 **先存档再 shelf/quality 覆盖**。 |

### P2-7. 文档与测试契约过时

| 项 | 内容 |
| --- | --- |
| 改动 | 更新 **`android-car/docs/VISUAL-LAYER.zh-CN.md`**：删除「存在全局 `setRenderQuality`」的暗示，改为 APK `data-rq` + 直写 fx；补充 particle lyrics、默认测试对齐表。 |
| 测试 | **`android-car/tests/car-hmi-assets.test.js`**：断言 `data-rq`、`setParticleLyricsSilently`/`toggleLyricsPanel`、`fx-color`、不再把 `setRenderQuality` 当作唯一路径。 |

### P2-8. 驻车自动 stage / AudioFocus 压粒子

| 项 | 内容 |
| --- | --- |
| 说明 | `VISUAL-LAYER.zh-CN.md` §7 已列；无合法车速/驻车 API 前不做。非本阶段代码缺口。 |

---

## 推荐落地顺序（仅 stage 填空）

1. **P0-1 + P0-3**：画质真生效 + `fx` 直写（否则后面全是皮肤）。  
2. **P0-2**：粒子歌词强制开（舞台语义）。  
3. **P0-4 + P0-5**：架 mode 与重入再拉满。  
4. **P1-1 + P1-7**：预算对齐默认测试（再谈 showcase 超标）。  
5. **P1-2 + P1-3**：歌词样式 + 存档快照。  
6. **P1-4/5/6 + P2-***：CSS/DIY/健康检查/性能护栏。

---

## 文件 → 函数索引（实施时）

| 文件 | 函数 / 区块 | 关联 gap |
| --- | --- | --- |
| `android-car/scripts/car-visual-runtime.js` | `MODE_BUDGET.stage` | P1-1, P1-7, P2-1 |
| 同上 | `applyQuality` | P0-1 |
| 同上 | `applySliders` / 新建 `writeFxBudget` | P0-3, P1-1 |
| 同上 | `ensureFxKey` / `applyFxKeyMap` | P0-3 |
| 同上 | `applyShelf` | P0-4 |
| 同上 | `applyFxProbes` | P0-2, P1-2, P1-3, P1-5, P1-6 |
| 同上 | `persistFxIfPossible` / `scheduleStageMaximize` / `boot` | P0-5 |
| 同上 | `applyPreset` | P2-4, P2-6 |
| `android-car/scripts/patch-car-hmi-assets.js` | `CAR_HMI_STYLESHEET` stage/drive 视觉段 | P1-4, P0-2 CSS, P2-3 |
| `android-car/tests/car-hmi-assets.test.js` | runtime/CSS 契约 test | P1-6, P2-7 |
| `android-car/docs/VISUAL-LAYER.zh-CN.md` | §3–§7 | P2-7 |
| （参照只读）`public/default-user-fx-archive.json` | 「默认测试」snapshot | P1-1, P1-3 |
| （参照只读）`public/js/modules/07-fx/05-fx-panel-performance.js` | `setPerformanceQualityMode` | P0-1 对照 |
| （参照只读）`public/js/modules/07-fx/07-bindings-shelf-immersive.js` | `setShelfMode`, `toggleFx`, `setParticleLyricsSilently` | P0-2/4 |
| （参照只读）`android-car/work/index.html.dec` | `#render-quality-seg`, toggles, `setLyricStyle` | APK 能力真相源 |

---

## 明确不在本差距列表（防扩 scope）

- 行车/巡航模式重做、OEM 车速总线、音频焦点业务、U 盘扫描、登录鉴权。  
- 把 Windows 2.0.3 模块化 JS 整包塞进 APK（当前链路是 **patch 注入 runtime+CSS**，不是替换 初始化加载器）。  
- 修复 SPICaMusic 原生存储（需 smali/原生层；仅要求 stage runtime **容忍**失败并重断言）。  
- 开启桌面歌词 / Wallpaper Engine / 手势相机。

---

*审计结论：当前 stage 在 CSS 与「调用意图」上已指向最大化，但相对 APK 1.1.7.0 真相源，P0 集中在 **画质探针契约、粒子歌词、fx 直写与持久化回弹**；P1 集中在 **与「默认测试」参数和歌词样式的观感对齐**。*
