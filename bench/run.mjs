#!/usr/bin/env node
/**
 * 点击打开延迟 / 滚动 / 播放响应基准。
 *
 * 只测正式构建（npm run compile 的产物），用 Playwright 的 Electron 支持驱动真实窗口，
 * 读取页面内 __perf 的打点（同一套 HUD 数据），输出 JSON 与对比表。
 *
 * 用法：
 *   npm run bench -- --out perf/after.json
 *   npm run bench -- --legacy --out perf/baseline.json   # 同一构建走「上一版」路径
 *   npm run bench -- --compare perf/baseline.json perf/after.json
 */
import { _electron as electron } from 'playwright'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

const root = join(import.meta.dirname, '..')
const argv = process.argv.slice(2)
const argOf = (name, fallback = null) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] ?? fallback : fallback
}
const legacy = argv.includes('--legacy')
const out = argOf('--out', legacy ? 'perf/baseline.json' : 'perf/after.json')
const quick = argv.includes('--quick')
const large = argv.includes('--large')
const profile = argOf('--profile', large ? join(root, 'perf', 'fixtures-profile') : null)

async function launch() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  delete env.NODE_ENV
  if (legacy) env.PINNET_PERF_LEGACY = '1'
  if (profile) {
    mkdirSync(profile, { recursive: true })
    env.PINNET_USER_DATA = profile
    env.PINNET_NO_MIGRATE = '1'
    env.PINNET_BENCH = '1'
  }
  const app = await electron.launch({
    args: [root],
    env,
    timeout: 120000
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => window.__store && window.__store.getState().ready, null, { timeout: 60000 })
  await page.waitForFunction(() => window.__perf, null, { timeout: 10000 })
  // 让首屏稳定（封面/玻璃/字体）
  await page.waitForTimeout(1200)
  // 统一测试条件：完整折射 + 全开性能模式（最坏情况），后台不因空闲门控而漂移
  await page.evaluate(async () => {
    await window.__store.getState().updateSettings({ glass: 'full', performanceMode: 'off', backgroundProcessing: 'off' })
    await window.lm.invoke('analysis/pause')
  })
  // 大库档：首次运行时把 5400 首夹具导入临时 profile（不动真实曲库）
  if (large) {
    const songs = await page.evaluate(() => window.__store.getState().songIds.length)
    if (songs < 1000) {
      console.log('seeding large fixtures…')
      await page.evaluate(async (dir) => window.lm.invoke('library/addFolder', dir), join(root, 'fixtures', 'large'))
      for (let i = 0; i < 240; i++) {
        await page.waitForTimeout(2000)
        const state = await page.evaluate(() => ({ n: window.__store.getState().songIds.length, scan: window.__store.getState().scan.active }))
        if (!state.scan && state.n > 1000) {
          console.log('indexed songs:', state.n)
          break
        }
        if (i % 15 === 0) console.log('…songs', state.n)
      }
    }
  }
  // 等当前一首的分析跑完，机器安静下来再测
  for (let i = 0; i < 30; i++) {
    const busy = await page.evaluate(async () => (await window.lm.invoke('analysis/progress')).active)
    if (!busy) break
    await page.waitForTimeout(1000)
  }
  await page.waitForTimeout(1200)
  // 准备一条播放队列（全屏/播放按钮需要曲目），随后暂停，避免测试时真的出声
  await page.evaluate(async () => {
    const s = window.__store.getState()
    const id = s.songIds[0]
    if (id && s.playback.queue.length === 0) {
      s.playSongNow(id)
      await new Promise((r) => setTimeout(r, 900))
      if (window.__store.getState().playback.playing) window.__store.getState().togglePlay()
    }
  })
  await page.waitForTimeout(600)
  return { app, page }
}

const readLast = async (page, sinceId = 0) => {
  const opens = await page.evaluate(() => window.__perf.opens())
  return opens.filter((o) => o.id > sinceId)
}

const maxId = async (page) => {
  const opens = await page.evaluate(() => window.__perf.opens())
  return opens.length ? opens[opens.length - 1].id : 0
}

async function waitSettled(page, ms = 320) {
  await page.waitForTimeout(ms)
}

async function clickNav(page, key) {
  await page.evaluate((k) => {
    const el = document.querySelector(`[data-nav="${k}"]`)
    el?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    el?.click()
  }, key)
}

async function statsOf(page, kind) {
  return page.evaluate(() => window.__perf.stats())
}

async function scenarioOpens(page, name, open, close, repeat = 20) {
  const first = await maxId(page)
  await page.evaluate(() => {
    const s = window.__store.getState()
    s.setFullscreen(false)
    s.setLyricsOpen(false)
    s.setQueueOpen(false)
    s.setInfoSongId(null)
    s.setContextMenu(null)
  })
  await page.waitForTimeout(120)
  try {
    await open()
  } catch (err) {
    console.warn('open failed for', name, String(err).slice(0, 120))
    return { name, cold: null, hot: [] }
  }
  await waitSettled(page, 700)
  const cold = (await readLast(page, first))[0] ?? null
  const hot = []
  for (let i = 0; i < repeat; i++) {
    await close()
    await waitSettled(page, 160)
    const mark = await maxId(page)
    await open()
    await waitSettled(page, 200)
    const sample = (await readLast(page, mark)).find((s) => s.paint != null) ?? (await readLast(page, mark))[0]
    if (sample) hot.push(sample)
  }
  return { name, cold, hot }
}

async function main() {
  if (argv.includes('--compare')) {
    const a = JSON.parse(readFileSync(join(root, argOf('--compare', 'perf/baseline.json')), 'utf8'))
    const b = JSON.parse(readFileSync(join(root, argv[argv.indexOf('--compare') + 1] ?? 'perf/after.json'), 'utf8'))
    console.log(compareTable(a, b))
    return
  }

  const { app, page } = await launch()
  const meta = await page.evaluate(() => ({
    version: window.lm ? 'n/a' : 'n/a',
    library: window.__store.getState().songIds.length,
    refresh: window.screen.refreshRate || 60,
    dpr: window.devicePixelRatio,
    ua: navigator.userAgent
  }))
  const mainPerf = await page.evaluate(() => window.lm.invoke('perf/main'))
  const report = {
    meta: {
      generatedAt: new Date().toISOString(),
      legacy,
      librarySongs: meta.library,
      dpr: meta.dpr,
      refresh: mainPerf.display.refresh,
      gpu: `${mainPerf.gpu.vendor} ${mainPerf.gpu.device}`,
      compositing: mainPerf.gpu.feature,
      cores: mainPerf.cores,
      mode: 'production-build (electron .)'
    },
    opens: [],
    scroll: {},
    audio: null,
    longTasks: []
  }

  // 先稳定落到歌曲页，作为「关闭其他目标」的公共落点
  await clickNav(page, 'songs')
  await waitSettled(page, 600)

  const targets = []

  targets.push(
    await scenarioOpens(
      page,
      '歌曲页',
      async () => clickNav(page, 'songs'),
      async () => clickNav(page, 'favorites')
    )
  )
  targets.push(
    await scenarioOpens(
      page,
      '专辑页',
      async () => clickNav(page, 'albums'),
      async () => clickNav(page, 'songs')
    )
  )
  targets.push(
    await scenarioOpens(
      page,
      '艺人页',
      async () => clickNav(page, 'artists'),
      async () => clickNav(page, 'songs')
    )
  )
  targets.push(
    await scenarioOpens(
      page,
      '收藏页',
      async () => clickNav(page, 'favorites'),
      async () => clickNav(page, 'songs')
    )
  )
  targets.push(
    await scenarioOpens(
      page,
      '设置页',
      async () => clickNav(page, 'settings'),
      async () => clickNav(page, 'songs')
    )
  )

  // 专辑详情：点第一张卡片，Esc/返回用侧栏（详情页没有 nav 高亮，点最近添加）
  await clickNav(page, 'albums')
  await waitSettled(page, 500)
  const albumCard = page.locator('.viewPaneActive [data-album-card]').first()
  if (await albumCard.count()) {
    try {
      targets.push(
        await scenarioOpens(
          page,
          '专辑详情',
          async () => {
            await albumCard.click({ position: { x: 40, y: 40 }, timeout: 5000, force: true })
          },
          async () => clickNav(page, 'albums')
        )
      )
    } catch (err) {
      console.warn('skip 专辑详情:', String(err).slice(0, 160))
    }
  }

  await clickNav(page, 'artists')
  await waitSettled(page, 500)
  const artistRow = page.locator('.viewPaneActive [class*="artistRow"]').first()
  if (await artistRow.count()) {
    try {
      targets.push(
        await scenarioOpens(
          page,
          '艺人详情',
          async () => {
            await artistRow.click({ timeout: 5000, force: true })
          },
          async () => clickNav(page, 'artists')
        )
      )
    } catch (err) {
      console.warn('skip 艺人详情:', String(err).slice(0, 160))
    }
  }

  // 歌词面板 / 待播清单（悬浮底栏的两个圆按钮）
  await clickNav(page, 'songs')
  await waitSettled(page, 400)
  const hasFloat = await page.locator('[class*="capsule"]').count()
  const btn = async (title) => page.locator(`button[title^="${title}"]`).first()
  if (hasFloat) {
    targets.push(
      await scenarioOpens(
        page,
        '歌词面板',
        async () => {
          await (await btn('歌词面板')).click()
        },
        async () => {
          await page.evaluate(() => window.__store.getState().setLyricsOpen(false))
        }
      )
    )
    targets.push(
      await scenarioOpens(
        page,
        '待播清单',
        async () => {
          await (await btn('待播清单')).click()
        },
        async () => {
          await page.evaluate(() => window.__store.getState().setQueueOpen(false))
        }
      )
    )
    // 全屏正在播放
    targets.push(
      await scenarioOpens(
        page,
        '全屏正在播放',
        async () => {
          await page.locator('button[title="打开全屏正在播放"]').first().click()
        },
        async () => page.evaluate(() => window.__store.getState().setFullscreen(false))
      )
    )
  }

  // 歌曲信息 / 右键菜单：直接走 store（浮层打开路径与点击一致）
  const firstSongId = await page.evaluate(() => {
    const s = window.__store.getState()
    return s.playback.queue[s.playback.index]?.songId ?? s.songIds[0]
  })
  if (firstSongId) {
    targets.push(
      await scenarioOpens(
        page,
        '歌曲信息',
        async () => page.evaluate((id) => window.__store.getState().setInfoSongId(id), firstSongId),
        async () => page.evaluate(() => window.__store.getState().setInfoSongId(null))
      )
    )
    targets.push(
      await scenarioOpens(
        page,
        '右键菜单',
        async () =>
          page.evaluate((id) => window.__store.getState().setContextMenu({ x: 320, y: 260, songId: id }), firstSongId),
        async () => page.evaluate(() => window.__store.getState().setContextMenu(null))
      )
    )
  }

  report.opens = targets

  // 滚动：歌曲页与专辑页各 10 秒（快速模式 4 秒）
  await clickNav(page, 'songs')
  await waitSettled(page, 500)
  report.scroll.songs = await scrollMeasure(page, quick ? 4000 : 10000)
  await clickNav(page, 'albums')
  await waitSettled(page, 800)
  report.scroll.albums = await scrollMeasure(page, quick ? 4000 : 10000)

  // 播放/暂停点击
  await clickNav(page, 'songs')
  await waitSettled(page, 400)
  const playBtn = page.locator('.floatLayer button[title^="播放"], .floatLayer button[title^="暂停"]').first()
  if (await playBtn.count()) {
    // 预热：第一次播放要等音频解码/加载，属于冷启动，不计入点击响应
    try {
      await playBtn.click({ timeout: 4000 })
      await page.waitForTimeout(1200)
      await playBtn.click({ timeout: 4000 })
      await page.waitForTimeout(400)
      await page.evaluate(() => { const s = window.__perf.audio(); void s })
    } catch {
      /* ignore */
    }
    const clicks = quick ? 10 : 30
    try {
      for (let i = 0; i < clicks; i++) {
        await playBtn.click({ timeout: 4000 })
        await page.waitForTimeout(260)
      }
    } catch (err) {
      console.warn('play clicks stopped early:', String(err).slice(0, 120))
    }
    report.audio = await page.evaluate(() => window.__perf.audio())
  }

  // 拖动进度条 5 秒
  const progress = page.locator('.floatLayer [role="slider"][aria-label="播放进度"]').first()
  if (await progress.count()) {
    await page.evaluate(() => window.__perf.startFrameLog())
    const box = await progress.boundingBox()
    if (box) {
      await page.mouse.move(box.x + 4, box.y + box.height / 2)
      await page.mouse.down()
      const steps = quick ? 12 : 25
      for (let i = 0; i < steps; i++) {
        await page.mouse.move(box.x + 4 + ((box.width - 8) * i) / steps, box.y + box.height / 2)
        await page.waitForTimeout(200)
      }
      await page.mouse.up()
    }
    report.scroll.seekDrag = await page.evaluate(() => window.__perf.stopFrameLog())
  }

  report.longTasks = await page.evaluate(() => window.__perf.longTasks().slice(-10))
  report.stats = await statsOf(page)

  // 后台分析进行中：再测一组热打开，量劣化比例
  report.busy = await runBusy(page)

  // 归因：逐项关掉（玻璃 / 背景）再测一次「专辑页」热打开
  report.ablation = await runAblation(page)

  const file = join(root, out)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(report, null, 2))
  console.log(`\nwrote ${out}`)
  console.log(summaryTable(report))
  await app.close()
}

async function runBusy(page) {
  const result = {}
  await page.evaluate(async () => {
    const s = window.__store.getState()
    await window.__store.getState().updateSettings({ backgroundProcessing: 'always' })
    await window.lm.invoke('analysis/order', s.songIds.slice(0, 120))
    await window.lm.invoke('analysis/resume')
    // 确保分轨也处于可运行状态（有模型才会真的跑）
    await window.lm.invoke('stems/resume').catch(() => undefined)
  })
  await page.waitForTimeout(3500)
  const active = await page.evaluate(async () => (await window.lm.invoke('analysis/progress')).active)
  if (!active) return { skipped: true }
  for (const [name, nav, back] of [
    ['歌曲页', 'songs', 'favorites'],
    ['专辑页', 'albums', 'songs'],
    ['艺人页', 'artists', 'songs']
  ]) {
    const samples = []
    for (let i = 0; i < 8; i++) {
      await clickNav(page, back)
      await page.waitForTimeout(180)
      const mark = await maxId(page)
      await clickNav(page, nav)
      await page.waitForTimeout(320)
      const sample = (await readLast(page, mark))[0]
      if (sample) samples.push(sample.paint ?? 0)
    }
    result[name] = { n: samples.length, p95: Math.round(pct(samples, 0.95)) }
  }
  await page.evaluate(async () => {
    await window.lm.invoke('analysis/pause')
    await window.__store.getState().updateSettings({ backgroundProcessing: 'off' })
  })
  return result
}

async function scrollMeasure(page, ms) {
  await page.evaluate(() => window.__perf.startFrameLog())
  const start = Date.now()
  let direction = 1
  while (Date.now() - start < ms) {
    await page.mouse.wheel(0, direction * 420)
    direction = direction > 0 && Math.random() < 0.12 ? -1 : direction < 0 && Math.random() < 0.3 ? 1 : direction
    await page.waitForTimeout(90)
  }
  return page.evaluate(() => window.__perf.stopFrameLog())
}

async function runAblation(page) {
  const out = {}
  const measure = async () => {
    await clickNav(page, 'songs')
    await page.waitForTimeout(260)
    await clickNav(page, 'albums')
    await page.waitForTimeout(320)
    const mark = await maxId(page)
    await clickNav(page, 'songs')
    await page.waitForTimeout(180)
    await clickNav(page, 'albums')
    await page.waitForTimeout(420)
    const samples = (await readLast(page, mark)).filter((s) => s.key === 'albums' && !s.cold)
    return samples.length ? Math.round(samples[samples.length - 1].paint ?? 0) : null
  }
  out.当前 = await measure()
  const patch = async (value) => {
    await page.evaluate(async (v) => {
      await window.__store.getState().updateSettings(v)
    }, value)
    await page.waitForTimeout(700)
  }
  const original = await page.evaluate(async () => {
    const s = await window.lm.invoke('settings/get')
    return { glass: s.glass, bgEnabled: s.bgEnabled }
  })
  await patch({ glass: 'off' })
  out.glassOff = await measure()
  await patch({ glass: original.glass })
  await patch({ bgEnabled: false })
  out.bgOff = await measure()
  await patch({ bgEnabled: original.bgEnabled })
  return out
}

const avg = (list) => (list.length ? list.reduce((s, v) => s + v, 0) / list.length : 0)
const pct = (list, q) => {
  if (!list.length) return 0
  const s = [...list].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.round((s.length - 1) * q))]
}

function summaryTable(report) {
  const lines = ['目标           冷(ms)  热p50  热p95  热max  长任务(ms)']
  for (const item of report.opens) {
    const paints = item.hot.map((h) => h.paint ?? 0)
    const lt = item.hot.map((h) => h.longTaskMs ?? 0)
    lines.push(
      `${item.name.padEnd(12, ' ')} ${String(item.cold?.paint ?? '—').padStart(6)} ${String(
        Math.round(pct(paints, 0.5))
      ).padStart(6)} ${String(Math.round(pct(paints, 0.95))).padStart(6)} ${String(
        Math.round(Math.max(0, ...paints))
      ).padStart(6)} ${String(Math.round(pct(lt, 0.95))).padStart(9)}`
    )
  }
  const sc = report.scroll
  for (const [key, value] of Object.entries(sc)) {
    if (!value) continue
    lines.push(
      `滚动 ${key}: p50 ${value.p50.toFixed(1)} p95 ${value.p95.toFixed(1)} 慢帧 ${(value.slowRatio * 100).toFixed(1)}%`
    )
  }
  if (report.audio) lines.push(`播放点击 p95 ${report.audio.p95}ms（n=${report.audio.n}）`)
  if (report.busy && !report.busy.skipped) {
    lines.push('后台分析中：' + Object.entries(report.busy).map(([k, v]) => `${k} p95 ${v.p95}ms`).join(' · '))
  }
  return lines.join('\n')
}

function compareTable(a, b) {
  const lines = ['目标            基线冷  现在冷   基线热p95  现在热p95  变化']
  for (const item of b.opens) {
    const base = a.opens.find((x) => x.name === item.name)
    if (!base) continue
    const bh = Math.round(pct(base.hot.map((h) => h.paint ?? 0), 0.95))
    const nh = Math.round(pct(item.hot.map((h) => h.paint ?? 0), 0.95))
    const delta = bh > 0 ? `${(((nh - bh) / bh) * 100).toFixed(0)}%` : '—'
    lines.push(
      `${item.name.padEnd(12, ' ')} ${String(base.cold?.paint ?? '—').padStart(7)} ${String(
        item.cold?.paint ?? '—'
      ).padStart(6)} ${String(bh).padStart(10)} ${String(nh).padStart(10)} ${delta.padStart(6)}`
    )
  }
  return lines.join('\n')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
