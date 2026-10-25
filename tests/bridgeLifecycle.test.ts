// 回归测试：AutoMix 的「准备好」不能被当成「已经开始」。
//
// 起因（一直切歌 / 每首都在过渡里的元凶）：
//   prepareBridge() 只是把过渡缓冲渲染好等在一边，但它同时把引擎置成了 phase='bridge'
//   且 startedAt=0。于是 bridgeTime() 变成「AudioContext 诞生以来的秒数」（几十秒），
//   engine.tick() 立刻判定 t >= bridgeDuration - FADE → 准备完就直接交接 →
//   下一首又准备、又交接…… 表现就是：自动过渡、一首接一首、点一下又直接跳下一首。
//
// 现在：bridge 分为「已准备（started=false）」和「已开始（started=true）」两种状态，
// 只有后者才推进时间轴、才允许交接。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'

class FakeAudio extends EventTarget {
  crossOrigin = ''
  preload = ''
  src = ''
  currentTime = 0
  duration = 100
  paused = true
  ended = false
  play(): Promise<void> {
    this.paused = false
    return Promise.resolve()
  }
  pause(): void {
    this.paused = true
  }
  load(): void {}
  removeAttribute(): void {}
}

class FakeGain {
  gain = {
    value: 1,
    cancelScheduledValues(): void {},
    setValueAtTime(): void {},
    linearRampToValueAtTime(): void {},
    setTargetAtTime(): void {}
  }
  connect(): void {}
  disconnect(): void {}
}

let sourceCount = 0

class FakeBufferSource {
  buffer: unknown = null
  onended: (() => void) | null = null
  constructor() {
    sourceCount += 1
  }
  connect(): void {}
  start(): void {}
  stop(): void {}
}

class FakeAudioContext {
  static last: FakeAudioContext | null = null
  currentTime = 0
  state = 'running'
  destination = {}
  constructor() {
    FakeAudioContext.last = this
  }
  resume(): Promise<void> {
    return Promise.resolve()
  }
  close(): Promise<void> {
    return Promise.resolve()
  }
  createGain(): FakeGain {
    return new FakeGain()
  }
  createBufferSource(): FakeBufferSource {
    return new FakeBufferSource()
  }
  createMediaElementSource(): { connect(): void } {
    return { connect(): void {} }
  }
}

const song = (id: string): any => ({
  id,
  path: `/m/${id}.mp3`,
  title: id,
  artists: ['A'],
  albumArtist: 'A',
  album: 'Alb',
  durationSec: 100,
  mtimeMs: 1,
  coverId: null
})

/** 一份最小可用的 D 级计划：过渡 8 秒，起点 80 秒。 */
const plan = {
  level: 'D',
  startTime: 80,
  endTime: 88,
  bridgeDuration: 8,
  nextStartOffset: 0,
  rate: [{ at: 0, value: 1 }],
  currentGain: [{ at: 0, value: 1 }],
  nextGain: [
    { at: 0, value: 0 },
    { at: 8, value: 1 }
  ],
  nextBedIn: 0,
  nextVocalIn: 0,
  vocalOut: null,
  bassSwapAt: 0,
  uiSwitchAt: 0,
  alignmentErrorMs: 0,
  entryFadeSec: 0.3,
  exitFadeSec: 0.3,
  notes: []
} as any

beforeEach(() => {
  sourceCount = 0
  // 注意：engine 是单例，AudioContext 只会在第一次 ensureContext 时创建，
  // 所以这里不能把 last 清空 —— 后续用例要继续推进同一个时钟。
  ;(globalThis as any).window = {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number,
    cancelAnimationFrame: () => undefined
  }
  ;(globalThis as any).Audio = FakeAudio
  ;(globalThis as any).AudioContext = FakeAudioContext
})

afterEach(() => {
  delete (globalThis as any).window
  delete (globalThis as any).Audio
  delete (globalThis as any).AudioContext
})

describe('engine: AutoMix 桥接的生命周期', () => {
  it('只准备好过渡时，引擎不进入 bridge、进度也不跳到过渡起点', async () => {
    const { engine } = await import('../src/renderer/src/audio/engine')
    await engine.prepareBridge(plan, song('A'), song('B'), { duration: 8 } as any)

    const snapshot = engine.snapshot()
    expect(snapshot.phase).not.toBe('bridge')
    expect(engine.isBridging()).toBe(false)
    // 关键：进度必须还是当前 deck 的真实位置（0），
    // 而不是计划的过渡起点（80）—— 否则 UI 与调度器都会以为已经跳到歌尾。
    expect(snapshot.position).toBe(0)
    // 但过渡确实已经备好，随时可以进入
    expect(engine.hasBridge()).toBe(true)
  })

  it('进入过渡只能一次：第二次 enter 不会再造一个音源', async () => {
    const { engine } = await import('../src/renderer/src/audio/engine')
    await engine.prepareBridge(plan, song('A'), song('B'), { duration: 8 } as any)

    expect(engine.enterBridge(0)).toBe(true)
    expect(engine.isBridging()).toBe(true)
    expect(engine.snapshot().phase).toBe('bridge')
    expect(sourceCount).toBe(1)

    // 重复进入必须被拒绝：否则会叠出第二个 BufferSource，
    // 并把 startedAt 一直往后推，交接永远等不到。
    expect(engine.enterBridge(0)).toBe(false)
    expect(sourceCount).toBe(1)
  })

  it('过渡时长走完后只交接一次', async () => {
    const { engine } = await import('../src/renderer/src/audio/engine')
    await engine.prepareBridge(plan, song('A'), song('B'), { duration: 8 } as any)
    engine.enterBridge(0)

    const ctx = FakeAudioContext.last!
    ctx.currentTime = 9
    await new Promise((resolve) => setTimeout(resolve, 260))
    expect(engine.snapshot().songId).toBe('B')

    // 再等一会儿：不应该又交接回去，或者反复交接
    ctx.currentTime = 20
    await new Promise((resolve) => setTimeout(resolve, 260))
    expect(engine.snapshot().songId).toBe('B')
  })
})
