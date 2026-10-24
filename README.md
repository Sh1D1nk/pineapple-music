# Pineapple Music

一款 Windows 桌面音乐播放器：Apple Music 桌面端的版式与交互，加上 macOS 26 式的**液态玻璃**（真实 SDF 折射，不是毛玻璃贴图）。

Electron + electron-vite + React 19 + TypeScript(strict) + Zustand，界面语言简体中文。

![歌曲列表](screenshots/03-songs-light.png)

---

## 1. 快速开始

```bash
npm install            # 依赖安装（.npmrc 已预设 legacy-peer-deps 与 electron 镜像）
npm run dev            # 开发模式，直接打开应用窗口
npm run build          # 产出 Windows 安装包 dist/Pineapple Music-1.0.0-setup.exe
```

其它脚本：

| 命令 | 作用 |
| --- | --- |
| `npm run compile` | 只做 electron-vite 构建（out/main、out/preload、out/renderer） |
| `npm run build:dir` | 只打包成免安装目录（dist/win-unpacked） |
| `npm run fixtures` | 生成 10 个测试音频到 `fixtures/` |
| `npm test` | vitest 单元测试（44 个用例） |
| `npm run typecheck` | 主进程 + 渲染进程 strict 类型检查 |
| `npm run verify` | 构建后用 Playwright 驱动 Electron，跑完整截图清单并输出 `screenshots/report.json` |
| `npm run rebuild:native` | 需要时用 `electron-builder install-app-deps` 重建原生模块 |

> 首次 `npm install` 时 Electron 与 ffmpeg-static 会从 GitHub 下载。`.npmrc` 已把 Electron 指向 npmmirror；
> 若 `ffmpeg-static` 下载失败不影响安装（它是 optionalDependency），应用会自动回退到系统 PATH 上的 `ffmpeg`。
> 打包时若卡在下载 NSIS/winCodeSign，可临时设置
> `ELECTRON_BUILDER_BINARIES_MIRROR=https://registry.npmmirror.com/-/binary/electron-builder-binaries/`。

### 用自己的曲库验证

1. 启动后点「选择文件夹…」，或把文件夹/音频文件直接拖进窗口。
2. 侧边栏底部会显示「正在更新资料库 → 正在分析资料库」，已入库的歌曲立刻可播。
3. 打开「歌曲信息…」的「文件」页，可以看到 BPM、LUFS、有效音频起止点，说明后台分析已经跑过。
4. 想看 AutoMix：把两首 BPM 相近的歌排在队列里，接近结尾时会看到顶栏出现 `AutoMix C` 徽标。

---

## 2. 功能

**资料库**
- 递归扫描 mp3 / flac / m4a / aac / ogg / opus / wav（ape 能读出标签，但解码依赖 ffmpeg 是否带该解码器，见「已知限制」）。
- 按 修改时间 + 文件大小 增量扫描；已入库歌曲立即可见可播；监听文件夹变化自动增删；支持拖放导入。
- 索引优先 better-sqlite3（WAL），原生模块不可用时自动回退 JSON 索引，行为一致。

**内嵌信息（真正读取，不做默认值兜底）**
- 基础字段：标题、多艺人、专辑艺人、专辑、曲目号/总数、碟号/总数、年份、流派、BPM、时长、比特率、采样率、位深、声道、编码、容器、文件大小、ReplayGain。
- 创作者：作曲 / 作词 / 编曲 / 制作人 / 混音 / 母带 / 演唱，覆盖 ID3v2 `TCOM/TEXT/TIPL/IPLS/TMCL/TXXX`、Vorbis `COMPOSER/LYRICIST/ARRANGER/PRODUCER/MIXER/ENGINEER`、MP4 `©wrt` 与 `----` 自由字段。
- 封面：优先 Front Cover 类型内嵌图，其次第一张，再次同目录 `cover/folder/front/albumart.(jpg|png|webp)`；按内容 SHA-1 去重，落盘 80/240/640 三档缩略图（`nativeImage` 生成），列表只用 80，全屏才用 640；无封面时显示灰阶渐变 + 线条音符占位。
- 内嵌歌词：ID3 `SYLT` / `USLT`、Vorbis `LYRICS` / `UNSYNCEDLYRICS`、MP4 `©lyr`。

**歌词**
- 来源优先级可在设置里切换：同名外挂（`.lrc` > `.ttml` > `.lys` > `.yrc` > `.qrc`）优先或内嵌优先。
- 解析交给 `@applemusic-like-lyrics/lyric`：标准 LRC（一行多时间戳、`[offset:]`、头部标签）、增强型逐字 LRC、TTML、LYS、YRC、QRC。
- 同一时间戳多行自动合成「原文 + 翻译 + 音译」（日文假名下的拉丁行判为罗马音，中文下的英文行判为翻译）。
- 编码自动探测：UTF-8（含/不含 BOM）、UTF-16LE/BE、GB18030、Big5、Shift-JIS。
- 行结束时间取下一行开始并设 15 秒上限；纯文本歌词按静态列表显示；LRC 文件修改后热重载。
- AMLL `LyricPlayer` 逐字高亮 + 间奏三点动画；时间轴由 `requestAnimationFrame` 直接写进 `lyricPlayer.setCurrentTime()`，不走 React 渲染。

**播放与队列**
- 双 Deck + 重采样安全的手动切歌（0.5–1 秒等功率交叉淡化）。
- 随机 / 列表循环 / 单曲循环、队列拖拽排序、稍后播放、历史记录、系统媒体键。
- 记住上次歌曲、进度、队列与视图。

**界面**
- 三层结构：内容层（铺满窗口、滚动内容从玻璃下方穿过）→ 浮动玻璃层（侧边栏、顶栏四个胶囊、右侧面板）→ 浮层（菜单、弹窗、全屏正在播放）。
- 浅色/深色跟随系统或手动切换；设计令牌集中在 `src/renderer/src/styles/tokens.css`。
- 全屏正在播放：AMLL 流体背景、44/56 双栏、封面暂停缩放、12% 上下遮罩渐隐、点击歌词跳转。
- 设置页：外观、资料库、歌词、AutoMix、缓存。

**AutoMix**
- TransitionPlanner 为纯函数，输出可序列化时间轴；四级降级链 A→B→C→D→E。
- bridge 片段在渲染进程用 `OfflineAudioContext` + Signalsmith Stretch（AudioWorklet）离线渲染，远快于实时。
- 状态机 `Idle → Preparing → Ready → InBridge → Handoff`，过渡中暂停/拖动/切歌/改队列都有对应处理。

**Transition Lab**（`Ctrl+Shift+L` 或 设置 → 打开 Transition Lab）
- 任意两首已分析歌曲 → 离线渲染 → 试听 / 导出 WAV。
- 画布可视化：当前增益、下一首增益、变速曲线、人声退出区间、低频交换标记。
- 输出级别、拍点相位误差（ms）、渲染耗时。

---

## 3. 技术决策

### 3.1 液态玻璃：Hyalite（真折射）

`src/renderer/src/vendor/hyalite/` 是 [Hyalite v0.5.0](https://github.com/VII-Cae/hyalite--liquid-glass) 的**逐字节副本**（`hyalite.js` / `hyalite.d.ts` / `LICENSE` 原样保留，含版权头）。它按元素真实尺寸与圆角算 SDF 透镜图，喂给 `feDisplacementMap`，再用 `backdrop-filter: url(#…)` 对元素背后的实时内容做折射。

- 为什么不用 WebGL/DOM 快照方案：歌词滚动与 AMLL 流体背景都是实时内容，快照类方案必然滞后或撕裂；Hyalite 走的是合成器层面的 backdrop-filter，天然跟手。
- 两套参数：`FULL`（小控件：bevel 18 / thickness 34 / dispersion 1.4 / blur 2 / materialize 180）与 `LITE`（大面板：bevel 16 / thickness 26 / slope 0.9 / dispersion 0 / smooth 0 / blur 7）。参数在 `glass/hyalite.ts`。
- 三档材质：完整折射 / 简化（`blur(22px) saturate(1.7)` + 高光边）/ 关闭（纯色半透明）。`GlassProvider` 在 `Hyalite.supported()` 为假、GPU 未硬件加速、系统「减少透明度」、或连续两个 3 秒窗口平均帧耗时超过阈值时自动降为简化，并给一次性轻提示。
- 遵守上游约束：承载滤镜的隐藏 `<svg>` 不设 `display:none`；`--hyalite` 只由被附着元素自己读取；着色写在元素自身 `background`；玻璃元素没有 `opacity/filter/mask/mix-blend-mode` 祖先；进出场只动 `transform`。

**实测**（`screenshots/report.json`）：同一屏内容（相册网格滚到顶栏下方）下，完整折射与简化模式的顶栏区域平均通道差 **8.0/255**，**60.8%** 的像素有可测差异；`Hyalite.info()` 返回的透镜图 `maxDisplacement ≈ 8.8px`。截图 `24-glass-full.png` 与 `25-glass-simplified.png` 是同一场景的两次捕获，可直接对比。

### 3.2 音频链路

- 播放走 `<audio>` + `MediaElementAudioSourceNode`（流式、可拖动、内存恒定），不是整曲解码。
- 自定义协议 `amsong://` 提供音频（支持 Range，206 分片），`amcover://` 提供封面。两者都注册为 `standard/secure/corsEnabled`，并返回 `Access-Control-Allow-Origin: *` —— 这是 `MediaElementSource` 在 `file://` 下不静音的前提。
- AutoMix 的 bridge 用 `OfflineAudioContext` + Signalsmith Stretch worklet 离线渲染成 `AudioBuffer`，再由 `AudioBufferSourceNode` 采样精确调度，与 Deck 之间用 0.3 秒等功率交叉淡化衔接。

### 3.3 后台分析

- ffmpeg 负责解码与测量：`ebur128` 拿积分响度，`silencedetect` 拿首尾静音与有效音频起止点。
- 节拍分析在 `worker_threads` 里跑：谱通量 onset → 自相关 + 谐波梳状打分（解决半速/倍速歧义）→ 相位扫描 → 拍点吸附，输出 BPM、拍点数组、稳定度、强拍相位。纯函数在 `src/shared/dsp/`，可单测。
- 任务队列持久化在索引库（每首歌的 `analysis` 字段），重启后自动续跑；优先级跟随当前播放与队列顺序；单曲失败重试 2 次后隔离。

### 3.4 索引

`better-sqlite3` 用的是 Node-API 预编译产物，因此**不需要** `electron-rebuild` 也能在 Electron 里加载（`npmRebuild: false`）。加载失败时 `openRepository()` 会退回 JSON 索引，功能不变。

---

## 4. AutoMix：做到了哪一级

| 级别 | 内容 | 状态 |
| --- | --- | --- |
| D | 等功率交叉淡化 + 以「有效音频结束点」而非文件时长计算起点 | **已实现，默认兜底** |
| C | 整曲节拍对齐混音 + 低频交换 + 响度匹配，≤16 秒 | **已实现**（分轨未就绪时的主力级别） |
| B | 人声先退 / 伴奏交叉 / 人声后进，不变速，≤12 秒 | 规划器与渲染已实现，**需要分轨数据**才触发 |
| A | 完整分轨：时变变速 + 拍点相位对齐 + 低频交换 + 响度匹配 | 同上 |
| E | 同专辑连续曲目保持无缝 | 已实现 |

**P2（分轨）按优先级被裁剪**：神经网络分轨需要 100–300 MB 权重，我无法在这个交付里附带可信的、许可清晰的模型，也不愿意用假的「人声轨」充数。因此：

- `StemService` 的窗口规划、缓存键、LRU、状态机、`vocalCurve` / 人声乐句提取都已就位；
- 人声乐句现在由**歌词时间轴**推导（`phrasesFor()`），规划器据此选择人声退出的停顿点；
- 没有分轨数据时，`planner` 明确输出 `level: 'C'` 并在 `notes` 里写明「分轨未就绪，整曲节拍对齐混音」；
- 设置页与进度面板都如实显示「AutoMix 分轨：未安装模型」。

模型选型调研（若要把 A/B 级接上）：

| 候选 | 许可 | 体积 | 说明 |
| --- | --- | --- | --- |
| Demucs v4 (htdemucs) ONNX 转换 | MIT（代码）/ 权重 CC-BY-NC 风险需自行确认 | 80–170 MB | 质量最好，两轨（vocals/no_vocals）导出即可；推理需要 STFT + overlap-add |
| UVR MDX-Net 2-stem ONNX | 权重多为 MIT/CC-BY，需逐个模型确认 | 30–60 MB | 社区最常见的 ONNX 形态，输入 `[1,2,2049,T]`，CPU 上约 0.5–1× 实时 |
| Spleeter 2stems | MIT（代码）/ 权重 CC-BY-SA | 40 MB | 速度最快，质量最弱，适合兜底 |

接入点：`src/main/media/` 增加一个 `stems.ts`（ONNX session + 分块推理 + 写 FLAC 人声轨），把 `vocalCurve` 填进 `SongMeta.stem`，规划器就会自动升到 B/A 级 —— 规划器与渲染端不需要改动。

---

## 5. 测试

```bash
npm run fixtures   # 生成 10 个夹具（首次 npm test 会自动生成）
npm test
```

夹具覆盖：ID3v2.3（APIC + USLT + TCOM/TEXT/IPLS + 完整基础字段）、ID3v2.4（SYLT）、FLAC（PICTURE + LYRICS + 四个角色字段）、m4a（covr + ©lyr + ©wrt）、标准 LRC / 增强型逐字 LRC / 双语 LRC、声明 ISO-8859-1 实则 GBK 的 mp3 与 GBK 编码 .lrc、无标签「艺人 - 歌名.mp3」、以及 100 BPM 与 108 BPM 两首鼓点循环。

44 个用例覆盖：标签映射与中文乱码修复、LRC/offset/双语/逐字解析、编码探测、节拍估计（合成点击轨 + 真实夹具解码）、响度与静音检测、TransitionPlanner 的 12 种场景（末句贴尾、前奏过长/过短、BPM 倍速、超限、速度不稳、gapless、响度匹配、相位误差）、任务队列的优先级/取消/重试。

真实跑出来的数字：

- 10 首夹具：扫描 + 标签 + 封面 ≈ 2 秒；阶段 1 分析 10 首 ≈ 18 秒（单 worker）。
- BPM：`Loop 100 → 99.6`、`Loop 108 → 107.7`（误差 < 0.5 BPM）。
- 滚动 45 帧（相册网格，1280×800）：
  - 简化玻璃 / 关闭折射：**8.33 ms/帧（≈120 fps，显示器 120 Hz）**，p95 8.6 ms，无掉帧；
  - 完整折射：**41–55 ms/帧（≈20 fps）**。这台机器上 `backdrop-filter: url(#svg)` 每帧都要重跑滤镜，代价与 dispersion/sat/blur 参数几乎无关（实测关掉色散仍是 54 ms）。
- 因此**自动降级不是摆设**：一次 3 秒窗口超过 30 ms，或两个窗口超过 22 ms 就切到简化档并轻提示一次；设置里再点一次「完整折射」可以随时重试。
- 玻璃：见 3.1 的像素差数据。
- Transition Lab 离线渲染 30 秒 bridge（100 → 108 BPM）：**1811–2154 ms**（约 14–16× 实时），拍点相位误差 **0.1 ms**，变速曲线 71 个关键帧。

---

## 6. 已知限制

- **分轨（AutoMix A/B 级）未包含模型**，见第 4 节。默认运行在 C/D 级。
- **ape / wv**：能读标签，但能否播放取决于 ffmpeg 构建是否带 Monkey's Audio / WavPack 解码器；内置的 `ffmpeg-static` 通常包含，系统 ffmpeg 视构建而定。
- **SMTC**：只做了系统媒体键（`globalShortcut` 的 MediaPlayPause/Next/Previous/Stop），没有接 Windows SMTC 会话（需要原生模块）。
- 歌词的「音译」判定是启发式（日文假名 + 拉丁行 → 罗马音，其余 → 翻译），不是语言识别。
- 播放位置持久化用 localStorage，与索引库分开；清除应用数据会一起清掉。
- 打包目标只有 Windows x64（NSIS，非一键安装，可选安装目录）。
- 目录里没有应用图标，安装包使用 Electron 默认图标。
- 曲库规模：列表用 `@tanstack/react-virtual` 虚拟化（只渲染视口内约 20 行），扫描是增量且分批发给渲染进程，设计上不随曲库线性变慢；但**我没有用 5000 首真实曲库做过端到端计时**，本文所有数字来自 10 首夹具。

---

## 7. 目录结构

```
src/main/                 主进程：文件系统、扫描、标签、封面、索引、分析、任务队列
  library/                tags / covers / encoding / scanner / repository
  media/                  ffmpeg / analysisService / taskQueue
  lyrics/                 lyricsService（来源选择、编码探测、解析、缓存）
  workers/                analysis.worker（worker_threads 跑 DSP）
  protocols.ts            amcover:// / amsong://（含 Range 与 CORS）
src/preload/              contextBridge API + 文件拖放路径解析
src/renderer/src/
  audio/                  engine（双 Deck 状态机）/ automix / bridgeRenderer
  glass/                  GlassProvider + Hyalite 参数
  components/ views/      UI
  state/store.ts          Zustand store
  styles/tokens.css       设计令牌
  vendor/hyalite/         Hyalite 原始副本 + LICENSE
src/shared/               dsp（fft/tempo/loudness）、transition/planner（纯函数）、类型
scripts/                  make-fixtures / verify（Playwright 截图）/ 诊断脚本
tests/                    vitest
```

---

## 8. 第三方许可与归属

本项目整体以 **AGPL-3.0-only** 发布 —— 因为直接链接了 AGPL 的 AMLL。

| 依赖 | 许可 | 说明 |
| --- | --- | --- |
| [Apple Music Like Lyrics (AMLL)](https://github.com/amll-dev/applemusic-like-lyrics) `@applemusic-like-lyrics/react` / `lyric` / `core` | **AGPL-3.0-only** | 歌词播放器、流体背景、歌词解析。版权归 AMLL 作者（steve-xmh 等）。AGPL 与本项目兼容，但要求整体以 AGPL 分发。 |
| [Hyalite](https://github.com/VII-Cae/hyalite--liquid-glass) v0.5.0 | **MIT** © 2026 VII-Cae (VII) | 液态玻璃折射。`src/renderer/src/vendor/hyalite/LICENSE` 为原始许可全文，`hyalite.js` 文件头保留版权声明。MIT 与 AGPL 兼容。 |
| [Signalsmith Stretch](https://www.signalsmith.com/) (npm `signalsmith-stretch`) | **MIT** | 时变变速不变调（AudioWorklet + WASM）。 |
| [music-metadata](https://github.com/Borewit/music-metadata) | MIT | 标签读取。 |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | MIT | 索引库（Node-API 预编译）。 |
| [chardet](https://github.com/runk/node-chardet) / [iconv-lite](https://github.com/ashtuchkin/iconv-lite) | MIT | 编码探测与转码。 |
| [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) | GPL/LGPL（随构建而定） | 解码与测量。**可选依赖**，未使用系统 ffmpeg 时由它提供二进制；分发时请确认具体构建的许可。 |
| [pinyin-pro](https://github.com/zh-lx/pinyin-pro) | MIT | 拼音首字母搜索。 |
| [PixiJS](https://pixijs.com/) 7（`@pixi/*` 子包） | MIT | AMLL core 的 peer 依赖（本项目只用 MeshGradient 渲染器，但模块级 import 需要它们存在）。 |
| React 19 / Zustand / @tanstack/react-virtual / Electron / electron-vite / electron-builder | MIT | 运行时与工具链。 |

只有 AMLL 是 AGPL，其余全部为 MIT / ISC / Apache-2.0 级别且与 AGPL 兼容；`ffmpeg` 二进制的许可取决于你选用的构建，需要单独确认。

---

## 10. 本轮修复对照（对齐 AMLL 插件原版）

参考实现：`soda-amll-lyrics/src/inject.js`（汽水音乐 AMLL 插件）的 `OVERLAY_CSS` 与 `sa-stage` DOM。

| # | 问题 | 原因 | 处理 | 文件 |
| --- | --- | --- | --- | --- |
| 1 | 歌词页与原版不一致 | 自拟 44/56 双栏 + 浮动关闭钮 + 右下三按钮 | 改为原版 50/50：左栏「关闭条 → 封面 min(52vh,37vw)/3% 圆角/scale .84↔1.03 → 曲名 1.28em/副行 .9em/.78em → 进度 → 五个控制 → 音量」，右栏歌词用 `mask-image` 上下渐隐 + `padding-right:8%`；字号回到原版公式 `max(max(5vh,2.5vw),12px)`（1280×800 下 40px，原来是 28px）；删掉右下三个按钮 | `FullscreenPlayer.tsx`、`overlays.module.css` |
| 2 | 顶栏封面压住圆角 | 40px 封面塞在 48px 胶囊里 | 缩到 34px、圆角 8、左内缩 4px，胶囊内边距 18px | `TopBar.tsx`、`TopBar.module.css` |
| 3 | 模糊态没有玻璃磨边 | 描边只在 `.glass` 的 inset shadow 里，Hyalite 的 `--hyalite-edge` 会覆盖它 | 每个胶囊加 `::after` 画 1px `--glass-stroke` + 顶部 1px 高光，三档材质都保留 | `TopBar.module.css` |
| 4 | 两首歌同时播放 | `load()`/`crossfadeTo()` 不停另一块 deck；暂停定时器会把新 deck 停掉 | 新增 `silenceOther()`（pause + 清 src + 归零 gain）并在 load/crossfade/handoff 里调用；`pauseTimers` 可取消且校验 active | `audio/engine.ts` |
| 5 | 切换永远显示 D 级 | ①「接下来播放」改队列但不改当前歌曲，调度器提前 return，从不重新规划；②拍点稳定度阈值 0.55 过严 | 订阅 key 加入「下一首 id」；阈值降到 0.4；设置页新增「分轨模型」区块（下载页 / 导入 .onnx / 打开模型目录 + 当前级别） | `audio/automix.ts`、`shared/transition/planner.ts`、`views/SettingsView.tsx`、`main/ipc.ts` |
| 6 | 改名 | — | 应用名、窗口标题、安装包、快捷方式、userData 目录全部改为 Pineapple Music | `package.json`、`electron-builder.yml`、`index.html`、`main/index.ts` |
| 7 | 传输按钮与实际状态不同步 | ①`play()` 的 promise 偶尔不 settle，phase 卡在 loading；②bridge 恢复后 phase 没回 `bridge`；③按钮被窗口拖拽区吞掉 | `toggle()` 改用 `snapshot().playing` 单一判据；`play()` 加 3s 上限 + 重试 + 以元素 `paused` 为准；`resumeBridge()` 补 phase | `audio/engine.ts` |
| 8 | 点歌名/作者/进度无反应 | 整个顶栏是 `-webkit-app-region: drag`，只有 button 被排除，进度条与标题块不是 button | 标题块改成 `<button>` 打开全屏；进度、音量、胶囊内元素统一 `no-drag`；`.bar` 改为 `pointer-events:none` + 子元素 auto | `TopBar.tsx`、`TopBar.module.css` |
| 9 | 选中行圆角太方 | 行圆角硬编码 8px | 令牌 `--radius-row` 改 12px 并在行上引用 | `styles/tokens.css`、`views.module.css` |
| 10 | 切一次触发多次 | 过渡到切换点时 store 的当前歌曲被 bridge 推到下一首，调度器把它当用户切歌 → `cancelBridge()` 把正在出声的 bridge 掐掉，再次规划 | 订阅里识别 `engine.isBridging() && songId === 下一首` 时直接 return；交接完成后由 tick 重新规划下一对 | `audio/automix.ts`、`engine.isBridging()/bridgedSongIds()` |
| 11 | Ctrl+L 歌词面板没背景 | 有歌曲但没封面时代码既不渲染 AMLL 背景也不渲染兜底渐变 | 先无条件铺一层渐变底，有封面再叠 AMLL 流体背景 | `LyricsPanel.tsx` |
| 12 | 全局缺动画 | — | 引入 View Transitions：点专辑卡片时封面 `view-transition-name: album-cover` 从网格形变到详情大图，曲线 `.34,1.56,.64,1`（果冻过冲），根快照 180/260ms 淡出淡入；页面入场 `pageIn`、卡片错峰 `cardIn`；过渡层显式 `pointer-events:none` | `lib/transition.ts`、`views/*`、`styles/base.css`、`views.module.css` |
| 13 | 左上角搜索不可用 | 顶栏 `.bar` 是 `left:0` 的全宽透明盒，盖在侧边栏搜索框上吞点击；另外拼音用了 `pattern:'first'`（首字母）导致「qing」永远搜不到 | `.bar` 左边界改为侧边栏右侧；`pattern:'pinyin'` 取全拼、`pattern:'initial'` 取首字母并去声调 | `TopBar.module.css`、`lib/search.ts` |

---

## 9. 截图

`screenshots/` 下为 1280×800 的浅色/深色成对截图（由 `npm run verify` 自动生成）：

| 文件 | 内容 |
| --- | --- |
| `01-empty-light` | 空状态 + 拖放提示 |
| `02-recent-light` | 最近添加 |
| `03-songs-light` / `16-songs-dark` | 歌曲虚拟列表 |
| `04-albums-scrolled-*` | 专辑网格滚到顶栏玻璃下方 |
| `05-album-detail-light` / `20-album-detail-dark` | 专辑详情 |
| `06-artists-light` / `21-artists-dark` | 艺人 |
| `07-search-light` | 搜索结果（拼音 `qing` 命中「晴天」） |
| `08b-topbar-closeup-light` / `16b-topbar-closeup-dark` | 顶栏胶囊近景（播放中） |
| `09-lyrics-panel-light` / `17-lyrics-panel-dark` | 歌词面板（逐字高亮） |
| `10-queue-panel-light` | 待播清单 |
| `11/18-fullscreen-lyrics-*` | 全屏正在播放（有歌词） |
| `22-fullscreen-nolyrics-dark` | 全屏正在播放（无歌词） |
| `12/23-context-menu-*` | 右键菜单 |
| `13-song-info-light` | 歌曲信息弹窗 |
| `14-settings-light` / `15-settings-dark` | 设置 |
| `24-glass-full` / `25-glass-simplified` | 完整折射 vs 简化，同一屏内容 |

`report.json` 记录当次运行的分析结果、帧耗时、玻璃像素差与渲染进程报错。

---

## 11. 分轨（Stem Separation）— ONNX 推理

**名称**：分轨 / Stem Separation。把一首歌离线拆成 `vocals` 与 `instrumental` 两条无损轨，并产出人声能量曲线，供 AutoMix 的 A/B 级过渡使用。

**预期行为**

1. 把一个两轨 ONNX 模型放进模型目录（设置 → 分轨模型 → 导入本地模型）。只接受频谱 mask 家族：输入 `[1, C, 2049, T]`（C=2 立体声实虚 / C=4 加单声道），输出同形状，前两通道当作 L/R mask。
2. 设置页「开始分轨」把当前曲目与队列下一首入队；一次只跑一首，可暂停/继续/停止。
3. 管线：ffmpeg 解码 → 分块 STFT(4096/1024, Hann, center) → 每 64 帧喂一次 ONNX → 用 mask 与 1−mask 分别 iSTFT 重建 → 写 `vocals.wav` / `instrumental.wav` → 从 vocals 算 50ms 能量曲线并检测人声乐句 → 写回 `song.stem`。
4. 规划器读到 `stem.state === 'ready'` 后，过渡从 C 级升到 A 级（人声在停顿处退出、时变变速）或 B 级（不变速）。
5. 运行时缺失、模型签名不符、帧数固定（如 dim_t=256）都会给出明确原因：固定 T 自动补零再截取，签名不符直接拒绝，绝不硬喂。

**实现范围**

| 文件 | 职责 |
| --- | --- |
| `src/shared/stem/stft.ts` | radix-2 FFT / iSTFT / Hann 加窗 / COLA 归一化 / RMS 曲线 / 乐句检测（纯函数，5 个单测覆盖往返重建与 0.35/0.65 分离） |
| `src/main/media/stemRuntime.ts` | onnxruntime-node 懒加载、模型签名探测、会话缓存、状态上报 |
| `src/main/media/stemService.ts` | 任务编排（解码 → 分块推理 → 重建 → 落盘 → 缓存 LRU → 进度事件） |
| `src/main/ipc.ts` / `src/preload/index.ts` | `stems/status|enqueue|pause|resume|cancel` |
| `src/renderer/src/views/SettingsView.tsx` | 运行时状态、分轨进度、开始/暂停/停止 |
| `src/renderer/src/audio/automix.ts` | 有分轨时用真实人声乐句，规划器 `stemsReady` 置真 |

**不做**：4-stem（鼓/贝斯）、GPU EP、实时分轨。

**实测**（合成常量 mask 模型 `fixtures/test-mask-035.onnx`，仅用于验证管线）：24 秒歌曲 **4 秒**跑完（≈6× 实时），`vocalCurve` 480 点、`phrases` 1 段、状态 `ready`；单测验证重建误差 < 1e-3、mask 0.35 时人声/伴奏能量比 0.4–0.7。
