// 回归测试：自动下一首必须能连续生效。
//
// 起因：crossfadeTo 切换 deck 时没有重置 endedFired，导致
// 「第一首播完 → 自动切第二首 → 第二首播完不再继续」的链在第二首断掉。
// 判据逻辑抽到 audio/endedGuard.ts，这里用假音频元素驱动引擎跑完整链路。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'

class FakeAudio extends EventTarget {
  crossOrigin = ''
  preload = ''
  src = ''
  currentTime = 0
  duration = 100
  paused = true
  ended = false
  loadCount = 0
  play(): Promise<void> {
    this.paused = false
    return Promise.resolve()
  }
  pause(): void {
    this.paused = true
  }
  load(): void {
    this.loadCount += 1
  }
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

class FakeAudioContext {
  currentTime = 0
  state = 'running'
  destination = {}
  resume(): Promise<void> {
    return Promise.resolve()
  }
  close(): Promise<void> {
    return Promise.resolve()
  }
  createGain(): FakeGain {
    return new FakeGain()
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

let decks: FakeAudio[] = []

beforeEach(() => {
  decks = []
  ;(globalThis as any).window = {
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: () => 0,
    clearInterval: () => undefined,
    requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number,
    cancelAnimationFrame: () => undefined
  }
  ;(globalThis as any).Audio = class extends FakeAudio {
    constructor(public id: string) {
      super()
      decks.push(this as unknown as FakeAudio)
    }
  }
  ;(globalThis as any).AudioContext = FakeAudioContext
})

afterEach(() => {
  delete (globalThis as any).window
  delete (globalThis as any).Audio
  delete (globalThis as any).AudioContext
})

describe('engine: 自然播完 → 自动下一首', () => {
  it('should fire the ended handler for EVERY natural track end (not just the first)', async () => {
    const { engine } = await import('../src/renderer/src/audio/engine')
    let endedCount = 0
    engine.setEndedHandler(() => {
      endedCount += 1
    })

    // 1) user clicks row N -> playSongs -> engine.load(songA, autoplay)
    await engine.load(song('A'), { autoplay: true, position: 0 })
    const deckA = decks[0]!

    // 2) song A plays to its natural end
    deckA.ended = true
    deckA.dispatchEvent(new Event('ended'))
    expect(endedCount).toBe(1)

    // 3) store.next(true) -> engine.crossfadeTo(songB)  (auto-advance path)
    await engine.crossfadeTo(song('B'), { position: 0, duration: 1.2 })
    const deckB = decks[1]!

    // 4) song B plays to its natural end
    deckB.ended = true
    deckB.dispatchEvent(new Event('ended'))

    // The queue must advance again -> endedCount should be 2
    expect(endedCount).toBe(2)
  })
})
