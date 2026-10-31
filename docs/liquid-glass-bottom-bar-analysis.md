# 液态玻璃底栏：三套实现的技术分析

> 对象：**Pineapple Music**（本项目，Electron + React）、**HeyBox-LiquidGlass**（小黑盒 App 的 LSPosed 模块）、**KernelSU Manager**（Compose / Miuix）。
> 目的：把「液态玻璃底栏」拆到可复述的粒度——它由哪几层构成、每个参数从哪来、哪些是平台决定的、哪些是实现偏差。

---

## 0. 一句话结论

三者的**视觉目标相同**（一颗悬浮玻璃胶囊 + 一颗会动的高亮气泡），但**渲染栈完全不同**：

- HeyBox 与 KSU 都跑在 Android 上，气泡是一块**真正的折射玻璃**（AGSL `RuntimeShader` / Miuix `textureBlur`），逐像素计算厚度场与色散；
- Pineapple 跑在 Electron 里，只能拆成**两层**：底栏轨道用 WebGL2 玻璃（apple-liquid-glass-webgl），气泡用 CSS + SVG `feDisplacementMap` 近似；
- 因此「1:1」在像素级别不可能，只能做到**结构、尺寸、动效曲线、着色规则一致**，材质是近似。

---

## 1. HeyBox-LiquidGlass（小黑盒）

仓库：`sjtt2/HeyBox-LiquidGlass` · LSPosed 模块（libxposed API 102）· Android 13+

### 1.1 它是怎么「接管」底栏的

```
Hook Instrumentation.callActivityOnResume
  └─ MainActivity 布局手术：
       fl_container 解除底部约束（内容延伸到屏幕底）
       rg_main / vg_tips / vg_mid_tab 迁入玻璃容器
       └─ API 33+：挂载 LiquidGlassTabBar
            ├─ 原 RadioGroup 隐藏保留（选中状态机制照常工作）
            ├─ 点击玻璃滴 → rb.performClick() → 应用原生切页
            ├─ 应用内切页 → RadioGroup 监听（反射包装）→ 液滴滑动
            └─ 发布按钮 → 复用原 vg_mid_tab，居中于预留空位
```

关键点：**它不是重写底栏，而是把原底栏的 View 搬进一个玻璃容器**，并保留 `RadioGroup` 作为唯一状态源。玻璃只是「皮肤 + 手势层」。

### 1.2 渲染管线

`res/raw/liquidglass_effect.txt` 是一段 AGSL（Android Graphics Shader Language）运行时着色器，单 pass 完成：

| 步骤 | 做法 |
|---|---|
| 形状 | `sdRoundedRect()` —— 圆角矩形 SDF，四角半径可分别给 |
| 厚度 | 只在 `-sd < refractionHeight` 的边缘带里做折射，中间是平的 |
| 折射 | `d = circleMap(1 - (-sd)/refractionHeight) * refractionAmount`，沿 SDF 梯度偏移采样坐标 |
| 色散 | `dispersion = chromaticAberration * (x*y / halfW*halfH)`，然后 **7 个通道** 分别按 `1, 2/3, 1/3, 0, -1/3, -2/3, -1` 倍偏移采样（R/O/Y/G/C/B/P），再合成 |
| 高光 | 重力传感器决定光位（README 的「重力传感器高光」） |

### 1.3 参数（README 表格 + 代码）

| 参数 | 值 | 位置 |
|---|---|---|
| 折射强度 / 边缘带 | 60dp / 16dp | `attachQwea0TabBar()` |
| 色散强度（tabBar） | **0.12** | `setDispersionStrength(0.12f)` |
| 气泡色散 | **0.35**、`BLUR_RADIUS 1.2`、`REFRACTION_HEIGHT 20dp`、`DEPTH_EFFECT 0.3` | `applyQmParams()` |
| 中央空隙权重 | 1.3 | `CENTER_GAP_WEIGHT` |
| 自适应单项宽度上限 | 96dp | `FIT_TAB_MAX_WIDTH_DP` |
| 选中 / 未选中权重 | 1.4 / 0.9 | `SELECTED_TAB_WEIGHT` / `OTHER_TAB_WEIGHT` |

> 气泡色散 ≈ 底栏的 **2.9 倍**，这是「大色散只在气泡里」的原始出处。

### 1.4 液滴动效

`popChild()`（点击/选中变化时）：

- `scale 1 → 1.16`，**90ms**，`OvershootInterpolator(0.6)`
- `1.16 → 1`，**240ms**，`OvershootInterpolator(2.2)`
- `pivot (50%, 62%)`

位置/宽度（`FIT_ANIM_MS = 380`）：

- 位置：**380ms + OvershootInterpolator(1.1)**
- 宽度：`380 - 40 = 340ms + DecelerateInterpolator(1.6)`
- 宽度先于位置收尾，所以气泡看起来是「先胖起来再滑到位」

### 1.5 裁剪与边界

`LiquidGlassHostLayout.onDraw` 里 `c.clipRect(0, 0, w, h)` 只裁**背景采样区域**；玻璃本身画在宿主 layout 的边界内，靠 `barOffsetDp = 16` 预留了气泡外溢的空间。玻璃容器 `overflow` 不裁剪。

### 1.6 降级

Android 13 以下没有 `RuntimeShader`，自动退回 `drawLegacyFrost()`：`StackBlur.blur(region, 3)` + `drawRoundRect` 三层（背景 / tint / gloss）+ 描边。

---

## 2. KernelSU Manager

仓库：`tiann/KernelSU` · Compose · Miuix / Material 双主题

### 2.1 页面切换：HorizontalPager

`manager/.../MainActivity.kt`：

```kotlin
import androidx.compose.foundation.pager.HorizontalPager
...
HorizontalPager(state = mainPagerState.pagerState, ...)
```

**页面是左右滑动的**（可拖拽、可 fling），底栏 `onSelected` 调 `mainState.animateToPage(index)`，两者双向同步。

### 2.2 两种底栏

`BottomBarMiuix.kt`：

| 开关 | 渲染 |
|---|---|
| `enableFloatingBottomBar = false` | `BlurredBar` + Miuix `NavigationBar`（贴底、不悬浮） |
| `enableFloatingBottomBar = true` | `FloatingBottomBar`（悬浮胶囊） |

悬浮模式的内边距：`start/end = 28dp`，`bottom = 8dp + navInset`（无 inset 时 28dp）；每个 item `defaultMinSize(minWidth = 76dp)`。

### 2.3 FloatingBottomBar 的关键数值

| 项 | 值 |
|---|---|
| 按下缩放 | `pressedScale = 78f / 56f ≈ 1.393` |
| 拖出边界的橡皮筋 | `rubberBandPx = 4dp`（整个面板轻微位移，`EaseOut`） |
| 回弹 | `spring(1f, 300f, 0.5f)` |
| 指示器高光 | `iosIndicatorSpecular`：`width 1dp`、`Color.White.copy(alpha = 0.12f)`、`innerBlurRadius 2dp` |
| 光位 | 重力方向；静止参考 `LIGHT_REF (0.5, 0.7)`，倾角阈值 `|g| > 0.1`（≈6°），角度量化 3° |
| 容器色 | `surfaceContainer.copy(alpha = 0.4f)`（开启 blur）否则 `surfaceContainer` |

### 2.4 指示器内的「变色」是怎么做的

这是最容易实现错的一点。`BottomBarMiuix.kt` 的注释：

> Icon and label take `LocalContentColor` so the `FloatingBottomBar` backdrop copy can recolor them to the accent tone inside the indicator pill.

也就是说：**不是给 tab 的图标上色，而是指示器胶囊内部有一份内容副本**，那份副本用 `MiuixTheme.colorScheme.primary`（accent）重绘。胶囊外仍是 `onSurface`。视觉结果就是「气泡滑到哪，哪一格的图标/文字变主题色」。

### 2.5 底栏的玻璃

`isBlurEnabled` 时走 Miuix 的 `Backdrop` + `layerBackdrop`（`Modifier.layerBackdrop(backdrop)`），容器色降到 40% 透明度；关掉后是不透明 `surfaceContainer`。

---

## 3. Pineapple Music（本项目）

### 3.1 结构

```
<nav class="dock">                 // 底部悬浮定位，left 50% / bottom 18px
  <div class="bar">                // 玻璃轨道（WebGL），border-radius 31px，padding 0 6px
    <span class="pill" />          // 气泡：绝对定位在 .bar 层（不在滚动容器里）
    <div class="track">            // 横向滚动容器（overflow-x auto）
      <div class="strip">
        <button class="tab">…</button> × 6
      </div>
    </div>
  </div>
  <button class="random" />        // 独立的「随机」胶囊
</nav>
```

对应文件：

- `src/renderer/src/components/BottomBar.tsx`
- `src/renderer/src/components/BottomBar.module.css`
- `src/renderer/src/components/LiquidDropletFilter.tsx`

### 3.2 材质：两层，不是一层

| 层 | 技术 | 参数 |
|---|---|---|
| 轨道 | `apple-liquid-glass-webgl`（WebGL2，SDF 折射） | `refraction 84`、`edgeReach 0.16`、`edgeWidth 0.22`、`dispersion 0.12`、`rim 0.3`、`reflection 0.34`、`highlight 0.4`、`lightAngle 136`、`tint 0.34`、`frost 0.2`、`maxDpr 1.5` |
| 气泡 | CSS + SVG filter（`feDisplacementMap`） | 位移图 `scale 46`、RGB 各偏移 **±1.6px**、`feGaussianBlur 3px`、底色 `rgba(255,255,255,.10)`、描边 `.14` |

为什么分两层：

- 轨道是固定的胶囊，变形需求低 → 可以交给 WebGL 拿真折射；
- 气泡要跟随指针做 `scaleX/scaleY/skew` 的连续变形，WebGL 形状无法跟随 CSS transform，只能走「CSS 元素 + backdrop-filter」。

### 3.3 尺寸与几何

| 量 | 值 | 依据 |
|---|---|---|
| 底栏高 | 62px | HeyBox / KSU 的 62dp |
| 气泡高 | 48px | 同上 |
| tab 宽 | 86px | HeyBox 的 tabWidth 86dp |
| 内边距 | 6px | 同上 |
| 气泡左右 inset | 4px | 同上 |
| 气泡左右位置 | 相邻 tab 之间线性插值 | HeyBox `rawLeftPx` 同算法 |
| 越界 | 允许 0.3 格，位移按 **0.25** 阻尼 | HeyBox `EDGE_DAMPING` |

### 3.4 动效

| 行为 | 实现 | 参数 |
|---|---|---|
| 静止切换 | CSS transition | 位置 380ms `cubic-bezier(.18,1.3,.36,1)`；宽度 340ms `cubic-bezier(.12,.75,.2,1)` |
| 拖动 | `transition: none`，逐帧跟手 | `progress = startProgress + dx / avgTabWidth` |
| 速度形变 | `stretch = clamp(|v|*0.08, 0, 0.14)` | `scaleX 1+stretch`、`scaleY 1-0.25*stretch` |
| 松手 | `Math.round(progress)` 吸附 + 切换 | 变了才 `activate()` |
| 点击 | WAAPI `scale` 动画 | `1 → 1.16`（27% 处）→ `1`，330ms |

### 3.5 着色

`proximity = 1 - |progress - index|`，颜色从 `rgba(255,255,255,0.62)` 插值到主题主色 `#fa243c`（`--accent`），图标 `scale 1 + proximity*0.08`，标签 `distance < 0.45` 时加粗。这是 KSU `LocalContentColor` recolor 的等价近似。

### 3.6 边界裁剪的根因与现状

**根因**：`.track { overflow-x: auto; overflow-y: hidden }` 是滚动容器，CSS 规范要求它能裁剪内容；气泡原本在 `.strip` 内，越界（`left < 0`）就被裁掉。

**现状**：气泡已移出 `.track`，挂在 `.bar` 层，坐标减去 `track.scrollLeft`；`.bar` 设 `overflow: visible`。实测最左 `x=490`、最右 `x=932`，气泡完整。

### 3.7 页面切换

- `store.setView()` 计算 `navDirection: 'left' | 'right'`（`order()` 里 `settings=5`、`album=recent`、`artist=artists`）；
- `App.tsx` 映射到 `viewSwapLeft` / `viewSwapRight`；
- `base.css` 的 keyframes 是 `translate3d(±38px, 0, 0)`，**只有 X 轴**。

---

## 4. 三方逐项对比

| 维度 | HeyBox-LiquidGlass | KernelSU | Pineapple（现状） |
|---|---|---|---|
| 平台 | Android 13+ / LSPosed | Android / Compose | Electron / Chromium |
| 底栏容器 | 玻璃容器包住原 RadioGroup | Compose 绘制 | WebGL canvas + DOM |
| 气泡渲染 | AGSL 着色器（真折射 + 7 通道色散） | Miuix backdrop（blur + 高光） | SVG 位移 + RGB 错位（近似） |
| 底栏色散 | 0.12 | 无（blur 为主） | **0.12** |
| 气泡色散 | **0.35**（≈2.9×） | 无（靠 blur + specular） | RGB ±1.6px + blur 3px |
| 气泡形状 | 圆角矩形 SDF（随 tab 宽度） | `CircleShape` 胶囊（随 tab） | 胶囊 78×48（随 tab 宽度插值） |
| 按下反馈 | 液滴滑动 + 拉伸 | `pressedScale 1.393` | pop `scale 1.16` |
| 拖动 | 支持，吸附 | 支持，`rubberBand 4dp` + `spring(1,300)` | 支持，`0.25` 阻尼 + `round` 吸附 |
| 高光 | 重力传感器 | 重力传感器（6° 阈值、3° 量化） | 无（桌面无传感器） |
| 选中着色 | 应用原生主题 | `LocalContentColor` → accent 重绘 | `proximity` → `#fa243c` |
| 边界 | 宿主预留 `barOffsetDp 16` | 橡皮筋位移 | 气泡在滚动容器外 + scrollLeft 补偿 |
| 翻页 | 调 `RadioGroup`（无动画） | `HorizontalPager`（左右，可拖） | `viewSwap` X 轴 ±38px（仅动画） |
| 降级 | API<33 用 StackBlur | 无 blur 时纯色 | 无 WebGL2 时 CSS 磨砂 |

---

## 5. 差异归因

### 5.1 平台决定、无法消除

1. **没有 AGSL**：Android 的 `RuntimeShader` 可以在一次绘制里逐像素算 SDF 厚度、Snell 折射、7 通道色散；Chromium 的 `backdrop-filter` 只接受 blur/saturate 和受限的 SVG filter，WebGL 又读不到 DOM 像素。
2. **没有重力传感器**：两台 Android 的 specular 高光跟设备倾斜走；桌面只能用鼠标位置或固定光角（现用 `lightAngle 136`）。
3. **WebGL 形状不跟 CSS transform**：所以气泡必须是 DOM 元素，材质只能用 SVG filter 近似。

### 5.2 我自己的实现偏差（已修正）

| 问题 | 偏差 | 修正 |
|---|---|---|
| 每格挂水滴 | 把「一颗气泡」做成了「六个装饰」 | 恢复「一条胶囊 + 一颗气泡」 |
| 气泡无模糊 | 只有位移折射 | 加 `feGaussianBlur 3px` |
| 气泡无色散 | 单调灰块 | RGB ±1.6px + screen 合成 |
| 底栏色散过大 | 0.35 | 降到 **0.12** |
| 气泡被裁 | 画在滚动容器里 | 移出 `.track` + `scrollLeft` 补偿 |
| 无点击放大 | 缺 `popChild` | WAAPI `1→1.16→1` |
| 只变白不变色 | 未接主色 | 插值到 `--accent #fa243c` |
| 页面上下滑 | `translate3d(0, ±34px)` | 改 `translate3d(±38px, 0)` |
| 从设置页切出无方向 | `order()` 未编号 | `settings=5`、`album=recent`、`artist=artists` |

---

## 6. 仍然存在的近似（诚实清单）

1. **色散是位移近似**，不是按波长/IOR 计算；高对比边缘可见 1–2px 彩边，渐变背景几乎看不出。
2. **气泡没有 specular 高光**（被明确要求去掉）；KSU 的原版是有的（1dp、白 12%、内模糊 2dp）。
3. **气泡没有 mip 链模糊**，只有单次高斯；原版是可变半径的多级模糊。
4. **图标没有 selected/unselected 两套**（原版有 filled/outlined 切换）。
5. **翻页只是入场动画**，没有 `HorizontalPager` 那种跟手拖拽 + fling（要做得改页面容器为可拖拽轨道）。
6. **无通知避让**（HeyBox 有：提示条自动抬到玻璃栏上方）。

---

## 7. 若要继续逼近 1:1，可行路径

| 方案 | 能拿到什么 | 代价 |
|---|---|---|
| A. 气泡改由 `LiquidGlassWebGL` 直接绘制（`targets` 或自绘形状） | 真折射、真色散、边缘光学 | 失去 CSS 变形；每帧要重算形状参数，拖动跟手需要自建几何插值 |
| B. SVG filter 增加 7 通道色散 + 内 specular 层 | 色散更接近原版，接近零成本 | 仍是近似，且 filter 链变长会掉帧 |
| C. 页面容器改横向可拖拽 pager（finger-follow + fling） | 真正「左右滑动翻页」 | 需要重写滚动/手势，和现有 View Transition 冲突 |
| D. 鼠标位置模拟重力光位 | 桌面上的「会随指针动的高光」 | 用户已表示不要高光，暂不适用 |

---

## 8. 结论

- **HeyBox** 的核心不是「玻璃参数」，而是「保留原生底栏状态 + 玻璃只做皮肤」这一架构；液滴的位置/宽度/弹性都来自原底栏的真实布局。
- **KSU** 的核心是「`HorizontalPager` 与底栏双向同步」+「指示器内内容副本 recolor」，材质交给 Miuix backdrop。
- **Pineapple** 现在做到了：结构（胶囊 + 单气泡）、尺寸（62/48/86/6/4）、动效曲线（380/340、0.25 阻尼、0.08 速度系数、1.16 pop）、着色（proximity → accent）、边界（气泡在滚动容器之外）、翻页（X 轴）。
- 剩下的差距集中在**像素级材质**：真 IOR 色散、多级模糊、传感器高光。这三项需要在 Electron 里自建 WebGL 后处理，不是改几个 CSS 值能到的。
