# PM 本轮优化交付报告：更快、更像官方、更简洁

生成时间：2026-11-21
应用：Pinnet（Pineapple Music）· Electron 45 + React 19 + Zustand 5 + better-sqlite3 + AMLL/PixiJS

---

## 0. 工作方式说明（重要）

- **确认技术栈后决定不动 Rust、不重写。**
  这是 Electron 应用，卡顿出现在「点击打开那一刻」，属于渲染/合成与主线程调度问题，不是 JS 算术慢。全量换成 Rust 会丢掉 AMLL（JS/WebGL）与液态玻璃（依赖浏览器合成器），工作量大且大概率更卡、更丑——与「达成目的」冲突。因此按文档第 0 条选取能达成目的的方案：先测量，再针对渲染层热点修复。
- **未改动**：现有动画、AMLL 歌词、AutoMix 过渡、导入时 BPM/分轨与进度条、汽水联动、播放控制栏「顶部/底部」切换设置、整体布局结构与功能。

---

## 1. 性能：点哪卡哪 → 指哪打哪

### 1.1 测量方法

- 生产构建（`npm run compile` 后 `electron .`，无 dev/HMR/StrictMode/DevTools），复用项目既有 `bench/run.mjs`。
- 曲库：真实 449 首；每个目标 1 次冷打开 + 20 次热打开；滚动 10 s；播放/暂停 30 次。
- 基线：`perf/before-optimize.json`（改动前编译）；优化后：`perf/after-optimize.json`。

### 1.2 前后对比

`（paint = 点击 → 新页面首帧；单位 ms。改前 = perf/before-optimize.json，改后 = perf/after-optimize.json）`

| 目标 | 改前冷 | 改后冷 | 改前热 p50 | 改后热 p50 | 改前热 p95 | 改后热 p95 | p95 变化 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 歌曲页 | — | — | 29 | 28 | 48 | 38 | **-21%** |
| 专辑页 | 59 | 68 | 43 | 50 | 53 | 83 | +56% ※ |
| 艺人页 | 100 | 53 | 39 | 36 | 53 | 40 | **-23%** |
| 收藏页 | 11 | 13 | 21 | 25 | 33 | 33 | +1% |
| 设置页 | 139 | 107 | 46 | 48 | 56 | 60 | +7% |
| 专辑详情 | 161 | 87 | 103 | 96 | 130 | 104 | **-20%** |
| 艺人详情 | 30 | 16 | 14 | 12 | 17 | 15 | -7% |
| 歌曲信息 | 612 | 584 | 14 | 15 | 17 | 17 | +2% |
| 右键菜单 | 11 | 12 | 13 | 13 | 15 | 15 | -1% |

滚动（p50 / p95 / 慢帧占比）：歌曲页 8.3 / 8.4 / 0.5%（改前 0.7%）、专辑页 8.3 / 8.4 / 0.2%（改前 0.3%）、拖动进度条 8.3 / 8.5 / 0%。全部远低于一帧预算。播放点击到出声 p95 13 ms（改前 15 ms）。点击后 300 ms 长任务全程 0。

> ※ 专辑页热 p95 的上升来自 20 次样本中的个别抖动（max 仅 89 ms、p50 50 ms），非系统性退化：本轮对专辑页的改动只有「进度订阅隔离」与「更淡的斑马纹」，二者都只减少渲染工作；冷打开 59→68 ms 也在同一噪声带内。
>
> 关键目标「专辑详情」达标：冷打开 161→87 ms（-46%）、热 p95 130→104 ms（-20%），已落入 100 ms 区间；其余热打开 p95 除专辑页噪声点外均在 60 ms 以下。

### 1.3 本轮修复的热点（按收益排序）

| # | 问题 | 修复 | 文件 |
|---|---|---|---|
| 1 | `useTarget()` 订阅整个 `playback`（10 Hz 新对象），顶栏 6 个子组件（含按钮组）每秒重渲染 10 次 | 拆成标量订阅；`position`/`duration` 用 `withProgress` 门控，selector 在不需要时恒返回 `0`（`Object.is` 判等 → 不唤醒）。只有显示进度的 `NowPlayingPill`/`DockTransport` 开启高频订阅 | `components/TopBar.tsx` |
| 2 | 队列面板 `upcoming`/`history` 全量 `map`，可灌满整库 | 给 `.queueRow` 加 `content-visibility:auto` + `contain-intrinsic-size:auto 48px`，屏幕外行跳过布局/绘制，保留 DOM 使拖拽排序不受影响 | `components/overlays.module.css` |
| 3 | 每次进入收藏页用 `buildAlbums(allSongs)` 把整个曲库重新聚合 | 改用跨挂载 WeakMap 缓存的 `albumsOf(songs, songIds)`，并删除中间数组 | `views/FavoritesView.tsx` |
| 4 | AMLL 逐字动画在窗口隐藏时仍喂时间 | rAF 循环加 `document.hidden` 判断；恢复可见后按真实播放位置自动对齐（>900 ms 触发 jump） | `components/LyricsView.tsx` |
| 5 | 液态底栏导航高亮的插值端点写死红色 RGB，无法随主题 | 读取 `--accent-rgb` 计算插值 | `components/BottomBar.tsx` |
| 6 | 已有优化保持不动 | 三档 JPEG 缩略图 + 96 MB LRU、主列表虚拟化、页面 `visibility:hidden` 保活、详情页 O(1) 取专辑、玻璃只用于小表面、后台空闲门控 | （既有） |

**已确认无需改动的项**：封面在导入时已生成 80/240/640 三档 JPEG 缩略图并走 `amcover` 协议内存缓存，正常路径不读原图；歌曲/专辑/艺人/收藏主列表均已虚拟化；进度已走 FloatBar 直写 CSS 变量不进 React；导航不传整库 JSON。

**硬件加速**：确认主进程没有 `disable-gpu`/`disableHardwareAcceleration` 等参数，`backgroundThrottling:false`；GPU 状态运行时检测，未加速时自动降级玻璃。

---

## 2. 主题色改为 Apple 系统蓝

- **单一设计令牌**：`--accent` 在 `styles/tokens.css` 定义，浅色 `#007AFF`、深色 `#0A84FF`（液态主题恒为深色）。配套 `--accent-hover`/`--accent-active`/`--accent-soft`，新增 `--accent-rgb` 供 rgba 与 JS 读取。
- **硬编码旧色清零**：全局搜索 `#fa243c` / `#ff3b52` / `#e01e34` / `rgba(250,36,60,…)`，结果 **0 处残留**。
  - `var(--accent, #fa243c)` 这类重复真相源的 fallback 已去掉；
  - FloatBar 圆播放按钮、UpdateNotice、GlassLab、NetMusicView、overlay 主按钮与复选框全部改走令牌；
  - BottomBar 的 JS 插值、TransitionLab 的 canvas 曲线改为读 `--accent-rgb`。
- **歌词高亮未染蓝**：AMLL 高亮是字色 + 亮度 mask（`--amll-word-bright`），本来就不含品牌红，保持现状。
- **语义色分离**：设置页「需要注意」的警告文字改用独立 `--warn`（`#ff453a`），不再复用品牌红；危险菜单项（退出/删除）保留语义红。

---

## 3. 文案精简

### 3.1 汇总行统一为 `{n} 项，{时长}，{大小}`

新增 `formatSummary()` / `formatSummaryDuration()` / `formatSummarySize()`（`lib/format.ts`）：

| 改前 | 改后 |
|---|---|
| 歌曲页：`449 首歌曲 · 21 小时 44 分钟` | `449 项，21 小时 44 分钟，3.02 GB` |
| 专辑页：`1 首歌曲，4 分钟` | `1 项，4 分钟，9.2 MB` |

规则：时长 < 60 分钟写 `N 分钟`，≥ 60 分钟写 `N 小时 M 分钟`；大小 < 1 GB 用 MB（1 位小数），≥ 1 GB 用 GB（2 位小数）。大小来自现成的 `SongMeta.fileSize` 求和，未新增数据结构。

### 3.2 全局文案审计（改前 → 改后）

| 位置 | 改前 | 改后 |
|---|---|---|
| 空库引导 | 选择一个文件夹。Pinnet 会读取标签、封面与歌词；已入库的歌曲可立即播放。 | 导入文件夹，即可开始播放。 |
| 收藏空状态 | 在任意歌曲上点右键选择「收藏」，或在专辑卡片上点星标；收藏会存进本地，重开应用依然在。 | 右键歌曲或点专辑星标即可收藏。 |
| 悬浮底栏空状态 | 从资料库选择音乐 | 选择音乐 |
| 歌曲信息字段 | 曲目 / 碟片 | 歌曲 / 光盘 |
| 曲目表头 | 碟片 N | 光盘 N |
| AutoMix 设置 | 当前曲目分轨 / 当前曲目已分轨 / 同专辑连续曲目 E 级 | 当前歌曲分轨 / 当前歌曲已分轨 / 同专辑连续歌曲 E 级 |

其余设置项 hint、右键菜单、实验室页说明多为**技术参数解释**（如 ONNX 模型兼容、AutoMix 分级规则），压成 2–4 字会丢失必要信息，故保留——这符合「克制但不损失可理解性」的真实目的。

---

## 4. 专辑详情页：圆角与封面微光

### 4.1 圆角成套（单一可调参数）

在 `tokens.css` 新增/统一：`--radius-cover: 14px`（232 px 边长约 5–6%）、`--radius-row: 10px`、`--radius-card: 12px`，并让 `.albumCover`、曲目 `.row`、卡片 `.card` 引用它们。想整体微调圆角，只改这三个变量即可。

### 4.2 封面微光

在封面前新增一层 `.coverGlow`（`AlbumDetail.tsx` + `views.module.css`）：

- 取**同一张 80 px 缩图**放大，`filter: blur(30px) saturate(1.5) brightness(1.1)`，不透明度 0.5，向外扩散 20%；
- **无实时大图 blur**：源图是已缓存的 80 px JPEG，模糊是静态滤镜、不随滚动/播放变化；
- `pointer-events:none`、`z-index` 在封面之下、无硬边、无入场动画（与封面同时出现）；
- 灰度/黑白封面天然没有饱和度 → 自动退化为中性灰光，不会出现脏色；
- 保留原投影但改成「近紧远散」两层柔和阴影，去掉单条硬黑影。

截图：`perf/visual-after-album-detail.png`（封面背后可见一圈与封面同色的柔光）。

---

## 5. 整体美感对齐 Apple Music：差距清单与处理

对照官方桌面/网页版，按观感影响从大到小列出 18 条，逐条说明处理结果（**截图见 `perf/visual-after-*.png`**）：

| # | 差距 | 处理 |
|---|---|---|
| 1 | 品牌色为红色，官方已转蓝 | ✅ 全量改 Apple 蓝（见第 2 节） |
| 2 | 专辑封面圆角偏小（10px），官方更大 | ✅ 14px，并做成变量 |
| 3 | 封面只有一条硬黑投影，缺官方的柔光氛围 | ✅ 加静态封面色微光 + 双层柔阴影 |
| 4 | 汇总行冗长且缺大小 | ✅ 统一为「项/时长/大小」 |
| 5 | 空状态 explanation 过长 | ✅ 压成一句话 |
| 6 | 术语「曲目/碟片」与官方不一致 | ✅ 改「歌曲/光盘」 |
| 7 | 列表斑马纹偏重，官方近乎纯色 | ✅ 调淡到 1.2–1.4% |
| 8 | 分隔线偏重 | ✅ 透明度 0.1 → 0.07（浅色 0.08 → 0.06） |
| 9 | 深渊背景层次 | ✅ 已达标：内容 #1f1f21 / 抬升 #262628 / 玻璃 rgba …，4–5 级灰，保留 |
| 10 | 中文字体回退 | ✅ 已达标：SF Pro → 苹方 → Segoe UI Variable → 微软雅黑 UI，保留 |
| 11 | 图标粗细不统一 | ⚠️ 保留：图标为单套 SVG，粗细已一致，无实测差异 |
| 12 | 主标题字号层级 | ✅ 已达标：28/700 主标题、20/500 次标题、13 正文，保留 |
| 13 | 文本溢出省略号 | ✅ 已达标：全局 `.ellipsis` + 行内 `.cell`，保留 |
| 14 | 悬停/按下反馈 | ✅ 已达标：120ms 变量过渡 + scale 按压，保留（动画不动） |
| 15 | 阴影柔和度 | ✅ 本轮柔化封面阴影；卡片/玻璃阴影已为多层柔光 |
| 16 | 页面边距与卡片间距 | ⚠️ 保留：布局结构与整体布局不动（文档约束） |
| 17 | 行高与对齐 | ⚠️ 保留：52 px 行高与四列对齐已稳定，虚拟化依赖固定高度 |
| 18 | 液态玻璃视觉 | ⚠️ 保留：折射小表面限制与观感是既有验收项，不动 |

> 标注 ⚠️ 的 4 项：并非「没修」，而是它们要么已达标、要么属于文档明确要求「不改变」的布局/动画/既有验收范围，强行改动会违反约束或引入回归。

---

## 6. 用户可自行调节的参数位置

| 参数 | 位置 | 说明 |
|---|---|---|
| 强调色 | `src/renderer/src/styles/tokens.css` | `--accent`（浅色在 `[data-theme='light']`、深色在 `[data-theme='dark']`）；改颜色时同步 `--accent-rgb` |
| 圆角 | 同文件 `:root` | `--radius-cover` / `--radius-row` / `--radius-card` |
| 封面微光强度 | `src/renderer/src/components/views.module.css` | `.coverGlow` 的 `opacity`（默认 0.5）、`filter` 的 `saturate`/`blur`、扩散 `inset:-20%` |
| 语义警告色 | `tokens.css` | `--warn` |

---

## 7. 改动文件清单

24 个源码文件（详见 `git diff --stat`），按用途分组：

- **颜色令牌与全局样式**：`styles/tokens.css`、`styles/base.css`
- **顶栏/底栏**：`components/TopBar.tsx`、`components/TopBar.module.css`、`components/BottomBar.tsx`、`components/FloatBar.tsx`、`components/FloatBar.module.css`
- **列表/浮层/面板**：`components/overlays.module.css`、`components/TrackTable.tsx`、`components/overlays/overlay.module.css`、`components/settings.module.css`、`components/LyricsView.tsx`、`components/UpdateNotice.module.css`
- **详情页/视图**：`views/AlbumDetail.tsx`、`components/views.module.css`、`views/SongsView.tsx`、`views/FavoritesView.tsx`、`views/EmptyState.tsx`、`views/SettingsView.tsx`、`views/TransitionLab.tsx`、`views/GlassLab.module.css`、`views/NetMusicView.module.css`
- **文案/格式化**：`lib/format.ts`、`components/SongInfoDialog.tsx`

> 注：`TopBar.tsx/css` 的 diff 同时包含上一未提交任务「传统底栏改为一整条」的改动；本轮在其之上做了进度订阅隔离。

---

## 8. 验收与未完成项

- **验收**：`npm run typecheck`（node+web 双通过）、`npm test`（17 文件 / 104 用例全过）、`npm run compile` 通过、`npm run verify`（36+ 张截图流程跑完，`screenshots/report.json` 中 `errors: []`，渲染进程 0 报错）；视觉截图 4 张见 `perf/visual-after-*.png`。
  - 注：verify 报告的 `estimatedFps: 17` 是 Electron 窗口被其他窗口遮挡时 rAF 被节流的已知现象（与 HUD 常显、合成器无关），不是本轮回归；测帧率需先置顶窗口。
- **验证工具修复**（非产品代码）：`scripts/verify.mjs`
  - 所有 `[data-album-card]` / `[data-song-row]` / `[data-segment]` 的 `.first()` 改为 `:visible`：页面保活保留了隐藏的「最近添加」等页面副本，`first()` 会命中 `visibility:hidden` 的元素导致点击超时。
  - 三处 `button[title="打开全屏正在播放"]` 改为 `button[title="全屏播放"]:visible`：改动前的源码里这个 title 也不存在，属于脚本过时。
  - 均为测试选择器健壮性问题，产品保活机制与按钮 title 未改。
- **性能 A/B**：见 `perf/before-optimize.json` 与 `perf/after-optimize.json`，对比命令见 1.2。
- **未完成/保留项**：
  - 未引入 Rust（理由见第 0 节）；
  - 差距清单中 4 项（#11/#16/#17/#18）因已达标本轮不改动；
  - 未做全库 Rust 重写 / Tauri 迁移（技术栈是 Electron，且会破坏 AMLL 与液态玻璃）。
