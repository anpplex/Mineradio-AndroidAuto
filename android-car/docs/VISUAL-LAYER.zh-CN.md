# 车机视觉层设计与底层逻辑

> 项目内 HMI / 视觉规范，**不是**华为 OEM 官方强制认证文本。  
> 目标硬件：Huawei `ICHU3200E15-ADV`，Android 12，1920×1080 @ **320dpi**，WebView `width=device-width` → CSS 约 **960×540**。

## 1. 设计命题

| 约束 | 诉求 |
| --- | --- |
| 华为车机 **音乐类** 可用性 | 一眼可读、一指可达、少步完成、行车少分心 |
| Mineradio 品牌 | **自由 / 开放 / 惊艳**：粒子、镜头、歌词舞台、封面氛围 |

二者冲突时，**默认站在驾驶安全一侧**；惊艳效果通过显式 **舞台模式** 最大化还原，而不是默认全开。

## 2. 三层视觉架构

```text
┌─────────────────────────────────────────────┐
│  Shell HMI（车机壳）                           │
│  搜索 / 首页卡片 / 底栏主播控 / 登录入口         │
│  大热区 · 中文层级 · 密度感知 CSS px            │
├─────────────────────────────────────────────┤
│  Visual Mode Runtime（本层新增）               │
│  drive | cruise | stage                      │
│  预算：粒子透明度、遮罩、电影震动、画质探针…      │
├─────────────────────────────────────────────┤
│  Mineradio Stage（APK 继承）                  │
│  Three.js 粒子 · 歌词舞台 · FX 控制台 · 预设    │
└─────────────────────────────────────────────┘
```

## 3. 模式定义（底层逻辑）

| 模式 | 默认 | 音乐类规范 | Mineradio 还原 |
| --- | --- | --- | --- |
| **drive 行车** | **是** | 弱动效、强对比、主播控优先、3D 架倾向关闭 | 保留品牌主色与底栏玻璃，粒子极低 |
| **cruise 巡航** | 否 | 氛围与可读平衡 | 中等粒子、轻电影感、歌词舞台可读 |
| **stage 舞台** | 否（用户点选） | 驻车/等人场景 | **Showcase 拉满**（产品决策）：emily + 密粒子 coverRes2.2 + ultra + 电影/溢光/bloom/edge/float 全开 + 3D 架舞台常驻；**不对齐**「默认测试」克制曲线 |

运行时：

- `document.documentElement[data-car-visual-mode]`
- CSS 变量：`--car-particle-opacity`、`--car-stage-scrim`、`--car-lyric-scale-boost`
- **舞台最大化**直接调用 APK 全局 API（补齐现有包能力，而非只改 CSS）：
  - `setPreset(0)` → emily专辑封面（上游默认惊艳路径）
  - `setRenderQuality('ultra')`
  - `setShelfMode('stage')` + `setShelfPresence('always')`
  - `toggleFx` 确保：`floatLayer` / `cinema` / `lyricGlow` / `lyricGlowBeat` / `lyricGlowParticles` / `lyricCameraLock` / `bloom` / `edge` = on
  - 滑条预算（showcase）：intensity/point/speed=1、cineshake≈0.85、bloom≈0.95、coverRes=**2.2**、depth≈0.9
  - **清晰度顺序**：`setPreset(0)` → quality ultra → `applyCoverParticleResolution(2.2,{reload:true})`
  - WebGL 画布 **禁止** 用 CSS `opacity<1` 降粒子（Android WebView 合成发糊）；行车用 scrim 遮罩代替
  - 多次延迟重试（0–8s）等待 splash 后壳层就绪
- 持久化：`localStorage['mineradio.car.visualMode']`
- API：`MineradioCarVisual.setMode('stage')` / `applyStageNow()`

**不**读取 OEM 车速/档位总线；**永不**强制桌面歌词 / WE / 手势相机。

## 4. 与上游 Windows 视觉的对应

| Windows（2.0.3） | 车机策略 |
| --- | --- |
| 粒子 / Emily / 电影镜头 | stage 拉满预算；drive 压到装饰级 |
| 3D 歌单架 | drive 尝试关闭；stage 允许舞台/常驻 |
| 桌面歌词 / WE / 全桌面 | **永不启用** |
| FX 控制台 | 保留入口；drive 降低存在感 |
| 自由相机 / 手势 | 不主动开启（触控安全） |

## 5. 实现文件

| 文件 | 职责 |
| --- | --- |
| `scripts/car-visual-runtime.js` | 模式状态机、UI 切换、FX 探针 |
| `scripts/patch-car-hmi-assets.js` | MENC 注入 CSS + runtime + 登录入口 |
| `tests/car-hmi-assets.test.js` | 注入幂等、模式 token、runtime 契约 |

构建链不变：`apktool d` → patch → `apktool b` → `apksigner`。

## 6. 验收清单（视觉）

- [ ] 冷启动默认为 **行车**，左下角可见 行车/巡航/舞台  
- [ ] 行车：粒子明显变暗，底栏仍只保留主播控  
- [ ] 舞台：粒子与歌词舞台存在感上升，仍不遮挡播控热区  
- [ ] 刷新后模式保持  
- [ ] 系统「减少动态效果」时粒子进一步压低  
- [ ] 不出现桌面歌词窗 / WE 相关强提示主路径  

## 7. 后续可增强（未做）

- 驻车信号（若未来有合法 Car API）自动建议切 stage  
- 与 AudioFocus 联动：导航语音时短暂压粒子  
- 将 Windows 2.0 模块化视觉预算表导入 runtime  
