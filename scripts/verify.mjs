import { _electron as electron } from 'playwright'
import { mkdirSync, existsSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve('.')
const shotsDir = join(root, 'screenshots')
if (!existsSync(shotsDir)) mkdirSync(shotsDir, { recursive: true })

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS

// A throwaway Chromium profile keeps each verification run deterministic (empty library first).
const profile = join(process.env.TEMP ?? root, `lm-verify-${Date.now()}`)
const app = await electron.launch({
  args: ['.', `--user-data-dir=${profile}`],
  cwd: root,
  env,
  timeout: 120000
})
const mainLog = []
app.process().stdout?.on('data', (d) => mainLog.push(String(d)))
app.process().stderr?.on('data', (d) => mainLog.push(String(d)))

const page = await app.firstWindow({ timeout: 120000 })
const errors = []
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text())
})
page.on('pageerror', (err) => {
  errors.push(err.message)
  console.log('[pageerror]', err.message)
})
page.on('console', (msg) => {
  if (msg.type() === 'error') console.log('[console.error]', msg.text().slice(0, 200))
})

await app.evaluate(({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows()[0]
  win.setBounds({ x: 10, y: 10, width: 1280, height: 800 })
})

const shot = async (name, clip) => {
  await page.waitForTimeout(430)
  await page.screenshot({ path: join(shotsDir, `${name}.png`), clip })
  console.log('shot', name)
}

const NAV = { 最近添加: 'recent', 艺人: 'artists', 专辑: 'albums', 歌曲: 'songs', 设置: 'settings' }
const closePanels = async () => {
  // Escape unwinds overlays one at a time (info → menu → fullscreen → queue → lyrics)
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Escape').catch(() => {})
    await page.waitForTimeout(120)
  }
}

const goto = async (label) => {
  await closePanels()
  await page.locator(`[data-nav="${NAV[label]}"]`).click()
  await page.waitForTimeout(450)
}

const search = async (text) => {
  const input = page.locator('input[placeholder="搜索"]')
  await input.fill(text)
  await page.waitForTimeout(500)
}

const setGlass = async (value) => {
  await goto('设置')
  await page.locator(`[data-segment="${value}"]`).first().click()
  await page.waitForTimeout(1000)
  const applied = await page.evaluate(() => document.documentElement.dataset.glass)
  if (applied !== value) console.log('WARN glass not applied:', applied, 'expected', value)
}

const setTheme = async (value) => {
  await goto('设置')
  await page.locator(`[data-segment="${value}"]`).first().click()
  await page.waitForTimeout(800)
}

await page.waitForSelector('text=添加你的音乐', { timeout: 30000 })
await setTheme('light')
await goto('最近添加')
await shot('01-empty-light')

// ---- import the fixture library through the same IPC the folder picker uses
const addResult = await page.evaluate(async (dir) => {
  try {
    await window.lm.invoke('library/addFolder', dir)
    return 'ok'
  } catch (err) {
    return String(err)
  }
}, join(root, 'fixtures'))
console.log('addFolder:', addResult)
await page.waitForFunction(
  async () => {
    const snapshot = await window.lm.invoke('library/snapshot')
    return snapshot.songs.length > 0
  },
  { timeout: 60000 }
)

// wait for stage-1 analysis (BPM / LUFS / silence) to finish for every song
// Poll the main-process queue: the DOM can transiently read "ready" before the first batch lands.
for (let i = 0; i < 90; i++) {
  const progress = await page.evaluate(() => window.lm.invoke('analysis/progress'))
  if (progress.total > 0 && progress.done >= progress.total) {
    console.log('analysis complete', progress.done, '/', progress.total, 'failures', progress.failures.length)
    break
  }
  await page.waitForTimeout(2000)
}
await page.waitForTimeout(1200)
console.log('after scan:', (await page.locator('body').innerText()).slice(0, 80).replace(/\n/g, ' | '))

await shot('02-recent-light')
await goto('歌曲')
await shot('03-songs-light')

await goto('专辑')
await page.evaluate(() => {
  const el = document.getElementById('contentScroll')
  if (el) el.scrollTop = 150
})
await shot('04-albums-scrolled-light')

await page.locator('[data-album-card]').first().click()
await page.waitForTimeout(500)
await shot('05-album-detail-light')

await goto('艺人')
await shot('06-artists-light')

await search('qing')
await shot('07-search-light')
await search('')

// play a song with enhanced (word-level) lyrics
await goto('歌曲')
await search('逐字')
const rows = page.locator('[data-song-row]')
await rows.first().dblclick()
await page.waitForTimeout(2200)
await shot('08-topbar-playing-light')
await shot('08b-topbar-closeup-light', { x: 0, y: 0, width: 1280, height: 66 })

await page.locator('button[title^="歌词"]').first().click()
await page.waitForTimeout(1200)
await shot('09-lyrics-panel-light')

await page.locator('button[title="待播清单"]').first().click()
await page.waitForTimeout(900)
await shot('10-queue-panel-light')

await page.locator('button[title="打开全屏正在播放"]').first().click()
await page.waitForTimeout(1200)
await shot('11-fullscreen-lyrics-light')
await page.keyboard.press('Escape')
await page.waitForTimeout(700)

await page.locator('[data-song-row]').first().click({ button: 'right' })
await page.waitForTimeout(450)
await shot('12-context-menu-light')
await page.getByText('歌曲信息…').click()
await page.waitForTimeout(800)
await shot('13-song-info-light')
await page.keyboard.press('Escape')
await page.waitForTimeout(400)

await goto('设置')
await shot('14-settings-light')

// ---------------- dark
await setTheme('dark')
await shot('15-settings-dark')

await goto('歌曲')
await search('逐字')
await page.locator('[data-song-row]').first().dblclick()
await page.waitForTimeout(2000)
await shot('16-songs-dark')
await shot('16b-topbar-closeup-dark', { x: 0, y: 0, width: 1280, height: 66 })

await page.locator('button[title^="歌词"]').first().click()
await page.waitForTimeout(1200)
await shot('17-lyrics-panel-dark')

await page.locator('button[title="打开全屏正在播放"]').first().click()
await page.waitForTimeout(1300)
await shot('18-fullscreen-lyrics-dark')
await page.keyboard.press('Escape')
await page.waitForTimeout(700)

await search('')
await goto('专辑')
await page.evaluate(() => {
  const el = document.getElementById('contentScroll')
  if (el) el.scrollTop = 150
})
await shot('19-albums-scrolled-dark')
await page.locator('[data-album-card]').first().click()
await page.waitForTimeout(500)
await shot('20-album-detail-dark')

await goto('艺人')
await shot('21-artists-dark')

await search('未命名')
await page.locator('[data-song-row]').first().dblclick()
await page.waitForTimeout(1600)
await page.locator('button[title="打开全屏正在播放"]').first().click()
await page.waitForTimeout(1200)
await shot('22-fullscreen-nolyrics-dark')
await page.keyboard.press('Escape')
await page.waitForTimeout(700)

await search('')
await goto('歌曲')
await page.locator('[data-song-row]').first().click({ button: 'right' })
await page.waitForTimeout(450)
await shot('23-context-menu-dark')
await page.keyboard.press('Escape')

// ---------------- Transition Lab: render a bridge offline and read the numbers
await goto('设置')
await page.getByText('打开 Transition Lab', { exact: false }).first().click()
await page.waitForTimeout(600)
const selects = page.locator('select')
await selects.nth(0).selectOption({ label: 'Loop 100 — 100.0 BPM' }).catch(async () => {
  const options = await selects.nth(0).locator('option').allTextContents()
  const pick = options.find((t) => t.includes('Loop 100'))
  if (pick) await selects.nth(0).selectOption({ label: pick })
})
await selects.nth(1).selectOption({ label: 'Loop 108 — 108.0 BPM' }).catch(async () => {
  const options = await selects.nth(1).locator('option').allTextContents()
  const pick = options.find((t) => t.includes('Loop 108'))
  if (pick) await selects.nth(1).selectOption({ label: pick })
})
await page.waitForTimeout(300)
await page.getByText('离线渲染', { exact: true }).click()
await page.waitForFunction(() => document.body.innerText.includes('级过渡就绪') || document.body.innerText.includes('渲染失败'), { timeout: 90000 })
await page.waitForTimeout(800)
const lab = await page.evaluate(() => {
  const stat = (label) => {
    const nodes = Array.from(document.querySelectorAll('div'))
    const found = nodes.find((n) => n.textContent === label)
    return found?.nextElementSibling?.textContent ?? null
  }
  return {
    status: document.body.innerText.split('\n').find((line) => line.includes('级过渡就绪')) ?? '',
    level: stat('级别'),
    alignment: stat('拍点相位误差'),
    renderMs: stat('渲染耗时'),
    body: document.body.innerText.slice(-320).split('\n').join(' | ')
  }
})
console.log('transition lab', JSON.stringify(lab, null, 1))
await shot('27-transition-lab')

// ---------------- liquid glass: full vs simplified, on identical content
const captureTop = async (name) => {
  const encoded = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1280, height: 72 })
    return image.toPNG().toString('base64')
  })
  writeFileSync(join(shotsDir, `${name}.png`), Buffer.from(encoded, 'base64'))
  const bitmap = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1280, height: 72 })
    return image.toBitmap().toString('base64')
  })
  const glassMode = await page.evaluate(() => document.documentElement.dataset.glass)
  console.log('captured', name, 'glass=', glassMode)
  return Buffer.from(bitmap, 'base64')
}

// With only ten fixtures most pages fit on screen, so shrink the window for this measurement:
// content then overflows and the album grid really does pass under the floating bar.
const albumsUnderBar = async () => {
  await page.locator('[data-nav="albums"]').click()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 520))
  await page.waitForTimeout(500)
  await page.evaluate(() => {
    const el = document.getElementById('contentScroll')
    if (el) el.scrollTop = 300
  })
  await page.waitForTimeout(800)
}

await page.locator('[data-nav="settings"]').click()
await page.waitForTimeout(300)
await page.locator('[data-segment="full"]').first().click()
await page.waitForTimeout(900)
await albumsUnderBar()
const fullBitmap = await captureTop('24-glass-full')

await page.locator('[data-nav="settings"]').click()
await page.waitForTimeout(400)
await page.locator('[data-segment="lite"]').first().click()
await page.waitForTimeout(1200)
await albumsUnderBar()
const liteBitmap = await captureTop('25-glass-simplified')

await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800))
await page.locator('[data-nav="settings"]').click()
await page.locator('[data-segment="full"]').first().click()
await page.waitForTimeout(700)

let changed = 0
let sum = 0
const len = Math.min(fullBitmap.length, liteBitmap.length)
for (let i = 0; i < len; i += 4) {
  const d =
    Math.abs(fullBitmap[i] - liteBitmap[i]) +
    Math.abs(fullBitmap[i + 1] - liteBitmap[i + 1]) +
    Math.abs(fullBitmap[i + 2] - liteBitmap[i + 2])
  sum += d
  if (d > 12) changed++
}
const glassDiff = {
  meanChannelDiff: Math.round((sum / (len / 4) / 3) * 100) / 100,
  changedPixelPct: Math.round((changed / (len / 4)) * 1000) / 10
}
console.log('glass diff', glassDiff)

// ---------------- measurements
await page.waitForTimeout(1500)
const audioState = await page.evaluate(async () => {
  const elements = Array.from(document.querySelectorAll('audio'))
  const snapshot = await window.lm.invoke('library/snapshot')
  return {
    elements: elements.length,
    analyzed: snapshot.songs.filter((s) => s.analysis).length,
    bpm: snapshot.songs.filter((s) => s.analysis).map((s) => `${s.title}:${s.analysis.bpm.toFixed(1)}`),
    playingTitle: document.querySelector('[class*="nowPlaying"] [class*="title"]')?.textContent ?? null
  }
})

const perf = await page.evaluate(async () => {
  const el = document.getElementById('contentScroll')
  if (!el) return null
  const frames = []
  let last = performance.now()
  let running = true
  const tick = (now) => {
    frames.push(now - last)
    last = now
    if (running) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  for (let i = 0; i < 45; i++) {
    el.scrollTop = (i % 2 === 0 ? 1 : 0) * (el.scrollHeight - el.clientHeight)
    await new Promise((r) => setTimeout(r, 33))
  }
  running = false
  const sorted = frames.slice(6).sort((a, b) => a - b)
  const avg = sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length)
  return {
    avgFrameMs: Math.round(avg * 100) / 100,
    p95FrameMs: Math.round(sorted[Math.floor(sorted.length * 0.95)] * 100) / 100,
    estimatedFps: Math.round(1000 / avg)
  }
})

const glass = await page.evaluate(() => {
  const api = window.Hyalite
  const info = api?.info()
  const count = document.querySelectorAll('.glass').length
  const attached = document.querySelectorAll('[data-hyalite-attached]').length
  return {
    supported: api?.supported() ?? false,
    version: api?.version ?? null,
    bevel: info?.bevel ?? null,
    maxDisplacement: info?.maxDisplacement ?? null,
    glassElements: count,
    attached
  }
})

console.log('audio', audioState)
console.log('perf', perf)
console.log('glass', glass)
console.log('errors', errors.slice(0, 8))
writeFileSync(
  join(shotsDir, 'report.json'),
  JSON.stringify(
    { audioState, perf, glass, glassDiff, lab, errors, mainLog: mainLog.join('').slice(-4000) },
    null,
    2
  )
)
await app.close()
console.log('done')
