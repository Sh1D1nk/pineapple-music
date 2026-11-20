/**
 * 点开延迟与掉帧的测量核心。
 *
 * 目标：在不影响被测对象的前提下，把「按下 → 内容首帧」拆成可归因的分段：
 *   sync    事件回调里同步花掉的时间（setView / startViewTransition 的同步部分）
 *   data    目标页拿到数据的时间（详情页从曲库聚合，或歌词 IPC 返回）
 *   commit  React 提交完成（layout effect 开始）
 *   paint   首次绘制完成（commit 之后双 rAF）
 *   cover   首屏封面解码完成（img.decode()）
 * 同时记录点击后 300ms 内的最长长任务与最大帧间隔。
 *
 * 冷/热按「本次会话内该目标是否第一次打开」区分：冷打开包含首次挂载、首次解码、
 * 首次 GPU 着色器编译；热打开应只剩数据与提交。
 *
 * 这里只做观测，不做任何节流或调度——测量本身必须便宜：一次 rAF 循环、一个
 * PerformanceObserver、一个全局指针时间戳。
 */

export type OpenPhase = 'sync' | 'data' | 'commit' | 'paint' | 'cover'

export interface OpenSample {
  id: number
  key: string
  label: string
  cold: boolean
  /** performance.now() 的时刻：优先取最近一次 pointerdown（真实“按下”），否则取 begin 时刻 */
  origin: number
  sync: number | null
  data: number | null
  commit: number | null
  paint: number | null
  cover: number | null
  /** 点击后 300ms 内累计长任务时长 */
  longTaskMs: number
  /** 点击后 300ms 内最大帧间隔 */
  maxGapMs: number
  /** 点击后 300ms 内超过一帧预算的帧数 */
  slowFrames: number
}

export interface FrameSummary {
  p50: number
  p95: number
  p99: number
  max: number
  fps: number
  samples: number
}

export interface LoafRecord {
  start: number
  duration: number
  renderStart: number
  styleLayout: number
  blocking: number
  scripts: { source: string; duration: number; forcedStyleLayout: number }[]
}

export interface LongTaskRecord {
  start: number
  duration: number
  name: string
}

interface Pending {
  id: number
  key: string
  label: string
  cold: boolean
  origin: number
  sync: number | null
  data: number | null
  commit: number | null
  paint: number | null
  cover: number | null
}

const FRAME_KEEP = 240
/** bench 用的长时间窗：startFrameLog() 开始记录，stopFrameLog() 给出这一段的全部分布 */
const frameLog: number[] = []
let logging = false
const LONG_TASK_KEEP = 40
const OPEN_KEEP = 40
const SLOW_OPEN_TITLE_MS = 300

const frames: number[] = []
const longTasks: LongTaskRecord[] = []
const loafs: LoafRecord[] = []
const opens: OpenSample[] = []
const seen = new Set<string>()
const listeners = new Set<() => void>()

let currentRefreshMs = 1000 / 60
try {
  // Chromium 在渲染进程暴露真实刷新率；拿不到就退回 60。
  const probe = (): void => {
    const hz = (window.screen as Screen & { refreshRate?: number }).refreshRate
    if (typeof hz === 'number' && hz >= 24 && hz <= 480) currentRefreshMs = 1000 / hz
  }
  probe()
} catch {
  /* ignore */
}

/* ------------------------------------------------------------ 帧循环 */

let frameRaf = 0
let lastFrameAt = 0
function frameTick(now: number): void {
  if (lastFrameAt > 0) {
    const dt = now - lastFrameAt
    // 窗口被遮挡 / 断点调试 / 系统睡眠会给出几百毫秒的“帧”，那是假的，不计入分布
    if (dt > 0 && dt < 250) {
      frames.push(dt)
      if (frames.length > FRAME_KEEP) frames.shift()
      if (logging && frameLog.length < 20000) frameLog.push(dt)
    }
  }
  lastFrameAt = now
  frameRaf = requestAnimationFrame(frameTick)
}

if (typeof window !== 'undefined') {
  frameRaf = requestAnimationFrame(frameTick)
  // 窗口不可见时 rAF 本来就会停；恢复时不要把前后两帧算成一个巨大间隔
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      lastFrameAt = 0
      return
    }
    lastFrameAt = 0
    cancelAnimationFrame(frameRaf)
    frameRaf = requestAnimationFrame(frameTick)
  })

  try {
    const po = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const attr = (entry as PerformanceEntry & {
          attribution?: { name?: string; containerType?: string; containerSrc?: string }[]
        }).attribution?.[0]
        longTasks.push({
          start: entry.startTime,
          duration: entry.duration,
          name: attr?.containerSrc || attr?.containerType || attr?.name || 'script'
        })
        if (longTasks.length > LONG_TASK_KEEP) longTasks.shift()
      }
    })
    po.observe({ type: 'longtask', buffered: true } as PerformanceObserverInit)
  } catch {
    /* Safari/旧内核没有 longtask；HUD 会显示 0 */
  }

  // LoAF：长动画帧的脚本级归因（Chromium 123+）。这是定位「点开时到底谁在占主线程」的关键。
  try {
    const po = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const loaf = entry as PerformanceEntry & {
          renderStart?: number
          styleAndLayoutStart?: number
          blockingDuration?: number
          scripts?: { sourceURL?: string; sourceFunctionName?: string; duration?: number; forcedStyleAndLayoutDuration?: number }[]
        }
        loafs.push({
          start: entry.startTime,
          duration: entry.duration,
          renderStart: loaf.renderStart ? loaf.renderStart - entry.startTime : 0,
          styleLayout: loaf.styleAndLayoutStart ? entry.startTime + entry.duration - loaf.styleAndLayoutStart : 0,
          blocking: loaf.blockingDuration ?? 0,
          scripts: (loaf.scripts ?? []).map((script) => ({
            source: `${script.sourceFunctionName || 'anonymous'} @ ${(script.sourceURL || '').split('/').pop()?.slice(0, 32)}`,
            duration: Math.round(script.duration ?? 0),
            forcedStyleLayout: Math.round(script.forcedStyleAndLayoutDuration ?? 0)
          }))
        })
        if (loafs.length > 40) loafs.shift()
      }
    })
    po.observe({ type: 'long-animation-frame', buffered: true } as PerformanceObserverInit)
  } catch {
    /* 旧内核没有 LoAF */
  }
}

/* ------------------------------------------------------------ 指针原点 */

let lastPointerDownAt = 0
let lastPointerType = 'mouse'
if (typeof window !== 'undefined') {
  const mark = (event: Event): void => {
    const pointer = event as PointerEvent
    if (typeof pointer.clientX === 'number') {
      lastPointerDownAt = performance.now()
      lastPointerType = pointer.pointerType || 'mouse'
    }
  }
  window.addEventListener('pointerdown', mark, { capture: true, passive: true })
  window.addEventListener('mousedown', mark, { capture: true, passive: true })
}

/* ------------------------------------------------------------ 输入上报（给主进程的后台调度让路） */

let lastInputSentAt = 0
export function noteInput(): void {
  const now = performance.now()
  if (now - lastInputSentAt < 120) return
  lastInputSentAt = now
  try {
    window.lm?.send('perf/input')
  } catch {
    /* preload 未就绪 */
  }
}
if (typeof window !== 'undefined') {
  const relay = (): void => noteInput()
  window.addEventListener('pointermove', relay, { passive: true, capture: true })
  window.addEventListener('wheel', relay, { passive: true, capture: true })
  window.addEventListener('keydown', relay, { passive: true, capture: true })
  window.addEventListener('pointerdown', relay, { passive: true, capture: true })
}

/* ------------------------------------------------------------ 打开测量 */

let seq = 0
let pending: Pending | null = null

function emit(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      /* ignore */
    }
  }
}

function summarize(values: number[], windowSize = 120): FrameSummary {
  const slice = values.slice(-windowSize)
  if (slice.length === 0) return { p50: 0, p95: 0, p99: 0, max: 0, fps: 0, samples: 0 }
  const sorted = [...slice].sort((a, b) => a - b)
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))]!
  const avg = slice.reduce((sum, v) => sum + v, 0) / slice.length
  return {
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted[sorted.length - 1]!,
    fps: avg > 0 ? 1000 / avg : 0,
    samples: slice.length
  }
}

export function frameSummary(): FrameSummary {
  return summarize(frames)
}

export function frameBudgetMs(): number {
  return currentRefreshMs
}

export function startFrameLog(): void {
  frameLog.length = 0
  logging = true
}

export function stopFrameLog(): FrameSummary & { slowRatio: number; total: number } {
  logging = false
  const all = [...frameLog]
  const budget = currentRefreshMs
  const summary = summarize(all, all.length)
  const slow = all.filter((dt) => dt > budget * 1.2).length
  return { ...summary, slowRatio: all.length ? slow / all.length : 0, total: all.length }
}

/* ---- 点击到出声：UI 动作起表，engine 报告 playing 时停表 ---- */
const audioSamples: number[] = []
let audioMarkAt = 0
let audioKind = ''
export function beginAudio(kind: string): void {
  audioMarkAt = performance.now()
  audioKind = kind
}
export function endAudio(kind: string): void {
  if (!audioMarkAt || (kind && audioKind && kind !== audioKind)) return
  audioSamples.push(performance.now() - audioMarkAt)
  if (audioSamples.length > 60) audioSamples.shift()
  audioMarkAt = 0
  audioKind = ''
}
export function audioStats(): { n: number; p50: number; p95: number; max: number; last: number[] } {
  const s = [...audioSamples].sort((a, b) => a - b)
  const at = (q: number): number => (s.length ? s[Math.min(s.length - 1, Math.round((s.length - 1) * q))]! : 0)
  return {
    n: s.length,
    p50: Math.round(at(0.5)),
    p95: Math.round(at(0.95)),
    max: Math.round(s[s.length - 1] ?? 0),
    last: audioSamples.slice(-10).map((v) => Math.round(v))
  }
}

function maxGapBetween(from: number, to: number): { gap: number; slow: number } {
  // 用 rAF 时间轴重建 300ms 窗口内相邻帧的间隔：frames 只存了时长，没有绝对时刻。
  // 近似做法：取该窗口内所有帧时长里的最大值，并把 > 预算 的帧计为慢帧。
  // frames 是滚动窗口，无法知道精确归属 —— 用最近 300ms/帧数 的集合即可（误差在一帧内）。
  const budget = currentRefreshMs
  const recent = frames.slice(-60)
  let gap = 0
  let slow = 0
  for (const dt of recent) {
    if (dt > gap) gap = dt
    if (dt > budget * 1.5) slow++
  }
  return { gap: from > 0 && to > from ? gap : gap, slow }
}

function longTaskSum(from: number, to: number): number {
  let sum = 0
  for (const task of longTasks) {
    if (task.start + task.duration >= from && task.start <= to) sum += task.duration
  }
  return sum
}

export function beginOpen(key: string, label: string): void {
  const now = performance.now()
  // 结束上一个未完成的测量（连续点击时不能丢样本）
  if (pending) finalize(false)
  const cold = !seen.has(key)
  seen.add(key)
  pending = {
    id: ++seq,
    key,
    label,
    cold,
    origin: lastPointerDownAt > 0 && now - lastPointerDownAt < 1200 ? lastPointerDownAt : now,
    sync: null,
    data: null,
    commit: null,
    paint: null,
    cover: null
  }
}

/** 若当前没有进行中的测量（例如由状态驱动的打开），补一个。 */
export function beginOpenIfNone(key: string, label: string): void {
  if (pending && pending.key === key) return
  beginOpen(key, label)
}

export function phase(name: OpenPhase): void {
  if (!pending) return
  const at = performance.now() - pending.origin
  if (pending[name] === null) pending[name] = at
}

/** 只给指定目标记阶段：防止保活的隐藏页面在别人的测量里抢先把 data 打掉。 */
export function phaseForKey(key: string, name: OpenPhase): void {
  if (!pending || pending.key !== key) return
  phase(name)
}

export function openKeyOfPending(): string | null {
  return pending?.key ?? null
}

export function finishPaint(): void {
  if (!pending) return
  phase('paint')
  const p = pending
  // 首屏封面解码：有 data-open-cover 的页面在绘制后再等 decode，别让解码抢首帧
  const scope = document.querySelector('[data-open-cover]') as HTMLElement | null
  const img = scope?.querySelector('img') ?? null
  if (!img || !img.src) {
    finalize(true)
    return
  }
  const done = (): void => {
    if (pending && pending.id === p.id) {
      phase('cover')
      finalize(true)
    }
  }
  if (img.complete && img.naturalWidth > 0) {
    done()
    return
  }
  // 最多等 400ms：封面迟到不该把整条点开延迟拖成负数
  const timer = window.setTimeout(done, 400)
  img
    .decode()
    .then(() => {
      window.clearTimeout(timer)
      done()
    })
    .catch(() => {
      window.clearTimeout(timer)
      done()
    })
}

function finalize(complete: boolean): void {
  const p = pending
  if (!p) return
  pending = null
  const windowEnd = p.origin + SLOW_OPEN_TITLE_MS
  const { gap, slow } = maxGapBetween(p.origin, windowEnd)
  opens.push({
    id: p.id,
    key: p.key,
    label: p.label,
    cold: p.cold,
    origin: p.origin,
    sync: p.sync,
    data: p.data,
    commit: p.commit,
    paint: complete ? p.paint : null,
    cover: p.cover,
    longTaskMs: Math.round(longTaskSum(p.origin, windowEnd)),
    maxGapMs: Math.round(gap * 10) / 10,
    slowFrames: slow
  })
  if (opens.length > OPEN_KEEP) opens.shift()
  emit()
}

export function recentOpens(): OpenSample[] {
  return opens.slice(-20)
}

export function openStats(): {
  hot: { n: number; p50: number; p95: number; max: number }
  cold: { n: number; p50: number; p95: number; max: number }
} {
  const hot = opens.filter((o) => !o.cold && o.paint !== null).map((o) => o.paint!)
  const cold = opens.filter((o) => o.cold && o.paint !== null).map((o) => o.paint!)
  const pack = (list: number[]): { n: number; p50: number; p95: number; max: number } => {
    if (list.length === 0) return { n: 0, p50: 0, p95: 0, max: 0 }
    const s = [...list].sort((a, b) => a - b)
    const at = (q: number): number => s[Math.min(s.length - 1, Math.round((s.length - 1) * q))]!
    return { n: s.length, p50: Math.round(at(0.5)), p95: Math.round(at(0.95)), max: Math.round(s[s.length - 1]!) }
  }
  return { hot: pack(hot), cold: pack(cold) }
}

export function recentLongTasks(limit = 6): LongTaskRecord[] {
  return longTasks.slice(-limit).reverse()
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function resetPerf(): void {
  opens.length = 0
  longTasks.length = 0
  frames.length = 0
  seen.clear()
  pending = null
  emit()
}

/* ------------------------------------------------------------ HUD 开关 */

const HUD_KEY = 'pinnet.perf.hud'
let hud = false
try {
  hud = localStorage.getItem(HUD_KEY) === '1'
} catch {
  /* ignore */
}
const hudListeners = new Set<(on: boolean) => void>()

export function hudEnabled(): boolean {
  return hud
}

export function setHud(on: boolean): void {
  hud = on
  try {
    localStorage.setItem(HUD_KEY, on ? '1' : '0')
  } catch {
    /* ignore */
  }
  for (const listener of hudListeners) listener(on)
}

export function onHudChange(listener: (on: boolean) => void): () => void {
  hudListeners.add(listener)
  return () => hudListeners.delete(listener)
}

/* ------------------------------------------------------------ 浏览器侧调试口 */

export interface PerfBridge {
  opens: () => OpenSample[]
  stats: () => ReturnType<typeof openStats>
  frames: () => FrameSummary
  longTasks: () => LongTaskRecord[]
  reset: () => void
  setHud: (on: boolean) => void
  budget: () => number
  startFrameLog: () => void
  stopFrameLog: () => ReturnType<typeof stopFrameLog>
  audio: () => ReturnType<typeof audioStats>
  loaf: () => LoafRecord[]
}

declare global {
  interface Window {
    __perf?: PerfBridge
  }
}

if (typeof window !== 'undefined') {
  window.__perf = {
    opens: () => opens.slice(),
    stats: openStats,
    frames: frameSummary,
    longTasks: () => longTasks.slice(),
    reset: resetPerf,
    setHud,
    budget: frameBudgetMs,
    startFrameLog,
    stopFrameLog,
    audio: audioStats,
    loaf: () => loafs.slice()
  }
}

export function lastPointerKind(): string {
  return lastPointerType
}
