# Pineapple Music v1.2.0 交付说明

> 对应施工文档：`Pineapple-Music-迁移提示词.md`
> 代码基线：`7909d11`（v1.1.1）→ 本轮 `1.2.0`
> 交付范围：B-1 ~ B-8、F-1、U-1，以及施工中新发现的一个跨页面渲染根因
> 状态：`npm run typecheck` 全绿；`npm test` **75 例全通过**（原 62）；`npm run verify` 36 张截图生成完毕，**渲染进程 0 报错**

---

## 0. 本轮最重要的发现（不在原清单里）

`Cover` 组件的真实封面 `<img>` 是 `position:absolute; inset:0`，而它与占位图是**兄弟节点**，
包裹层没有定位上下文 → `img` 会一路找到祖先里第一个定位元素（通常是 `.contentLayer` / `.page`），
**整张封面铺满整个内容区**。

这一个 bug 同时制造了用户描述的三种现象：

| 现象 | 实际原因 |
|---|---|
| 艺人界面被一张大红色图片占满（B-2 之一） | 48px 的头像封面逃出容器，铺满内容区 |
| 专辑界面「背景」只有一张封面（B-4） | 232px 的封面图铺满整页，真正的页面元素被压在下面 |
| 卡片悬浮时播放按钮消失（B-6） | 逃逸出来的封面 `z-index:1` 盖住了 `z-index:auto` 的按钮 |

**修法**：`Cover` 内部加一层定位容器（`.frame`），占位图与真实封面都放进这个容器；
封面容器自己按 `display` 或父级 `> div` 规则定尺寸。`src/renderer/src/components/Cover.tsx`、
`Cover.module.css` 全部重写为容器式结构，调用方无需改动。

---

## 1. 逐条回写

### B-1 歌词面板内容错误显示为封面 —— 已修

- **根因**：文档判断正确。右侧面板背景既没有 `saturate/brightness` 滤镜，也没有压暗层；
  AMLL 的流体背景直接以高饱和封面铺满 380px 面板，白字被冲淡、非当前行（AMLL 本身透明度和模糊都很低）几乎消失。
- **改动**：`components/LyricsPanel.tsx`、`components/overlays.module.css`
  - 滤镜作用在 **canvas 上**（`.lyricsBg canvas { filter: saturate(...) brightness(...) }`），
    CSS 变量由设置里的 `bgSaturate` / `bgBrightness` 注入 —— 给包裹层加 `filter` 确实无效，实测 computed 仍是 `none`。
  - 新增 `.lyricsTint` 压暗层（插件同款三段渐变），`.lyricsContent` 的 `z-index:2` 天然盖在其上。
  - 无封面 / 关闭背景时的回退底色整体压暗一档。
  - 顺带把 `bgType`（flow / blur / solid）与 `bgEnabled` 真正接到了面板，此前只有全屏页读这两个设置。
- **验收**：`screenshots/09-lyrics-panel-light.png`、`17-lyrics-panel-dark.png` 中当前行清晰、非当前行可辨认；
  DOM 探针确认 canvas `filter = saturate(1.9) brightness(0.55)`、压暗层存在、歌词行 12 行已渲染。

### B-2 艺人页大图 / 迷你歌词控件 —— 按确认只做互斥

- **艺人页大图**：真因是上面的 `Cover` 逃逸（不是 `ArtistsView` 自己的样式）。已随 Cover 修复，
  `screenshots/06-artists-light.png`、`21-artists-dark.png` 中头像为 48px 圆形、无大图铺满。
- **迷你歌词控件**：当前分支确实不存在（`git branch -a` 只有 `main`）。按你的选择**不新造控件**，
  只做互斥：`store.setLyricsOpen(true)` 会关掉全屏，`setFullscreen(true)` 会关掉侧边面板。
  理由：面板在 `floatLayer`（z-index 5），全屏页在 `overlayLayer`（40），同时打开只会让面板被整页盖住。
- **验收**：探针 `B-2 互斥：开面板关全屏` 通过；全屏页右上角补上了歌词入口（见 B-8）。

### B-3 切歌时多次 / 重复切歌 —— 已修（找到新根因）

- **根因（本轮新定位）**：`engine.crossfadeTo()` 先 `await to.el.play()`、**之后**才翻转 `this.active`。
  如果用户恰在歌曲尾部点「下一首」，旧 deck 会在等待窗口里自然播完；此时 `active` 仍指向旧 deck，
  `ended` 被当成「新歌播完了」，于是**一次点击跳两首**。
- **改动**：`audio/engine.ts`
  - 先把 `active` 翻到新 deck，并把旧 deck 标记为 `retiring`；`handleEnded()` 对 retiring deck 的 `ended` 一律忽略。
  - 新 deck 起播失败时立刻停掉旧 deck，不留「静音还在跑」的 deck。
  - 队列推进抽成纯函数 `lib/queueNav.ts`（`nextQueueIndex` / `prevQueueIndex`），`store.next/prev` 改为调用它。
- **验收**：新增 `tests/engineSwitchRace.test.ts`（旧 deck 在切歌瞬间的 ended 不算数、新 deck 真播完仍触发、
  连点 10 次只留一块 deck 出声）、`tests/queueNav.test.ts`（连点 10 次正好前进 10 格、越界/循环语义）。
  原有 `engineAutoAdvance` / `endedGuard` 全绿。

### B-4 专辑页背景应为裁剪封面 —— 已修

- **改动**：`views/AlbumDetail.tsx` + `components/views.module.css`
  - 新增 `.albumBg`：`background-size: cover` + 居中 + `blur(28px)` + `opacity .7`，
    上面压一层「页面底色渐变」保证文字对比度；`pointer-events: none`，没有 `view-transition-name`，不参与形变。
  - `.albumPage { position: relative; isolation: isolate }` + `z-index:-1`，让背景只留在本页的层叠上下文里，
    不用给每个子元素重设 z-index。
- **验收**：`05-album-detail-light.png`、`20-album-detail-dark.png` 背景为该专辑封面的柔和色块；
  探针确认 `background-image` 是 `amcover://.../640`、`pointer-events: none`。

### B-5 「添加音乐文件夹」移入设置 —— 已修

- **改动**：`components/Sidebar.tsx`（删除底部按钮与 `pickFolder`，只留「设置」）；
  `views/SettingsView.tsx`（「资料库」区块的添加按钮补 toast 提示数量，补说明文案）。
- **说明**：设置页本身**早已有**文件夹列表与移除入口，本轮只补了提示与文案，没有重复造。
- **验收**：`screenshots/14-settings-light.png`；探针断言侧边栏文本不含「添加音乐文件夹」。

### B-6 卡片操作按钮消失 / 过白 —— 已修

- **根因**：两层。①`Cover` 逃逸（见第 0 节），封面 `z-index:1` 盖住按钮 → 「悬浮时消失」；
  ②按钮本身是 `rgba(255,255,255,.55)` + `color: var(--text-primary)`，深色主题下白底白字 → 「过白」。
- **改动**：`components/views.module.css`
  - `.cardPlay` / `.cardMore` / `.cardStar` 改为深色玻璃态（`rgba(18,18,20,.52)` + `blur(14px)` + 1px 高光描边），
    常驻可见（`opacity .94`，不再等 hover），36×36 / 32×32 热区，补 `:focus-visible` 焦点环。
  - 三者统一 `z-index: 2`，保证永远在封面之上。
- **验收**：`screenshots/02-recent-light.png`、`19-albums-scrolled-dark.png`；
  探针读到 `opacity=0.94`、`background=rgba(18,18,20,0.52)`、`36×36`。

### B-7 模型下载入口不明确 —— 已修

- **改动**：`views/SettingsView.tsx`（`ModelSection` 新增常驻说明块）、`components/settings.module.css`、
  `main/media/stemRuntime.ts`（新增 `probeModel()`）、`main/ipc.ts`（导入校验 + 具体模型页 + `app/openExternal`）、
  `preload/index.ts`、`renderer/src/bridge.ts`。
- **常驻可见的 6 项**：用途 / 格式（`[1, C, 2049, T]`，C=2 或 4）/ 不兼容（4-stem、波形域、GPU EP、频点非 2049）/
  绝对路径 + 打开目录 / 3 个**可点的具体模型页** / 获取步骤 / 状态反馈。
- **来源**（许可以模型页为准，应用不内置不转分发）：
  - `https://huggingface.co/Tha456/uvr5-models`（UVR_MDXNET_3_9662 ≈28 MB、UVR_MDXNET_Main ≈64 MB，MIT）
  - `https://huggingface.co/Politrees/UVR_resources/tree/main/MDXNet_models`（UVR-MDX-NET-Voc_FT ≈67 MB）
  - `https://github.com/TRvlvr/model_repo/releases`（上游，MIT）
- **导入校验**：导入即 `probeModel()`；签名不符会**删除副本**并回传「期望 vs 实际形状」，
  设置页显示在上次导入失败区块里；目录里已有的不兼容文件也会在状态里逐条列原因。
- **验收**：探针断言 6 项文案与绝对路径；用假 `.onnx` 验证拒绝原因
  （`ONNX 解析失败：... Protobuf parsing failed.`）、且不计入「已安装」。

### B-8 顶栏歌词按钮应开侧边面板 —— 已修

- **改动**：`components/TopBar.tsx`（`onClick={() => setLyricsOpen(!useStore.getState().lyricsOpen)}`、
  `title="歌词面板 (Ctrl+L)"`、`aria-pressed` 与面板一致）、`components/FullscreenPlayer.tsx`
  （补上文档里提到、但实际**没有渲染**的全屏页右上角歌词入口）。
- **未连带修改**：正在播放胶囊整块仍开全屏；`Ctrl+L` 不变；全屏页按钮现在能真正打开面板（会先退出全屏，否则面板被盖住）。
- **验收**：探针 `B-8` 4 项全过；`screenshots/11-fullscreen-lyrics-light.png` 右上角可见入口。

### F-1 收藏（歌曲 + 专辑）—— 已实现

- **新增文件**：`src/main/favorites.ts`（纯函数 + 读写，脏数据兜底）、`src/renderer/src/views/FavoritesView.tsx`、
  `tests/favorites.test.ts`。
- **改动**：`shared/types.ts`（`FavoritesState`）、`main/paths.ts`（`favorites.json`）、`main/ipc.ts`
  （`favorites/get`、`favorites/toggle`）、`preload/index.ts`（白名单）、`bridge.ts`、
  `state/store.ts`（`favorites` 状态 + `toggleFavoriteSong/Album`）、`Sidebar.tsx`（NAV 加「收藏」）、
  `App.tsx`（`case 'favorites'`）、`ContextMenu.tsx`（收藏 / 收藏整张专辑）、`TrackTable.tsx`（行内星标）、
  `Icon.tsx`（新增 `star` / `starFilled`，自绘 SVG 描边）。
- **存储**：`%APPDATA%/Pineapple Music/favorites.json`，只存歌曲 id 与专辑 key（`albumArtist\u0001album`），
  曲库变动后失效条目在视图里自动消失。
- **验收**：右键收藏 → 写盘 → 重启后仍在；收藏页展示专辑卡片与歌曲行；取消收藏实时移除；星标显示。
  以上均由 DOM 探针 + 5 例单测覆盖。

### U-1 侧边栏视觉分隔 —— 已实现

- **改动**：`styles/tokens.css`（`--sidebar-divider` / `--sidebar-shadow-color`，浅深两套）、
  `components/Sidebar.module.css`（`.divider` 渐变细线 + 柔光投影；`.resizeHandle` 常态可见、悬浮加粗成强调色）。
- **说明**：没有用 `border-right`，因为它会跟着 22px 圆角弯成描边；改用独立 1px 元素。
- **验收**：探针读取 `width: 1px` + 渐变 + 阴影；`screenshots/02/03/14` 中可看到分隔。

---

## 2. 顺带修掉的一个脚本 bug

`scripts/bump-version.mjs` 把**整份旧日志**当成 `header` 再 `replace`，导致新版本条目被追加到文件末尾、
旧内容全部落进 body。本轮已修正（只剥标题行），并修正了打印「1.2.0 → 1.2.0」的错误。

---

## 3. 未完成 / 需你拍板

1. **B-2 侧边栏迷你歌词控件**：按你的选择不新造。若之后要做，建议独立立项（涉及侧边栏布局与歌词实例复用）。
2. **B-7 模型兼容性**：设置页已如实写明「UVR 官方多数 MDX-Net ONNX 导出是 `[1,4,3072,256]`，本应用会拒绝」。
   如果你希望直接支持 3072 频点，需要改 `stemService` 的 STFT 参数（属协议级改动，建议单独一轮）。
3. **打包与推送：已完成**（2026-10-25）
   - 安装包：`dist-v120/Pineapple Music-1.2.0-setup.exe`（163 MB，x64 NSIS，SHA256 `33ce21a6…5bc8`）
   - 打包后冒烟：`node scripts/probe-packaged.mjs dist-v120` → 10 首歌入库 / 9 张封面 / Hyalite 0.5.0
   - 仓库：<https://github.com/Sh1D1nk/pineapple-music>（`main` 已更新，tag `v1.2.0`）
   - Release：<https://github.com/Sh1D1nk/pineapple-music/releases/tag/v1.2.0>
     ，资产 `Pineapple.Music-1.2.0-setup.exe`（163 MB，state=uploaded）
   - ⚠️ 注意：`scripts/push-github.mjs` 是用 GitHub API **从本地历史逐 commit 重建**远端，
     远端 sha 与本地不同（远端 `6e0681f` / 本地 `d73f63a`）。不要对远端 `git pull`，
     下次发布仍走 `node scripts/push-github.mjs`。
4. **`screenshots/08*`**：这两张偶发捕到合成层重绘中的中间态（顶栏缺失、底部暗块），
   同一时刻其余 30+ 张截图正常，DOM 探针也确认 `fullscreen=false`、顶栏 rect 正常 —— 属截图时机问题，
   不是功能缺陷，未改代码。

---

## 4. 复跑命令

```bash
npm run typecheck     # 全绿
npm test              # 75 passed
npm run verify        # 36 张截图，渲染进程 0 报错
node tmp-qa-120.mjs   # 26 项 DOM 断言（一次性探针，gitignored）

# 打包（输出目录必须每次换新，否则旧目录删不掉）
npm run compile && npx electron-builder --win nsis -c.directories.output=dist-v120
node scripts/probe-packaged.mjs dist-v120   # 打包后冒烟

# 发布（github.com 直连被挡，走 API 重建）
node scripts/push-github.mjs
```
