# 汽水音乐 AMLL 插件 → Pineapple Music 歌词页 移植说明

> 来源：汽水音乐 AMLL 插件 `soda-amll-lyrics`（`src/inject.js` 2896 行）
> 版本：插件 README 标注 v2.0（release 目录到 1.2.0），`src/inject.js` 2896 行 + `src/automix.js` 461 行
> 目标：`src/renderer/src/components/FullscreenPlayer.tsx` 及其周边（overlayLayer 内的歌词页）
> 日期：2026-10-25

---

## 0. 一句话结论

**设置面早就对齐了，缺的是「歌词页里的交互层」。**

插件 32 个设置项在 v1.2.0 的 `AppSettings` 里已全部存在（含 `bgPerf` / `adaptiveQuality` / `bar*` / `wordBright`），
而且早前的实现已经照着它做了舞台版式、关闭条拖拽、Q 弹按压、无歌词折叠。真正缺的是：

| 缺口 | 插件位置 | 本轮 |
| --- | --- | --- |
| 歌词页右键菜单 | `openMenu()` / `runMenuAction()` | 新 `LyricsMenu.tsx` |
| 歌词行右键（复制该行） | `bindLyricEvents()` / `openLineMenu()` | 同上，`kind: 'line'` |
| 页内设置窗（8 页 + 关于） | `openSettings()` / `settingsSchema()` | 新 `LyricsSettingsDialog.tsx` |
| 更多按钮 = 同一张菜单 | `bindMore()` | `fsMore` 改为开菜单 |
| 音量图标点击静音 | `bindControls()` + `paintVolume()` | 全屏页音量图标改为按钮 |
| 自适应四档阶梯 | `sampleFrameRate()` / `aqFactors()` | 重写 `FullscreenPlayer` 的测量逻辑 |
| `Ctrl+Alt+L` | bootstrap keydown | `App.tsx` 增加别名 |
| 苹方按字重映射 | `FONT_CSS` | `base.css` 加 `SA PingFang` @font-face |

---

## 1. 功能映射表

### 1.1 歌词与舞台

| 插件 | 本应用 | 状态 |
| --- | --- | --- |
| `LyricPlayer` + `toAmllLines()`（KRC/LRC 解析） | `LyricsView` + 主进程 `lyricsService`（KRC/LRC/TTML/YRC/QRC 解析成 `LyricLineData`） | 等价；解析搬到了主进程 |
| `line-click` → `seekTo()` | `onLyricLineClick` → `store.seek()` | 已对齐 |
| `lyricClickSeek` 开关 | `settings.lyricClickSeek` | 已对齐 |
| `setAlignAnchor(Center)` + `alignPosition .5` | `alignAnchor="center"` / `alignPosition={0.5}` | 已对齐 |
| 字号 `max(max(5vh,2.5vw),12px) × scale` | 同一条公式 | 已对齐 |
| `wordBright` → `--bright-mask-alpha` | `lyricHighlight` → `--amll-word-bright` | 已对齐 |
| `setEnableBlur/Scale/WordFadeWidth/HidePassedLines` | `LyricsView` 同名 props | 已对齐 |
| 无歌词：左栏 `translateX(50%)`，歌词列滑出 | `.fsNoLyric` 同款 transform | 已对齐 |
| 歌词列 mask 渐隐 2% / 14% / 86% / 98% | 2% / 12% / 88% / 98% | 微差，可接受 |
| 行右键 → 复制该行 | `LyricsMenu` 的 `kind: 'line'` | **本轮新增** |
| 行 `cursor: pointer` | `.fsLyric [class*='lyricLineWrapper']` | **本轮新增** |

### 1.2 舞台外壳与鼠标逻辑

| 插件 | 本应用 | 状态 |
| --- | --- | --- |
| 整页 `translateY(100%)` → 0 的 0.55s 下拉 | `.fullscreen` + `--dur-screen` | 已对齐（曲线略有差异） |
| 关闭条：横杠 → 圆角方块 + X + 跟随 0.24 / 限位 52px | `bindClose()` 同名实现 | 已对齐 |
| 关闭条 `cursor:none` | `.fsClose` | 已对齐 |
| 封面 `scale(.84) → 1.03` 弹性 | `.fsCover` / `.fsCoverPlaying` | 已对齐 |
| 封面点击 = 播放 / 暂停 | 同 | 已对齐 |
| `coverHideCursor` | 同 | 已对齐 |
| 双 art 交叉淡入（ghost img） | `Cover` + `fsCoverEnter`（单图淡入） | 视觉接近；不是逐帧交叉 |
| 进度条 hover/拖拽加粗 + `scaleX` 填充 | 同（宽度百分比填充） | 交互对齐；填充实现不同 |
| 上一/下一首 Q 弹（`saPushL/R/C`） | `fsPushL/R/C` | 已对齐 |
| 音量拖拽 + `volBeforeMute` | 同 + 静音按钮 | **静音按钮本轮新增** |

### 1.3 背景

| 插件 | 本应用 | 状态 |
| --- | --- | --- |
| `bgType`: flow / blur / solid | 同三档 | 已对齐 |
| `IsolationRenderer` 流体 + MeshGradient 兜底 | `BackgroundRender`（AML L react 包） | 等价 |
| `bgFlowSpeed` / `bgRenderScale` / `bgFps` / `bgPerf` | 同 | 已对齐 |
| `bgBlur` / `bgBrightness` / `bgSaturate` | 同 | 已对齐 |
| 两层 `sa-bg-layer` 交叉淡入 | CSS `background-image` 直切 + 全屏 `fsBg` | 简化（无二次叠层） |
| tint / vignette | `.fsTint` / `.fsVignette` | 已对齐 |
| 自适应四档（fps/scale/dither/lyricLite） | `aq` 阶梯 + `lyricQualityLevel` | **本轮重写**；dither 无对应 API |

### 1.4 设置

| 插件页 | 本应用设置页 | 页内设置窗 |
| --- | --- | --- |
| 歌词 | ✅ 歌词 | ✅ |
| 歌曲信息 | ✅ 歌曲信息 | ✅ |
| 背景 | ✅ 背景 | ✅ |
| 歌词源 | ✅ 歌词源 | ✅（并暴露来源优先级 / 自动回退） |
| 歌词播放器 | ✅ 歌词播放器 | ✅ |
| 播放（AutoMix） | ✅ 播放 · AutoMix | ✅（子集 + 跳转完整设置） |
| 杂项（底边栏） | ✅ 顶栏材质 | ✅（命名改为顶栏） |
| 调试 | ❌ | ✅ **本轮新增**（歌曲/歌词源/档位/版本） |
| 关于 | ❌ | ✅ **本轮新增** |
| 恢复默认设置 | ❌ | ✅ **本轮新增** |

### 1.5 菜单与快捷键

| 插件菜单项 | 本应用 | 说明 |
| --- | --- | --- |
| 喜欢歌曲 | — | 宿主点赞按钮不存在；与「收藏」合并 |
| 收藏歌曲 | 收藏 / 取消收藏（带勾） | 写 `favorites.json` |
| 查看歌手：X | 关闭歌词页并跳到艺人页 | 插件只能 toast，这里能真的跳转 |
| 查看专辑：X | 关闭歌词页并跳到专辑页 | 同上 |
| 复制音乐数据… | 复制歌曲信息（JSON） | 字段集合不同（本应用无 `mediaDetail`） |
| 编辑音乐数据 | 歌曲信息…（只读弹窗） | 本应用不支持改标签 |
| 显示翻译歌词 ✓ | 同（写 `showTranslation`） | 已对齐 |
| 显示音译歌词 ✓ | 同（写 `showRoman`） | 已对齐 |
| 切换全屏模式 | 切换系统全屏 | 插件切 DOM 全屏，这里走 `window/setFullScreen` |
| Apple Music-like Lyrics 插件设置… | 歌词页设置… | 打开页内设置窗 |
| 退出歌词页面（红） | 同 | 已对齐 |
| `Ctrl+Alt+L` 开关 | ✅ 新增别名（`Ctrl+L` 仍开侧边面板） | 已对齐 |
| `Esc` 顺序：设置窗 → 菜单 → 页面 | 菜单 → 设置窗 → 页面（+ 队列/信息弹窗） | 顺序微调：菜单在最上，先收菜单 |

---

## 2. 本轮改动文件

```
新增  src/renderer/src/components/LyricsMenu.tsx            整页 / 歌词行右键菜单
新增  src/renderer/src/components/LyricsSettingsDialog.tsx 页内设置窗（8 页 + 关于 + 重置）
新增  src/renderer/src/lib/clipboard.ts                    复制（Clipboard API + execCommand 兜底）
改动  src/renderer/src/components/FullscreenPlayer.tsx     菜单入口、行右键、静音、自适应阶梯、字体
改动  src/renderer/src/components/overlays.module.css      菜单 / 设置窗 / 静音按钮 / 行光标样式
改动  src/renderer/src/state/store.ts                      lyricsMenu / lyricsSettingsOpen / lyricsQualityLevel
改动  src/renderer/src/App.tsx                             Esc 顺序、Ctrl+Alt+L、挂载两个新浮层
改动  src/renderer/src/bridge.ts, src/preload/index.ts     isFullScreen 暴露（通道本就存在）
改动  src/renderer/src/components/Icon.tsx                 volumeOff
改动  src/renderer/src/styles/base.css                     SA PingFang 五个字重 @font-face
改动  src/renderer/src/views/SettingsView.tsx              字号 60–200%、逐字渐变 0.01 起
改动  scripts/verify.mjs                                   新增菜单 / 设置窗 / 背景页三张截图
```

---

## 3. 因项目差异必须调整的部分

1. **宿主注入 → 原生应用。** 插件靠 `transportPort` 扇出、`executeJavaScript` 注入、合成指针事件驱动宿主播放条、
   在 window 里爬 `setPlayOrder`。本应用这些全部是 store action（`next/prev/togglePlay/setVolume/toggleShuffle/cycleRepeat`），
   所以「播放条」只保留 UI 与手感，不再有 `hostTransport()` / `applyHostVolume()` / `findQueueApi()`。

2. **AutoMix 不是同一件事。** 插件只有宿主 `<audio>.volume`，所以是「淡出→宿主换歌→淡入」的等功率包络（`mixDuration 0–12s`、曲线、滤镜）。
   本应用有双 deck、分轨与拍点规划（A–E 五级）。页内「播放」页因此映射到 `automix.*` 的子集（开关/时长/变速/分轨/基础淡出），
   并给出「打开完整设置 ›」入口；插件的 `mixCurve` / `mixFilter` 无对应实现，未移植。

3. **设置存储。** 插件 `localStorage['soda-amll-settings-v1']` + `__v` 迁移；本应用 `%APPDATA%\Pineapple Music\settings.json` + `deepMerge`。
   页内设置窗直接写 `AppSettings`，因此与设置页、右键菜单永远同源；不需要 `__v`。

4. **歌词数据。** 插件在渲染进程解析 KRC/LRC；本应用在主进程解析成 `LyricLineData`（含逐字时间），
   页内「歌词源」页展示的是解析后的来源与回退状态，而不是原始 `md.lyrics`。

5. **入口与浮层。** 插件是右下角 FAB + 宿主设置页「插件」标签；本应用是顶栏歌词按钮、`Ctrl+L` 侧边面板、设置页。
   FAB 与「宿主设置页注入」不适用（没有宿主页面可注入）。

6. **底边栏 ≠ 顶栏胶囊。** 插件的 `barStyle/barOpacity/barBlur/barCover` 作用于宿主 `.bottom-player`；
   本应用没有底边栏，映射到顶栏播放胶囊（`--bar-*` 变量），文案已改为「顶栏材质」。

7. **主题。** 插件只有深色；本应用有浅色主题。歌词页、右键菜单、页内设置窗按插件保持固定深色（它们叠在全屏页上），
   浅色主题下不影响可读性。

8. **默认值差异（保留本应用既有选择，未改）**

   | 项 | 插件 | 本应用 |
   | --- | --- | --- |
   | `showAlbum` | `false` | `true` |
   | `wordFade` | `0.7` | `0.6` |
   | `lyricWeight` 可选 | 300–700 | 300–700（clamp 300–900） |
   | `barOpacity` 上限 | 0.95 | 0.9 |
   | 逐字渐变下限 | 0.0001 | 0.01（本轮从 0.05 收到 0.01） |

9. **未移植（明确不做）**
   - `fab()` 悬浮按钮、`mountAppSettings()`（宿主设置页注入）、`watchSettingsPage()`、`ensureTransportFanout()`、asar 安装器；
   - `copyText` 的 `document.execCommand` 主路径（改为 Clipboard API 优先，仍保留兜底）；
   - `dither` 开关：AMLL 的 React 包没有暴露渲染器内部选项，性能模式只能压分辨率/帧率；
   - 「喜欢歌曲」：宿主点赞按钮不存在，统一收敛到收藏。

---

## 4. 验收

| 项 | 方式 | 结果 |
| --- | --- | --- |
| 类型 | `npm run typecheck` | 全绿 |
| 单测 | `npm test` | 75 例全通过 |
| 截图 | `npm run verify` | 新增 `18b-lyrics-menu-dark`、`18c-lyrics-settings-dark`、`18d-lyrics-settings-bg-dark` |
| 交互回归 | 一次性 Playwright 探针（用完即删） | 14/14：Ctrl+Alt+L、整页菜单、行菜单、设置窗分页与写盘、Esc 分层、静音、0 报错 |
