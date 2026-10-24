// 回归测试：切歌那一瞬间旧 deck 的 'ended' 不能把新歌再顶掉一首。
//
// 起因：crossfadeTo() 先 await play()、之后才翻转 this.active。
// 如果用户恰好在歌曲尾部点「下一首」，旧 deck 可能在等待窗口里自然播完，
// 此时 active 仍指向旧 deck，ended 被当成「新歌播完了」，于是一次点击跳两首。
// 修法：先把 active 翻到新 deck，把旧 deck 标记为 retiring，它的 ended 一律忽略。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'

class FakeAudio extends EventTarget {
  crossOrigin = ''
  preload = ''
  src = ''
  currentTime = 0
  duration = 100
  paused = true
  ended = false
  playCalls = 0
  play(): Promise<void> {
    this.playCalls += 1
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
    constructor() {
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

describe('engine: 切歌竞态', () => {
  it('ignores the outgoing deck ending while the new track is starting', async () => {
    const { engine } = await import('../src/renderer/src/audio/engine')
    let endedCount = 0
    engine.setEndedHandler(() => {
      endedCount += 1
    })

    await engine.load(song('A'), { autoplay: true, position: 0 })
    const deckA = decks[0]!

    // 用户点了「下一首」：crossfadeTo 还没 resolve
    const switching = engine.crossfadeTo(song('B'), { position: 0, duration: 0.7 })
    // 旧 deck 恰在这一刻播完
    deckA.ended = true
    deckA.dispatchEvent(new Event('ended'))
    await switching

    expect(endedCount).toBe(0)
    expect(engine.snapshot().songId).toBe('B')

    // 新 deck 真正播完时仍然要触发（不能为了防竞态把正常自动下一首也吞掉）
    const deckB = decks[1]!
    deckB.ended = true
    deckB.dispatchEvent(new Event('ended'))
    expect(endedCount).toBe(1)

    // 接着验证连点 10 次「下一首」：最终只能有一块 deck 还在出声
    const ids = Array.from({ length: 10 }, (_, i) => `s${i + 1}`)
    const runs = ids.map((id) => engine.crossfadeTo(song(id), { position: 0, duration: 0.5 }))
    await Promise.all(runs)

    expect(engine.snapshot().songId).toBe('s10')
    expect(engine.snapshot().playing).toBe(true)

    // 等淡出定时器跑完
    await new Promise((resolve) => setTimeout(resolve, 1400))
    const deckRefs = Object.values(
      (engine as unknown as { decks: Record<string, { el: FakeAudio }> }).decks
    )
    expect(deckRefs).toHaveLength(2)
    // Deck 包着媒体元素，出声与否要看元素的 paused 标志
    expect(deckRefs.filter((deck) => !deck.el.paused)).toHaveLength(1)
  })
})
