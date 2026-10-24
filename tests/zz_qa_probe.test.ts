// TEMPORARY QA PROBE — deleted after the run.
// Instrumented: read the engine's private guards to see exactly which one swallows the 2nd 'ended'.

import { describe, expect, it, beforeEach, afterEach } from 'vitest'

class FakeAudio extends EventTarget {
  crossOrigin = ''
  preload = ''
  src = ''
  currentTime = 0
  duration = 100
  paused = true
  ended = false
  load(): void {}
  play(): Promise<void> {
    this.paused = false
    return Promise.resolve()
  }
  pause(): void {
    this.paused = true
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
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  decks = []
  ;(globalThis as any).window = {
    setTimeout,
    clearTimeout,
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

describe('PROBE: which guard swallows the 2nd ended?', () => {
  it('logs engine private state around each ended event', async () => {
    const { engine } = await import('../src/renderer/src/audio/engine')
    const anyEng = engine as any
    let endedCount = 0
    engine.setEndedHandler(() => {
      endedCount += 1
    })

    const dump = (tag: string): void => {
      // eslint-disable-next-line no-console
      console.log(
        `[${tag}] endedCount=${endedCount} phase=${anyEng.phase} active=${anyEng.active} ` +
          `endedFired=${anyEng.endedFired} guardRemaining=${Math.round(
            anyEng.endedGuardUntil - performance.now()
          )}ms deck.ended=${anyEng.decks?.[anyEng.active]?.el?.ended}`
      )
    }

    await engine.load(song('A'), { autoplay: true, position: 0 })
    dump('after load A')
    await sleep(1000)

    decks[0]!.ended = true
    decks[0]!.dispatchEvent(new Event('ended'))
    dump('after ended A')

    await engine.crossfadeTo(song('B'), { position: 0, duration: 1.2 })
    dump('after crossfadeTo B')
    await sleep(1000)

    decks[1]!.ended = true
    decks[1]!.dispatchEvent(new Event('ended'))
    dump('after ended B')

    expect(endedCount).toBe(2)
  })
})
