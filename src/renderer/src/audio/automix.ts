import { create } from 'zustand'
import type { AnalysisResult, SongMeta } from '@shared/types'
import {
  planTransition,
  type Phrase,
  type PlannerOptions,
  type TransitionPlan
} from '@shared/transition/planner'
import { bridge } from '../bridge'
import { engine } from './engine'
import { useStore } from '../state/store'
import { renderBridge } from './bridgeRenderer'

export interface AutoMixState {
  level: TransitionPlan['level'] | null
  nextSongId: string | null
  status: 'idle' | 'planning' | 'rendering' | 'ready' | 'entering' | 'failed'
  plan: TransitionPlan | null
  renderMs: number | null
  stretched: boolean
  message: string | null
  set: (patch: Partial<Omit<AutoMixState, 'set'>>) => void
}

export const useAutoMix = create<AutoMixState>((set) => ({
  level: null,
  nextSongId: null,
  status: 'idle',
  plan: null,
  renderMs: null,
  stretched: false,
  message: null,
  set: (patch) => set(patch)
}))

if (typeof window !== 'undefined') {
  // 诊断用：控制台里能直接看到 AutoMix 当前级别与状态
  ;(window as unknown as { __automix?: unknown }).__automix = useAutoMix
}

function analysisOf(song: SongMeta): AnalysisResult | null {
  return song.analysis
}

export function phrasesFromLyrics(lines: { startTime: number; endTime: number }[], duration: number): Phrase[] {
  const phrases: Phrase[] = []
  for (const line of lines) {
    const start = line.startTime / 1000
    const end = Math.min(duration, line.endTime / 1000)
    if (end <= start) continue
    const last = phrases[phrases.length - 1]
    if (last && start - last.end < 0.45) last.end = Math.max(last.end, end)
    else phrases.push({ start, end })
  }
  return phrases
}

export interface PlanRequest {
  current: SongMeta
  next: SongMeta
  options: PlannerOptions
}

export function buildPlan(current: SongMeta, next: SongMeta, options: PlannerOptions): TransitionPlan | null {
  const a = analysisOf(current)
  const b = analysisOf(next)
  if (!a || !b) return null
  return planTransition(
    {
      duration: current.durationSec,
      audioStart: a.audioStart,
      audioEnd: a.audioEnd,
      bpm: a.bpm,
      period: a.grid.period,
      stability: a.grid.stability,
      downbeat: a.grid.downbeat,
      tailBeats: a.grid.tail,
      headBeats: a.grid.head,
      lufs: a.lufs
    },
    {
      duration: next.durationSec,
      audioStart: b.audioStart,
      audioEnd: b.audioEnd,
      bpm: b.bpm,
      period: b.grid.period,
      stability: b.grid.stability,
      downbeat: b.grid.downbeat,
      tailBeats: b.grid.tail,
      headBeats: b.grid.head,
      lufs: b.lufs
    },
    options
  )
}

export async function phrasesFor(song: SongMeta): Promise<Phrase[]> {
  try {
    const payload = await bridge.lyrics(song.id)
    if (!payload || payload.kind !== 'synced') return []
    return phrasesFromLyrics(payload.lines, song.durationSec)
  } catch {
    return []
  }
}

interface ActiveJob {
  songId: string
  cancelled: boolean
}

let activeJob: ActiveJob | null = null
let ticker: number | null = null
let armed: { plan: TransitionPlan; current: SongMeta; next: SongMeta } | null = null
let enterInFlight = false

export function cancelAutoMix(reason = '已取消自动衔接'): void {
  if (activeJob) activeJob.cancelled = true
  activeJob = null
  armed = null
  enterInFlight = false
  useAutoMix.getState().set({
    status: 'idle',
    plan: null,
    level: null,
    nextSongId: null,
    message: null
  })
  void reason
}

/** Build + render the bridge for the current → next pair, as early as possible. */
export async function prepareAutoMix(current: SongMeta, next: SongMeta): Promise<void> {
  const state = useStore.getState()
  const settings = state.settings.automix
  const job: ActiveJob = { songId: current.id, cancelled: false }
  activeJob = job
  const setAm = useAutoMix.getState().set
  setAm({ status: 'planning', nextSongId: next.id, message: null, renderMs: null })

  // 有分轨就用分轨里的人声乐句（真实人声），没有才退回歌词时间轴
  const [lyricPhrasesA, lyricPhrasesB] = await Promise.all([phrasesFor(current), phrasesFor(next)])
  const currentPhrases = current.stem?.state === 'ready' && current.stem.phrases ? current.stem.phrases : lyricPhrasesA
  const nextPhrases = next.stem?.state === 'ready' && next.stem.phrases ? next.stem.phrases : lyricPhrasesB
  if (job.cancelled) return

  const plan = buildPlan(current, next, {
    durationSec: settings.durationSec,
    maxRatePct: settings.maxRatePct,
    protectLastPhrase: settings.protectLastPhrase,
    baseFadeSec: settings.baseFadeSec,
    // 只有当前曲目真的有分轨数据，才允许走 A/B 级（人声先退、时变变速）
    stemsReady: current.stem?.state === 'ready',
    currentPhrases,
    nextPhrases
  })
  if (!plan) {
    setAm({ status: 'failed', message: '缺少节拍分析，使用基础交叉淡化' })
    return
  }
  setAm({ status: 'rendering', plan, level: plan.level })
  if (plan.level === 'E') {
    armed = { plan, current, next }
    setAm({ status: 'ready', level: 'E', message: '无缝播放' })
    return
  }

  const started = performance.now()
  try {
    const rendered = await renderBridge(plan, current, next)
    if (job.cancelled) return
    if (!rendered) throw new Error('bridge render returned nothing')
    armed = { plan, current, next }
    setAm({
      status: 'ready',
      level: plan.level,
      renderMs: Math.round(performance.now() - started),
      stretched: rendered.stretched,
      message: plan.notes[0] ?? null
    })
    await engine.prepareBridge(plan, current, next, rendered.buffer)
  } catch (err) {
    if (job.cancelled) return
    console.warn('[automix] bridge render failed:', String(err))
    armed = null
    setAm({ status: 'failed', message: '过渡渲染失败，使用基础交叉淡化' })
  }
}

/** 为「当前歌曲 + 队列里的下一首」规划并渲染 bridge。 */
export function planForCurrent(): void {
  const state = useStore.getState()
  const item = state.playback.queue[state.playback.index]
  const current = item ? state.songs[item.songId] : undefined
  const nextItem = state.playback.queue[state.playback.index + 1]
  const next = nextItem ? state.songs[nextItem.songId] : undefined
  if (!state.settings.automix.enabled) return
  if (!current || !next) {
    useAutoMix.getState().set({ status: 'idle', plan: null, level: null, nextSongId: null, message: null })
    return
  }
  if (!current.analysis || !next.analysis) {
    useAutoMix.getState().set({
      status: 'idle',
      nextSongId: next.id,
      level: null,
      message: current.analysis ? '下一首还没分析完' : '当前歌曲还没分析完'
    })
    return
  }
  void prepareAutoMix(current, next)
}

function tick(): void {
  const state = useStore.getState()
  const playback = state.playback
  const currentItem = playback.queue[playback.index]
  if (!currentItem) return
  const current = state.songs[currentItem.songId]
  if (!current) return

  const settings = state.settings.automix
  if (!settings.enabled) return

  // 交接跑完：bridge 已经闭嘴，Deck B 接管。这时才为「新的一对」重新规划，
  // 否则整个 AutoMix 会在第一次过渡之后彻底沉默。
  if (enterInFlight && !engine.isBridging()) {
    enterInFlight = false
    armed = null
    useAutoMix.getState().set({ status: 'idle', plan: null, level: null })
    planForCurrent()
    return
  }

  if (!armed || armed.current.id !== current.id) return
  const plan = armed.plan
  const position = engine.snapshot().position

  if (plan.level === 'E') {
    if (position >= plan.startTime - 0.12 && position <= plan.startTime + 1) {
      enterInFlight = true
      useAutoMix.getState().set({ status: 'entering' })
      void engine.crossfadeTo(armed.next, { position: 0, duration: 0.06 })
      void state.loadLyrics(armed.next.id)
    }
    return
  }

  if (!engine.hasBridge()) return
  if (position >= plan.startTime - 0.15 && position <= plan.startTime + 2) {
    enterInFlight = true
    engine.enterBridge(Math.max(0, position - plan.startTime))
    useAutoMix.getState().set({ status: 'entering' })
  }
}

export function startAutoMixScheduler(): () => void {
  if (ticker !== null) window.clearInterval(ticker)
  ticker = window.setInterval(tick, 120)

  let lastSongId: string | null = null
  let lastKey = ''
  let lastSettings = ''
  const unsubscribe = useStore.subscribe((state) => {
    const item = state.playback.queue[state.playback.index]
    const songId = item?.songId ?? null
    const nextItem = state.playback.queue[state.playback.index + 1]
    const nextId = nextItem?.songId ?? null
    const settingsKey = JSON.stringify(state.settings.automix)
    // 关键：把「下一首是谁」也放进 key。之前只比当前歌曲，所以「接下来播放」把一首歌
    // 插到队首后面时不会重新规划，AutoMix 于是一直停在上一对（或干脆没规划）。
    const key = `${songId}|${nextId}|${settingsKey}`
    if (key === lastKey) return
    const settingsChanged = settingsKey !== lastSettings
    lastKey = key
    lastSongId = songId
    lastSettings = settingsKey

    // 过渡进行到切换点时，store 的「当前歌曲」会被 bridge 自己推到下一首。
    // 那不是用户切歌，绝不能因此把正在出声的 bridge 拆掉 —— 之前「切一次触发多次」正是这里。
    const bridgedNext = engine.isBridging() ? engine.bridgedSongIds()[1] : null
    if (!settingsChanged && bridgedNext && songId === bridgedNext) return

    cancelAutoMix()
    engine.cancelBridge(false)
    enterInFlight = false
    planForCurrent()
  })

  return () => {
    if (ticker !== null) window.clearInterval(ticker)
    ticker = null
    unsubscribe()
  }
}

/** Used by the "试听下一次过渡" button and Transition Lab. */
export function seekToTransitionPreview(): void {
  if (!armed) return
  const target = Math.max(0, armed.plan.startTime - 15)
  engine.seek(target)
}
