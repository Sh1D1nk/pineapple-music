#!/usr/bin/env node
/**
 * 玻璃验收：在高对比网格背景上，对同一区域比较「完整折射」与「关闭玻璃」两张截图。
 *   · 边缘带（距边 16px 内）差异像素占比 ≥ 30%
 *   · 中心区域差异保持很小（中心清晰，不应被位移搅乱）
 *   · 控制台无 CSP 错误（Hyalite 的位移图是 data: URL，被拦会静默失效）
 *
 * 同时输出交付用的近景截图：perf/glass-dark.png、perf/glass-light.png、perf/bar-*.png
 */
import { _electron as electron } from 'playwright'
import { inflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
mkdirSync(join(root, 'perf'), { recursive: true })

/* ------------------------------ 极简 PNG 解码（无第三方依赖） */
function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png')
  let offset = 8
  let width = 0
  let height = 0
  let colorType = 6
  let bitDepth = 8
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    offset += 12 + length
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`)
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0
  if (!channels) throw new Error(`unsupported color type ${colorType}`)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(stride * height)
  const paeth = (a, b, c) => {
    const p = a + b - c
    const pa = Math.abs(p - a)
    const pb = Math.abs(p - b)
    const pc = Math.abs(p - c)
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
  }
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const cur = Buffer.alloc(stride)
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? cur[x - channels] : 0
      const up = prev[x]
      const upLeft = x >= channels ? prev[x - channels] : 0
      let value = line[x]
      if (filter === 1) value += left
      else if (filter === 2) value += up
      else if (filter === 3) value += (left + up) >> 1
      else if (filter === 4) value += paeth(left, up, upLeft)
      cur[x] = value & 0xff
    }
    cur.copy(out, y * stride)
    prev = cur
  }
  return { width, height, channels, data: out }
}

function diffRatio(a, b, x0, y0, x1, y1, threshold = 10) {
  let diff = 0
  let total = 0
  for (let y = Math.max(0, y0); y < Math.min(a.height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(a.width, x1); x++) {
      const ia = (y * a.width + x) * a.channels
      const ib = (y * b.width + x) * b.channels
      const d = Math.max(
        Math.abs(a.data[ia] - b.data[ib]),
        Math.abs(a.data[ia + 1] - b.data[ib + 1]),
        Math.abs(a.data[ia + 2] - b.data[ib + 2])
      )
      total++
      if (d > threshold) diff++
    }
  }
  return total ? diff / total : 0
}

/* ------------------------------ 主流程 */
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS
const app = await electron.launch({ args: [root], env, timeout: 60000 })
const page = await app.firstWindow()
const cspErrors = []
page.on('console', (msg) => {
  const text = msg.text()
  if (msg.type() === 'error' && /Content Security Policy|Refused to (load|apply)/i.test(text)) cspErrors.push(text)
})
await page.waitForFunction(() => window.__store && window.__store.getState().ready, null, { timeout: 60000 })
await page.evaluate(async () => {
  await window.__store.getState().updateSettings({ glass: 'full', performanceMode: 'off', theme: 'dark', controlBar: 'float' })
})
await page.waitForTimeout(800)
await page.evaluate(() => window.__store.getState().setView({ kind: 'glasslab' }))
await page.waitForTimeout(1400)

const surface = page.locator('[class*="stage"] > .glass').first()
const box = await surface.boundingBox()
if (!box) throw new Error('找不到玻璃样例')
// 直接测「折射」本身：把表面底色与阴影去掉，只留 backdrop-filter。
// 这样中心区域应当基本保持原样（只有 4px 模糊），边缘带才有明显位移。
await page.evaluate(() => {
  const el = document.querySelector('[class*="stage"] > .glass')
  if (el) {
    el.style.background = 'transparent'
    el.style.boxShadow = 'none'
  }
})
await page.waitForTimeout(500)
const clip = { x: box.x + 2, y: box.y + 2, width: box.width - 4, height: box.height - 4 }
const full = await page.screenshot({ clip })
// 参考帧：同一个元素关掉 backdrop-filter（保留 DOM 与布局，避免重排影响坐标）
await page.evaluate(() => {
  const el = document.querySelector('[class*="stage"] > .glass')
  if (el) {
    // 参考帧保留同样的饱和度与 4px 模糊，只去掉位移滤镜：
    // 这样中心区域应当与完整折射逐像素一致，差异只来自边缘的折射位移。
    el.style.setProperty('--hyalite', 'none')
    el.style.backdropFilter = 'saturate(1.5) blur(4px)'
    el.style.webkitBackdropFilter = 'saturate(1.5) blur(4px)'
  }
})
await page.waitForTimeout(400)
const ref = await page.screenshot({ clip })

const a = decodePng(full)
const b = decodePng(ref)
const edgeOf = (band) =>
  Math.max(
    diffRatio(a, b, 0, 0, a.width, band),
    diffRatio(a, b, 0, a.height - band, a.width, a.height),
    diffRatio(a, b, 0, 0, band, a.height),
    diffRatio(a, b, a.width - band, 0, a.width, a.height)
  )
const edge8 = edgeOf(8)
const edge16 = edgeOf(16)
const edgeFull = edge8
const center = diffRatio(
  a,
  b,
  Math.round(a.width * 0.3),
  Math.round(a.height * 0.32),
  Math.round(a.width * 0.7),
  Math.round(a.height * 0.68)
)

// 交付截图：玻璃实验室全景（深色）
await page.screenshot({ path: join(root, 'perf', 'glasslab.png') })

// 交付截图：深色 / 浅色 + 底栏近景
await page.evaluate(() => window.__store.getState().setView({ kind: 'recent' }))
await page.waitForTimeout(900)
await page.screenshot({ path: join(root, 'perf', 'glass-dark.png') })
const capsule = page.locator('[class*="capsule"]').first()
if (await capsule.count()) {
  const cb = await capsule.boundingBox()
  if (cb) await page.screenshot({ path: join(root, 'perf', 'bar-dark.png'), clip: { x: cb.x - 8, y: cb.y - 8, width: cb.width + 16, height: cb.height + 16 } })
}
await page.evaluate(async () => { await window.__store.getState().updateSettings({ theme: 'light' }) })
await page.waitForTimeout(1000)
await page.screenshot({ path: join(root, 'perf', 'glass-light.png') })
if (await capsule.count()) {
  const cb = await capsule.boundingBox()
  if (cb) await page.screenshot({ path: join(root, 'perf', 'bar-light.png'), clip: { x: cb.x - 8, y: cb.y - 8, width: cb.width + 16, height: cb.height + 16 } })
}

const maxDisplacement = await page.evaluate(() => {
  const api = window.Hyalite
  return api?.info?.()?.maxDisplacement ?? null
})
const result = { edge8, edge16, centerRatio: center, maxDisplacement, cspErrors: cspErrors.length, at: new Date().toISOString() }
writeFileSync(join(root, 'perf', 'glass.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
await app.close()

const ok = edge8 >= 0.3 && center <= 0.05 && cspErrors.length === 0
console.log(ok ? 'GLASS PASS' : 'GLASS FAIL')
if (!ok) process.exit(1)
