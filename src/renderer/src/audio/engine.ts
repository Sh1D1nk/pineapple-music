import type { SongMeta } from '@shared/types'
import { songUrl } from '../bridge'
import { integratedPosition, rateAt, gainAt, type TransitionPlan } from '@shared/transition/planner'
import { ENDED_GUARD_MS, shouldAcceptEnded } from './endedGuard'

export type EnginePhase = 'idle' | 'loading' | 'playing' | 'paused' | 'bridge' | 'preparing'
export type DeckId = 'A' | 'B'

interface Deck {
  id: DeckId
  el: HTMLAudioElement
  gain: GainNode
  source: MediaElementAudioSourceNode | null
}

export interface EngineSnapshot {
  phase: EnginePhase
  songId: string | null
  position: number
  duration: number
  playing: boolean
  volume: number
  muted: boolean
  bridge: {
    active: boolean
    plan: TransitionPlan | null
    nextSongId: string | null
    switched: boolean
  }
}

interface BridgeRun {
  plan: TransitionPlan
  currentSong: SongMeta
  nextSong: SongMeta
  buffer: AudioBuffer
  source: AudioBufferSourceNode | null
  gain: GainNode
  /** 是否真的开始播了过渡。准备好 ≠ 已经开始，这是本轮连锁 bug 的关键区分。 */
  started: boolean
  startedAt: number
  pausedAtBridgeTime: number | null
  switched: boolean
  finished: boolean
  currentDuration: number
  nextDuration: number
}

type Listener = (snapshot: EngineSnapshot) => void

const FADE = 0.3
/** 待执行的「淡出后暂停」定时器，切歌太快时必须能取消，否则旧账会把新场景的 deck 停掉。 */
const pauseTimers: Record<DeckId, number | null> = { A: null, B: null }

export class AudioEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private decks: Record<DeckId, Deck> | null = null
  private active: DeckId = 'A'
  /** 刚被换下去、正在淡出的 deck：它的 'ended' 属于上一首，不能触发自动下一首。 */
  private retiring: DeckId | null = null
  private currentSong: SongMeta | null = null
  private pendingSong: SongMeta | null = null
  private phase: EnginePhase = 'idle'
  private volume = 0.85
  private muted = false
  private bridge: BridgeRun | null = null
  private listeners = new Set<Listener>()
  private ticker: number | null = null
  private loadedPosition = 0

  on(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    const snapshot = this.snapshot()
    for (const listener of this.listeners) listener(snapshot)
  }

  /** 另一块 deck 必须彻底静音并停住，否则两首歌会叠在一起放。 */
  private silenceOther(keep: DeckId): void {
    const other = this.decks?.[keep === 'A' ? 'B' : 'A']
    if (!other) return
    const pending = pauseTimers[other.id]
    if (pending !== null) {
      window.clearTimeout(pending)
      pauseTimers[other.id] = null
    }
    other.el.pause()
    try {
      other.el.removeAttribute('src')
      other.el.load()
    } catch {
      /* 元素可能还没拿到 src */
    }
    if (this.ctx) {
      other.gain.gain.cancelScheduledValues(this.ctx.currentTime)
      other.gain.gain.setValueAtTime(0, this.ctx.currentTime)
    }
  }

  private ensureContext(): AudioContext {
    if (this.ctx) return this.ctx
    const ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 })
    const master = ctx.createGain()
    master.gain.value = this.muted ? 0 : this.volume
    master.connect(ctx.destination)

    const make = (id: DeckId): Deck => {
      const el = new Audio(id === 'A' ? 'deck-a' : 'deck-b')
      el.crossOrigin = 'anonymous'
      el.preload = 'auto'
      const gain = ctx.createGain()
      gain.gain.value = id === 'A' ? 1 : 0
      const source = ctx.createMediaElementSource(el)
      source.connect(gain)
      gain.connect(master)
      el.addEventListener('ended', () => this.handleEnded(id))
      el.addEventListener('error', () => {
        console.warn('[engine] media error', el.error?.code, el.error?.message)
      })
      return { id, el, gain, source }
    }

    this.decks = { A: make('A'), B: make('B') }
    this.ctx = ctx
    this.master = master
    this.startTicker()
    return ctx
  }

  snapshot(): EngineSnapshot {
    const deck = this.decks?.[this.active]
    const bridge = this.bridge
    if (bridge && bridge.started && !bridge.finished) {
      const t = this.bridgeTime()
      const useNext = t >= bridge.plan.uiSwitchAt
      return {
        phase: this.phase,
        songId: useNext ? bridge.nextSong.id : bridge.currentSong.id,
        position: this.bridgePosition(t),
        duration: useNext ? bridge.nextDuration : bridge.currentDuration,
        playing: this.phase === 'bridge' && bridge.pausedAtBridgeTime === null,
        volume: this.volume,
        muted: this.muted,
        bridge: {
          active: true,
          plan: bridge.plan,
          nextSongId: bridge.nextSong.id,
          switched: bridge.switched
        }
      }
    }
    return {
      phase: this.phase,
      songId: this.currentSong?.id ?? null,
      position: this.currentPosition(),
      duration: deck?.el.duration || this.currentSong?.durationSec || 0,
      playing: this.phase === 'playing',
      volume: this.volume,
      muted: this.muted,
      bridge: { active: false, plan: null, nextSongId: null, switched: false }
    }
  }

  getContext(): AudioContext {
    return this.ensureContext()
  }

  private currentPosition(): number {
    const deck = this.decks?.[this.active]
    if (!deck) return this.loadedPosition
    return this.phase === 'bridge' ? this.loadedPosition : deck.el.currentTime || 0
  }

  private bridgeTime(): number {
    const run = this.bridge
    if (!run || !this.ctx) return 0
    // 还没开始的过渡，时间轴不走
    if (!run.started) return 0
    if (run.pausedAtBridgeTime !== null) return run.pausedAtBridgeTime
    return Math.max(0, Math.min(run.plan.bridgeDuration, this.ctx.currentTime - run.startedAt))
  }

  private bridgePosition(t: number): number {
    const run = this.bridge
    if (!run) return 0
    const plan = run.plan
    if (t < plan.uiSwitchAt) {
      return Math.min(run.currentDuration, plan.startTime + integratedPosition(plan.rate, Math.min(t, plan.bridgeDuration)))
    }
    return Math.min(
      run.nextDuration,
      plan.nextStartOffset + Math.max(0, t - plan.nextBedIn)
    )
  }

  async load(song: SongMeta, opts: { autoplay?: boolean; position?: number } = {}): Promise<void> {
    const ctx = this.ensureContext()
    if (ctx.state === 'suspended') void ctx.resume()
    this.cancelBridge(false)
    this.silenceOther(this.active)
    this.retiring = null
    const deck = this.decks![this.active]
    this.currentSong = song
    this.endedFired = false
    this.endedGuardUntil = performance.now() + ENDED_GUARD_MS
    this.phase = 'loading'
    this.loadedPosition = opts.position ?? 0
    deck.el.src = songUrl(song.id)
    deck.el.currentTime = opts.position ?? 0
    deck.gain.gain.cancelScheduledValues(ctx.currentTime)
    deck.gain.gain.setValueAtTime(1, ctx.currentTime)
    this.emit()
    if (opts.autoplay !== false) {
      // play() 的 promise 在极少数情况（音频设备刚切、context 刚 resume）会一直不 settle，
      // 因此给一个 3 秒上限并再试一次；最终以「元素是否真的在走」为准，避免 UI 永远停在 loading。
      const started = await Promise.race([
        deck.el.play().then(() => true).catch(() => false),
        new Promise<boolean>((resolve) => window.setTimeout(() => resolve(false), 3000))
      ])
      if (!started && deck.el.paused) {
        try {
          await deck.el.play()
        } catch (err) {
          console.warn('[engine] play rejected', String(err))
        }
      }
      this.phase = deck.el.paused ? 'paused' : 'playing'
      this.endedFired = false
    } else {
      this.phase = 'paused'
    }
    this.emit()
  }

  async play(): Promise<void> {
    const ctx = this.ensureContext()
    if (ctx.state === 'suspended') await ctx.resume()
    if (this.bridge && this.bridge.started && !this.bridge.finished) {
      this.resumeBridge()
      return
    }
    const deck = this.decks![this.active]
    if (!deck.el.src) return
    this.phase = 'playing'
    // 从暂停恢复也算一次新的播放尝试：必须允许再次处理 ended。
    // 否则「播完时处于暂停态」会把 endedFired 卡在 true，恢复后再播完就不换下一首了。
    this.endedFired = false
    try {
      await deck.el.play()
    } catch (err) {
      console.warn('[engine] play rejected', String(err))
      this.phase = 'paused'
    }
    this.emit()
  }

  pause(): void {
    if (this.bridge && this.bridge.started && !this.bridge.finished) {
      this.pauseBridge()
      return
    }
    const deck = this.decks?.[this.active]
    if (!deck) return
    deck.el.pause()
    this.phase = 'paused'
    this.emit()
  }

  async toggle(): Promise<void> {
    // 用快照里的 playing 做唯一判据：bridge 期间 phase 是 'bridge'，只看 phase 会判错。
    if (this.snapshot().playing) this.pause()
    else await this.play()
  }

  seek(seconds: number): void {
    if (this.bridge && !this.bridge.finished) {
      const run = this.bridge
      if (!run.started) {
        // 只是备着、还没开始的过渡：保留它，只把当前 deck 挪到目标位置。
        // 丢掉的话，这次 seek 之后整首歌都不会再有 AutoMix 过渡（桥接缓冲已经渲染好了）。
        const deckEl = this.decks?.[this.active]
        if (deckEl) deckEl.el.currentTime = Math.max(0, seconds)
        this.emit()
        return
      } else {
      const t = this.bridgeTime()
      const onNext = t >= run.plan.uiSwitchAt
      const target = Math.max(0, seconds)
      this.cancelBridge(true)
      if (onNext) {
        void this.load(run.nextSong, { autoplay: true, position: target })
      } else {
        void this.load(run.currentSong, { autoplay: true, position: target })
      }
      return
      }
    }
    const deck = this.decks?.[this.active]
    if (!deck) return
    deck.el.currentTime = Math.max(0, seconds)
    this.emit()
  }

  setVolume(value: number): void {
    this.volume = Math.max(0, Math.min(1, value))
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.015)
    }
    this.emit()
  }

  setMuted(value: boolean): void {
    this.muted = value
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.015)
    }
    this.emit()
  }

  /** Short equal-power crossfade used by manual next/previous — never AutoMix. */
  async crossfadeTo(song: SongMeta, opts: { position?: number; duration?: number } = {}): Promise<void> {
    const ctx = this.ensureContext()
    if (ctx.state === 'suspended') await ctx.resume()
    this.cancelBridge(false)
    const fade = Math.max(0.5, Math.min(1, opts.duration ?? 0.7))
    const from = this.decks![this.active]
    const nextId: DeckId = this.active === 'A' ? 'B' : 'A'
    const to = this.decks![nextId]
    // 目标 deck 上可能还挂着上一次的暂停定时器，先清掉再接管
    if (pauseTimers[nextId] !== null) {
      window.clearTimeout(pauseTimers[nextId]!)
      pauseTimers[nextId] = null
    }
    // 这个 deck 若正被上一次切歌标记为「退役」，本次复用等于复活它，标记作废
    if (this.retiring === nextId) this.retiring = null
    const now = ctx.currentTime

    to.el.src = songUrl(song.id)
    to.el.currentTime = opts.position ?? 0
    to.gain.gain.cancelScheduledValues(now)
    to.gain.gain.setValueAtTime(0, now)
    to.gain.gain.linearRampToValueAtTime(1, now + fade)
    from.gain.gain.cancelScheduledValues(now)
    from.gain.gain.setValueAtTime(from.gain.gain.value, now)
    from.gain.gain.linearRampToValueAtTime(0, now + fade)

    // 关键：先把「当前 deck」翻到新的一块，再去等 play()。
    // play() 是异步的，如果等它 resolve 之后才翻，旧 deck 在等待窗口里自然播完的
    // 'ended' 会被 handleEnded 当成「新歌播完了」再切一首 —— 这就是连点「下一首」
    // 偶尔一次跳两首的来源。翻完之后旧 deck 只是「退役」，它的 ended 一律忽略。
    this.active = nextId
    this.retiring = from.id
    this.currentSong = song
    // 换到新 deck 是一次新的播放：必须重置 ended 标记与保护窗，
    // 否则第一首播完自动切到第二首后，第二首的 ended 会被 alreadyFired 拦截，
    // 表现为「播完一首就停住，不再自动下一首」。
    this.endedFired = false
    this.endedGuardUntil = performance.now() + ENDED_GUARD_MS
    this.phase = 'playing'
    this.emit()

    try {
      await to.el.play()
    } catch (err) {
      console.warn('[engine] crossfade play rejected', String(err))
      // 新 deck 起不来：把旧 deck 立刻停掉，别留一块静音但还在跑的 deck
      from.el.pause()
      if (this.retiring === from.id) this.retiring = null
      if (this.active === to.id) {
        this.phase = 'paused'
        this.emit()
      }
      return
    }
    pauseTimers[from.id] = window.setTimeout(() => {
      pauseTimers[from.id] = null
      // 只有当它真的不再是当前 deck 时才停，避免连点「下一首」把正在放的那块停掉
      if (this.active === from.id) return
      from.el.pause()
      from.el.removeAttribute('src')
      from.el.load()
      from.gain.gain.setValueAtTime(0, ctx.currentTime)
      if (this.retiring === from.id) this.retiring = null
    }, fade * 1000 + 80)
  }

  /* ---------------------------------------------------------------- bridge / AutoMix */

  async prepareBridge(plan: TransitionPlan, currentSong: SongMeta, nextSong: SongMeta, buffer: AudioBuffer): Promise<void> {
    this.ensureContext()
    this.cancelBridge(false)
    this.bridge = {
      plan,
      currentSong,
      nextSong,
      buffer,
      source: null,
      gain: this.ctx!.createGain(),
      started: false,
      startedAt: this.ctx!.currentTime,
      pausedAtBridgeTime: null,
      switched: false,
      finished: false,
      currentDuration: currentSong.durationSec,
      nextDuration: nextSong.durationSec
    }
    this.bridge.gain.connect(this.master!)
    this.bridge.gain.gain.value = 0
    // 这里只是「把过渡准备好」，还没开始播。
    //
    // 之前在这一步就把 phase 置成 'bridge'、startedAt 置 0，于是 bridgeTime()
    // 变成了「AudioContext 诞生以来的秒数」（几十秒），engine.tick() 立刻判定
    // t >= bridgeDuration - FADE → 准备完就直接交接 → 下一首又准备、又交接……
    // 表现就是「自动过渡、一首接一首、每首都在过渡里」。
    // 引擎保持在 playing，等调度器在真正的过渡起点调用 enterBridge()。
    this.emit()
  }

  hasBridge(): boolean {
    return this.bridge != null && !this.bridge.finished
  }

  /** Bridge 正在出声：此时 store 里的「当前歌曲」由 bridge 自己切换，调度器不能当成用户切歌。 */
  isBridging(): boolean {
    return (
      this.phase === 'bridge' &&
      this.bridge != null &&
      this.bridge.started &&
      !this.bridge.finished
    )
  }

  bridgedSongIds(): string[] {
    return this.bridge ? [this.bridge.currentSong.id, this.bridge.nextSong.id] : []
  }

  /** Called by the scheduler when the playhead reaches the plan's start time. */
  enterBridge(offsetSec = 0): boolean {
    const run = this.bridge
    if (!run || !this.ctx || !this.master) return false
    // 幂等：重复 enter 会叠出第二个 BufferSource，并把 startedAt 往后推，
    // 让交接时间永远到不了 —— 表现就是「一直卡在过渡里」。
    if (this.phase === 'bridge' && run.source) return false
    if (run.finished) return false
    const ctx = this.ctx
    const when = ctx.currentTime + 0.06
    const offset = Math.max(0, Math.min(offsetSec, Math.max(0, run.buffer.duration - 0.5)))
    const source = ctx.createBufferSource()
    source.buffer = run.buffer
    source.connect(run.gain)
    source.start(when, offset)

    run.source = source
    run.started = true
    run.startedAt = when - offset
    run.pausedAtBridgeTime = null
    run.switched = false
    run.finished = false
    run.gain.gain.cancelScheduledValues(when)
    run.gain.gain.setValueAtTime(0, when)
    run.gain.gain.linearRampToValueAtTime(1, when + FADE)

    const deck = this.decks![this.active]
    deck.gain.gain.cancelScheduledValues(when)
    deck.gain.gain.setValueAtTime(deck.gain.gain.value, when)
    deck.gain.gain.linearRampToValueAtTime(0, when + FADE)
    window.setTimeout(() => {
      if (this.bridge === run) deck.el.pause()
    }, (FADE + 0.06) * 1000)

    this.phase = 'bridge'
    this.emit()
    return true
  }

  private pauseBridge(): void {
    const run = this.bridge
    if (!run || !this.ctx) return
    const ctx = this.ctx
    const t = this.bridgeTime()
    const now = ctx.currentTime
    run.gain.gain.cancelScheduledValues(now)
    run.gain.gain.setValueAtTime(run.gain.gain.value, now)
    run.gain.gain.linearRampToValueAtTime(0, now + 0.08)
    run.pausedAtBridgeTime = t
    const source = run.source
    run.source = null
    window.setTimeout(() => {
      try {
        source?.stop()
      } catch {
        /* already stopped */
      }
    }, 90)
    this.emit()
  }

  private resumeBridge(): void {
    const run = this.bridge
    if (!run || !this.ctx) return
    const ctx = this.ctx
    const offset = run.pausedAtBridgeTime ?? 0
    const source = ctx.createBufferSource()
    source.buffer = run.buffer
    source.connect(run.gain)
    source.start(ctx.currentTime + 0.02, offset)
    run.source = source
    run.startedAt = ctx.currentTime + 0.02 - offset
    run.pausedAtBridgeTime = null
    this.phase = 'bridge'
    run.gain.gain.cancelScheduledValues(ctx.currentTime)
    run.gain.gain.setValueAtTime(0, ctx.currentTime)
    run.gain.gain.linearRampToValueAtTime(1, ctx.currentTime + 0.08)
    this.emit()
  }

  cancelBridge(keepGain: boolean): void {
    const run = this.bridge
    if (!run) return
    this.bridge = null
    try {
      run.source?.stop()
    } catch {
      /* already stopped */
    }
    run.source = null
    if (this.ctx) {
      if (!keepGain) {
        run.gain.gain.cancelScheduledValues(this.ctx.currentTime)
        run.gain.gain.setValueAtTime(0, this.ctx.currentTime)
      }
      window.setTimeout(() => run.gain.disconnect(), 400)
    }
    const deck = this.decks?.[this.active]
    if (deck && this.ctx) {
      deck.gain.gain.cancelScheduledValues(this.ctx.currentTime)
      deck.gain.gain.setValueAtTime(1, this.ctx.currentTime)
    }
  }

  private startTicker(): void {
    if (this.ticker !== null) return
    this.ticker = window.setInterval(() => this.tick(), 100)
  }

  private tick(): void {
    const run = this.bridge
    if (!run || !this.ctx || !this.decks) {
      this.emit()
      return
    }
    if (run.pausedAtBridgeTime !== null) return
    // 只是「准备好」的过渡：没有 source、没有时间轴，不能推进，更不能交接
    if (!run.started) {
      this.emit()
      return
    }
    const t = this.bridgeTime()

    if (!run.switched && t >= run.plan.uiSwitchAt) {
      run.switched = true
      this.emit()
    }

    // Handoff: start Deck B slightly before the bridge ends, crossfading against identical audio.
    if (!run.finished && t >= run.plan.bridgeDuration - FADE) {
      run.finished = true
      void this.handoff(run)
    }
    this.emit()
  }

  private async handoff(run: BridgeRun): Promise<void> {
    const ctx = this.ctx!
    const nextId: DeckId = this.active === 'A' ? 'B' : 'A'
    const deck = this.decks![nextId]
    // 交接前把旧 deck 彻底停掉：bridge 里已经包含旧曲的尾巴了
    const prev = this.decks![this.active]
    prev.el.pause()
    const position = Math.max(0, run.plan.nextStartOffset + (run.plan.bridgeDuration - run.plan.nextBedIn))
    const when = ctx.currentTime + 0.02
    deck.el.src = songUrl(run.nextSong.id)
    deck.el.currentTime = position
    deck.gain.gain.cancelScheduledValues(when)
    deck.gain.gain.setValueAtTime(0, when)
    deck.gain.gain.linearRampToValueAtTime(1, when + FADE)
    run.gain.gain.cancelScheduledValues(when)
    run.gain.gain.setValueAtTime(run.gain.gain.value, when)
    run.gain.gain.linearRampToValueAtTime(0, when + FADE)
    try {
      await deck.el.play()
    } catch (err) {
      console.warn('[engine] handoff play rejected', String(err))
    }
    this.active = nextId
    this.currentSong = run.nextSong
    this.loadedPosition = position
    this.phase = 'playing'
    const finishedRun = run
    window.setTimeout(() => {
      try {
        finishedRun.source?.stop()
      } catch {
        /* already stopped */
      }
      finishedRun.source = null
      finishedRun.gain.disconnect()
      if (this.bridge === finishedRun) this.bridge = null
      this.emit()
    }, FADE * 1000 + 120)
  }

  private handleEnded(id: DeckId): void {
    // 只有当前 deck 才有资格报告「播完了」。退役中的旧 deck 即使还在出声，
    // 它播完也只是上一首的尾巴，绝不能把刚点开的新歌顶掉。
    if (id !== this.active || id === this.retiring) return
    if (this.bridge && !this.bridge.finished) return
    const deck = this.decks?.[id]
    // 切歌竞态：上一首的 'ended' 事件可能排在 load() 之后才派发，
    // 那时 phase 已经是 playing，会把刚点开的歌误判成播完并跳到下一首。
    //
    // 判据用媒体元素的 ended 标志（load() 会把它置回 false，所以旧资源的
    // 迟到事件必然被识别为 stale），而不是纯时间窗 —— 时间窗会连带吞掉
    // 「刚开播就拖到结尾」这种真实播完事件，导致播完不自动下一首。
    if (!shouldAcceptEnded({
      withinGuard: performance.now() < this.endedGuardUntil,
      elementEnded: Boolean(deck?.el.ended),
      alreadyFired: this.endedFired
    })) return
    this.endedFired = true
    if (this.phase === 'playing') {
      this.phase = 'paused'
      this.emit()
      this.listeners.forEach(() => undefined)
      this.onEndedCallback?.()
    }
  }

  private onEndedCallback: (() => void) | null = null
  /** load() 之后的一小段时间内忽略 'ended'，避免上一首的结束事件把新歌顶掉 */
  private endedGuardUntil = 0
  /** 同一首歌的 ended 只处理一次，防止连续跳过多首 */
  private endedFired = false

  setEndedHandler(cb: (() => void) | null): void {
    this.onEndedCallback = cb
  }

  /** Value of the current rate curve at the playhead — used by the UI to show the AutoMix pill. */
  currentRate(): number {
    const run = this.bridge
    if (!run) return 1
    return rateAt(run.plan.rate, this.bridgeTime())
  }

  currentBridgeGains(): { current: number; next: number } {
    const run = this.bridge
    if (!run) return { current: 1, next: 0 }
    const t = this.bridgeTime()
    return { current: gainAt(run.plan.currentGain, t), next: gainAt(run.plan.nextGain, t) }
  }

  dispose(): void {
    if (this.ticker !== null) window.clearInterval(this.ticker)
    this.cancelBridge(false)
    void this.ctx?.close()
    this.ctx = null
  }
}

export const engine = new AudioEngine()

// 诊断用句柄：出问题时可以在开发者工具里直接看引擎状态（不动任何业务逻辑）。
if (typeof window !== 'undefined') {
  ;(window as unknown as { __engine?: AudioEngine }).__engine = engine
}
