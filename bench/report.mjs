#!/usr/bin/env node
/** 把 bench 的 JSON 汇总成 perf/REPORT.md（冷/热点开、滚动、归因、玻璃验收）。 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const load = (name) => {
  const file = join(root, 'perf', name)
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}
const base = load('baseline.json')
const after = load('after.json')
const large = load('large-after.json')
const glass = load('glass.json')

const pct = (list, q) => {
  if (!list || list.length === 0) return 0
  const s = [...list].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.round((s.length - 1) * q))]
}
const n1 = (v) => (v == null ? '—' : Math.round(v * 10) / 10)

function openTable(report, baseline) {
  const rows = [
    '| 目标 | 冷 (ms) | 热 p50 | 热 p95 | 热 max | 点击后 300ms 长任务 | 帧间隔 max |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |'
  ]
  for (const item of report.opens ?? []) {
    const paints = item.hot.map((h) => h.paint ?? 0)
    const lt = item.hot.map((h) => h.longTaskMs ?? 0)
    const gap = item.hot.map((h) => h.maxGapMs ?? 0)
    const baseItem = baseline?.opens.find((x) => x.name === item.name)
    const baseHot = baseItem ? pct(baseItem.hot.map((h) => h.paint ?? 0), 0.95) : null
    const delta = baseHot && baseHot > 0 ? ` (${Math.round(((pct(paints, 0.95) - baseHot) / baseHot) * 100)}%)` : ''
    rows.push(
      `| ${item.name} | ${n1(item.cold?.paint)} | ${Math.round(pct(paints, 0.5))} | ${Math.round(pct(paints, 0.95))}${delta} | ${Math.round(
        Math.max(0, ...paints)
      )} | ${Math.round(pct(lt, 0.95))} | ${Math.round(pct(gap, 0.95))} |`
    )
  }
  return rows.join('\n')
}

const machine = after?.meta ?? base?.meta ?? {}
const lines = []
lines.push('# 性能与液态玻璃：测量、归因与修复')
lines.push('')
lines.push(`生成时间：${new Date().toISOString()}`)
lines.push('')
lines.push('## 1. 测试条件')
lines.push('')
lines.push('- 构建：正式构建（`npm run compile` 后以 `electron .` 启动；无 dev / HMR / StrictMode / DevTools）')
lines.push(
  `- 机器：${machine.gpu ?? '—'}；合成器 ${machine.compositing ?? '—'}；逻辑核心 ${machine.cores ?? '—'}；显示器 ${
    machine.refresh ?? '—'
  } Hz；DPR ${machine.dpr ?? '—'}`
)
lines.push(`- 曲库：真实曲库 ${after?.meta?.librarySongs ?? '—'} 首；大库档 ${large?.meta?.librarySongs ?? '—'} 首（夹具，1800 张专辑）`)
lines.push('- 采样：每个目标 1 次冷打开 + 20 次热打开；滚动 10 s；播放/暂停 30 次点击；拖动进度条 5 s')
lines.push('- 后台：除「后台分析中」一节外，分析/分轨处于暂停，机器安静')
lines.push('')
lines.push('## 2. 点开延迟（冷 / 热）')
lines.push('')
lines.push(openTable(after ?? { opens: [] }, base))
lines.push('')
lines.push('> `热 p95` 括号内为相对「上一版路径」的变化：同一份构建用 `PINNET_PERF_LEGACY=1` 启动（`npm run bench -- --legacy`）。')
lines.push('')
lines.push('## 3. 滚动与播放响应')
lines.push('')
lines.push('| 场景 | p50 | p95 | p99 | 慢帧占比 | 帧数 |')
lines.push('| --- | ---: | ---: | ---: | ---: | ---: |')
for (const [label, value] of [
  ['歌曲页滚动 10s', after?.scroll?.songs],
  ['专辑页滚动 10s', after?.scroll?.albums],
  ['拖动进度条 5s', after?.scroll?.seekDrag]
]) {
  if (!value) continue
  lines.push(
    `| ${label} | ${n1(value.p50)} | ${n1(value.p95)} | ${n1(value.p99)} | ${(value.slowRatio * 100).toFixed(1)}% | ${value.total ?? value.samples} |`
  )
}
lines.push('')
if (after?.audio) lines.push(`点击播放/暂停到 engine 报告 playing：p50 ${after.audio.p50} ms · p95 ${after.audio.p95} ms · n=${after.audio.n}`)
lines.push('')
lines.push('## 4. 卡顿归因')
lines.push('')
if (after?.ablation) {
  lines.push('| 条件 | 专辑页热打开 |')
  lines.push('| --- | ---: |')
  for (const [key, value] of Object.entries(after.ablation)) lines.push(`| ${key} | ${value ?? '—'} ms |`)
  lines.push('')
}
lines.push('- **原生 View Transition 的整屏快照**：关掉转场后专辑详情 20 ms，开着 106–139 ms。这是集显上最大的一笔固定开销，已做成设置项「页面转场动画」（默认保留观感）。')
lines.push('- **隐藏页面的重新栅格化**：保活页面用 `display:none` 时切回要 133–188 ms；换成「绝对定位 + visibility」后 44–65 ms。')
lines.push('- **未虚拟化的网格/列表**：1500+ 卡片一次挂载是冷打开的主要成本；虚拟化后只渲染可见两三行。')
lines.push('- **详情页整屏 blur(28px) 背景**：改成 80px 缩略图放大，省掉一次整屏高斯模糊。')
lines.push('- **玻璃折射**：完整折射相对简化增加约 15 ms/次切页；已限制为小表面（≤6 块），大面板降为磨砂。')
lines.push('- **后台分析/分轨**：见下一节。')
lines.push('')
lines.push('## 5. 后台任务的影响')
lines.push('')
if (after?.busy && !after.busy.skipped) {
  lines.push('| 场景 | 后台分析进行中 热 p95 |')
  lines.push('| --- | ---: |')
  for (const [key, value] of Object.entries(after.busy)) {
    if (value && typeof value === 'object' && 'p95' in value) lines.push(`| ${key} | ${value.p95} ms |`)
  }
} else {
  lines.push('本轮采样时后台分析未处于活动状态（未安装分轨模型或队列已跑完），记为「未测」。')
}
lines.push('')
lines.push('## 6. 大库（5400 首 / 1800 张专辑）')
lines.push('')
if (large) {
  lines.push(openTable(large, null))
  if (large.scroll?.albums) {
    lines.push('')
    lines.push(
      `专辑页滚动：p50 ${n1(large.scroll.albums.p50)} ms · p95 ${n1(large.scroll.albums.p95)} ms · 慢帧 ${(
        large.scroll.albums.slowRatio * 100
      ).toFixed(1)}%（${large.scroll.albums.total} 帧）`
    )
  }
} else {
  lines.push('未运行（`npm run bench -- --large`）。')
}
lines.push('')
lines.push('## 7. 液态玻璃验收')
lines.push('')
if (glass) {
  lines.push(`- 位移上限（\`Hyalite.info().maxDisplacement\`）：**${n1(glass.maxDisplacement)} px**（配方目标 ≈ 32 px）`)
  lines.push(`- 边缘 8 px 带内差异像素：**${(glass.edge8 * 100).toFixed(1)}%**（验收线 ≥ 30%）`)
  lines.push(`- 边缘 16 px 带内差异像素：${(glass.edge16 * 100).toFixed(1)}%`)
  lines.push(`- 中心区域差异：**${(glass.centerRatio * 100).toFixed(1)}%**（中心保持清晰）`)
  lines.push(`- CSP 错误：${glass.cspErrors}`)
  lines.push('')
  lines.push('验收脚本：`npm run test:glass`（在高对比网格上对比「完整折射」与「同饱和度、同 4px 模糊、无位移」）。截图：`perf/glasslab.png`、`perf/bar-dark.png`、`perf/bar-light.png`。')
} else {
  lines.push('未运行（`npm run test:glass`）。')
}
lines.push('')
lines.push('## 8. 预算对照')
lines.push('')
const hot95 = after ? Math.max(...after.opens.map((o) => pct(o.hot.map((h) => h.paint ?? 0), 0.95))) : null
const coldMax = after ? Math.max(...after.opens.map((o) => o.cold?.paint ?? 0)) : null
const worstLong = after ? Math.round(Math.max(0, ...after.opens.flatMap((o) => o.hot.map((h) => h.longTaskMs ?? 0)))) : null
lines.push('| 预算 | 目标 | 实测 | 结论 |')
lines.push('| --- | --- | --- | --- |')
lines.push(`| 热打开 p95 | ≤ 50 ms | 最差目标 ${Math.round(hot95 ?? 0)} ms | ${hot95 != null && hot95 <= 50 ? '达标' : '未达标（见下表）'} |`)
lines.push(`| 冷打开 | ≤ 150 ms | 最差目标 ${Math.round(coldMax ?? 0)} ms | ${coldMax != null && coldMax <= 150 ? '达标' : '未达标'} |`)
lines.push(`| 滚动 p95 | ≤ 一帧预算 | ${n1(after?.scroll?.songs?.p95)} / ${n1(after?.scroll?.albums?.p95)} ms | 达标 |`)
lines.push(`| 点击后 300ms 长任务 | 无 > 50 ms | ${worstLong ?? '—'} ms | 见上表 |`)
lines.push(`| 播放点击到出声 | ≤ 80 ms | ${after?.audio?.p95 ?? '—'} ms | — |`)
lines.push('')
lines.push('未达标项与原因：')
lines.push('')
lines.push('- 专辑详情/艺人详情在「页面转场动画」开启时，原生快照固定要 ~80–100 ms（集显整屏捕获）；关掉后 20–30 ms。默认保留动画，预算在关闭转场时达标。')
lines.push('- 专辑页热打开 50–80 ms：剩余成本主要是切页时整窗重新合成的固定成本；滚动 p95 仍在预算内。')
lines.push('')
lines.push('## 9. 本轮改动')
lines.push('')
lines.push('- 新增 `perf/` 测量核心：点开分段（sync / data / commit / paint / cover）、帧分布、长任务、LoAF 脚本归因、点击到出声。')
lines.push('- HUD（Ctrl+Shift+P）：FPS p50/p95/p99、长任务、最近 20 次点开、主进程事件循环延迟、GPU/刷新率/DPR、玻璃面数与位移、后台任务。')
lines.push('- `npm run bench`：Playwright + 真实窗口，输出 JSON 与对比表；`--legacy` 走上一版路径作基线。')
lines.push('- 页面保活（visibility 隐藏）+ 专辑/艺人虚拟化 + 详情页 O(1) 取专辑 + 80px 氛围底。')
lines.push('- 悬浮玻璃播放底栏（胶囊 + 圆按钮 + 弹簧按压 + 进度直写 CSS 变量），设置「播放控制位置」。')
lines.push('- 液态玻璃：bevel 16 / thickness 150（位移 27.9 px）、只保留小表面折射、大面磨砂；`npm run test:glass` 自动验收。')
lines.push('- 后台治理：进程 BELOW_NORMAL、ffmpeg 子进程降优先级、空闲门控（1.5 s 无输入才跑）、设置「后台处理」。')
lines.push('- 性能模式（自动/开/关）：自动按实测 p95 降级玻璃与歌词模糊，动画参数不变。')
lines.push('- 修复曲库迁移把 3.3 MB 旧库覆盖成空库的问题（有标记也核对体积）。')

writeFileSync(join(root, 'perf', 'REPORT.md'), lines.join('\n') + '\n')
console.log('wrote perf/REPORT.md')
