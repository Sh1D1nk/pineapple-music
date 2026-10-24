import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { estimateTempo, onsetEnvelope, trackBeats } from '../src/shared/dsp/tempo'
import { analyzeWindows } from '../src/main/workers/analysis.worker'
import { decodeMono } from '../src/main/media/ffmpeg'
import { detectSilenceBounds, integratedLoudness } from '../src/shared/dsp/loudness'

const SR = 44100

function clickTrack(bpm: number, seconds: number, offsetSec = 0): Float32Array {
  const n = Math.floor(seconds * SR)
  const out = new Float32Array(n)
  const period = 60 / bpm
  let seed = 7
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return (seed / 2147483648) * 2 - 1
  }
  for (let t = offsetSec; t < seconds; t += period) {
    const start = Math.floor(t * SR)
    const len = Math.floor(0.09 * SR)
    for (let i = 0; i < len; i++) {
      const idx = start + i
      if (idx >= n) break
      const env = Math.exp(-(i / SR) * 40)
      out[idx] += Math.sin(2 * Math.PI * 90 * (i / SR)) * env * 0.6 + rand() * env * 0.25
    }
  }
  return out
}

describe('tempo estimation', () => {
  it('finds 100 BPM on a synthetic click track', () => {
    const env = onsetEnvelope(clickTrack(100, 40), SR)
    const tempo = estimateTempo(env.env, env.hopSec)
    expect(Math.abs(tempo.bpm - 100)).toBeLessThan(1.5)
    expect(tempo.confidence).toBeGreaterThan(0.2)
  })

  it('finds 108 BPM on a synthetic click track', () => {
    const env = onsetEnvelope(clickTrack(108, 40), SR)
    const tempo = estimateTempo(env.env, env.hopSec)
    expect(Math.abs(tempo.bpm - 108)).toBeLessThan(1.5)
  })

  it('tracks beats close to the real click positions', () => {
    const pcm = clickTrack(100, 30)
    const env = onsetEnvelope(pcm, SR)
    const tempo = estimateTempo(env.env, env.hopSec)
    const track = trackBeats(env.env, env.hopSec, tempo, 0)
    expect(track.beatTimes.length).toBeGreaterThan(30)
    const period = 60 / 100
    for (const beat of track.beatTimes.slice(2, 12)) {
      const error = Math.abs(beat - Math.round(beat / period) * period)
      expect(error).toBeLessThan(0.03)
    }
  })
})

const fixtures = join(process.cwd(), 'fixtures')
const hasFixtures = existsSync(join(fixtures, '09 - Loop 100.mp3'))

describe.skipIf(!hasFixtures)('analysis worker on the drum-loop fixtures', () => {
  it('reports 100 BPM for the 100 BPM loop and 108 for the other', async () => {
    const a = await decodeMono(join(fixtures, '09 - Loop 100.mp3'), 5, 60)
    const b = await decodeMono(join(fixtures, '10 - Loop 108.mp3'), 5, 60)
    const resultA = analyzeWindows({ sampleRate: SR, head: a, headStart: 5, tail: a, tailStart: 5 })
    const resultB = analyzeWindows({ sampleRate: SR, head: b, headStart: 5, tail: b, tailStart: 5 })
    expect(Math.abs(resultA.bpm - 100)).toBeLessThan(1.5)
    expect(Math.abs(resultB.bpm - 108)).toBeLessThan(1.5)
    expect(resultA.stability).toBeGreaterThan(0.6)
    // 100 → 108 needs a 8 % stretch, which the planner must accept as an A-level transition.
    const ratio = resultA.period / resultB.period
    expect(Math.abs(ratio - 1)).toBeLessThanOrEqual(0.08 + 0.005)
  })
})

describe('loudness and silence', () => {
  it('measures a -20 dBFS sine near its true loudness', () => {
    const n = SR * 3
    const pcm = new Float32Array(n)
    for (let i = 0; i < n; i++) pcm[i] = Math.sin((2 * Math.PI * 997 * i) / SR) * 0.1
    const { lufs } = integratedLoudness(pcm, SR)
    expect(lufs).toBeGreaterThan(-25)
    expect(lufs).toBeLessThan(-16)
  })

  it('detects leading and trailing silence', () => {
    const n = SR * 5
    const pcm = new Float32Array(n)
    for (let i = SR; i < SR * 3; i++) pcm[i] = Math.sin((2 * Math.PI * 300 * i) / SR) * 0.4
    const bounds = detectSilenceBounds(pcm, SR, 5)
    expect(bounds.leadSilence).toBeGreaterThan(0.9)
    expect(bounds.leadSilence).toBeLessThan(1.1)
    expect(bounds.tailSilence).toBeGreaterThan(1.9)
    expect(bounds.audioEnd).toBeLessThan(3.1)
  })
})
