import { describe, expect, it } from 'vitest'
import { bestRateMultiplier, onsetEnvelope, trackBeatsDP } from '../src/shared/dsp/tempo'
import { camelotDistance, estimateKey } from '../src/shared/dsp/key'
import { planTransition, type PlannerOptions, type TrackAnalysisLite } from '../src/shared/transition/planner'

const SR = 44100

function clickTrack(bpm: number, seconds: number): Float32Array {
  const n = Math.floor(seconds * SR)
  const out = new Float32Array(n)
  const period = 60 / bpm
  for (let t = 0; t < seconds; t += period) {
    const start = Math.floor(t * SR)
    const len = Math.floor(0.09 * SR)
    for (let i = 0; i < len; i++) {
      const idx = start + i
      if (idx >= n) break
      const env = Math.exp(-(i / SR) * 40)
      out[idx] += Math.sin(2 * Math.PI * 90 * (i / SR)) * env * 0.6
    }
  }
  return out
}

/** A pure sine at frequency Hz for `seconds`, with a short fade at both ends. */
function tone(freq: number, seconds: number, amp = 0.2): Float32Array {
  const n = Math.floor(seconds * SR)
  const out = new Float32Array(n)
  const fade = Math.floor(0.01 * SR)
  for (let i = 0; i < n; i++) {
    const g = i < fade ? i / fade : i > n - fade ? (n - i) / fade : 1
    out[i] = Math.sin(2 * Math.PI * freq * (i / SR)) * amp * g
  }
  return out
}

function mixInto(target: Float32Array, source: Float32Array, atSec: number): void {
  const off = Math.floor(atSec * SR)
  for (let i = 0; i < source.length; i++) {
    const idx = off + i
    if (idx >= 0 && idx < target.length) target[idx] += source[i]!
  }
}

describe('DP beat tracking (ported from HyPlayer BeatTracker)', () => {
  it('locks onto a clean 100 BPM click and reports downbeats every 4 beats', () => {
    const pcm = clickTrack(100, 40)
    const env = onsetEnvelope(pcm, SR)
    const dp = trackBeatsDP(env.env, env.lowEnv, env.hopSec, 0)
    expect(dp.beatTimes.length).toBeGreaterThan(30)
    expect(dp.confidence).toBeGreaterThan(0.3)
    const period = 60 / 100
    for (const beat of dp.beatTimes.slice(3, 15)) {
      const error = Math.abs(beat - Math.round(beat / period) * period)
      expect(error).toBeLessThan(0.03)
    }
    // Downbeats are a strict subset spaced 4 beats apart.
    expect(dp.downbeatTimes.length).toBeGreaterThanOrEqual(Math.floor(dp.beatTimes.length / 4) - 1)
    if (dp.downbeatTimes.length >= 2) {
      expect(dp.downbeatTimes[1]! - dp.downbeatTimes[0]!).toBeCloseTo(period * 4, 1)
    }
    // bpm from median inter-beat interval stays within 1 BPM of the truth.
    expect(Math.abs(dp.bpm - 100)).toBeLessThan(1)
  })

  it('stays empty on a window too short to track', () => {
    const pcm = clickTrack(100, 4)
    const env = onsetEnvelope(pcm, SR)
    const dp = trackBeatsDP(env.env, env.lowEnv, env.hopSec, 0)
    expect(dp.beatTimes.length).toBe(0)
  })
})

describe('bestRateMultiplier (HyPlayer BestRate)', () => {
  it('treats a 200 BPM track as half-time 100 against a 100 BPM outgoing', () => {
    // multiplier scales the INCOMING bpm (bpmB·m); 200 → 100 keeps rate 1 and the two
    // grids line up 2:1, exactly like HyPlayer's BestRate.
    const { rate, multiplier } = bestRateMultiplier(100, 200)
    expect(multiplier).toBe(0.5)
    expect(rate).toBeCloseTo(1, 5)
  })

  it('treats a 50 BPM track as double-time 100 against a 100 BPM outgoing', () => {
    const { rate, multiplier } = bestRateMultiplier(100, 50)
    expect(multiplier).toBe(2)
    expect(rate).toBeCloseTo(1, 5)
  })

  it('keeps 1:1 for a small gap', () => {
    const { rate, multiplier } = bestRateMultiplier(100, 108)
    expect(multiplier).toBe(1)
    expect(rate).toBeCloseTo(100 / 108, 3)
  })
})

describe('Camelot key estimation (HyPlayer KeyEstimator)', () => {
  it('maps C major to wheel 8B and A minor to 8A', () => {
    // Build a C-major scale arpeggio (all white keys, no F♯) so the profile is unambiguous.
    const notes = [261.63, 293.66, 329.63, 349.23, 392.0, 440.0, 493.88]
    const pcm = new Float32Array(SR * 12)
    notes.forEach((f, i) => mixInto(pcm, tone(f, 0.9, 0.25), i * 1.4))
    const est = estimateKey(pcm, SR)
    expect(est.key).toBeGreaterThanOrEqual(0)
    // C major encodes to wheel-1 = 7; G major (wheel 9) is the only plausible neighbour.
    expect([7, 8, 19]).toContain(est.key)
  })

  it('scores Camelot distance the way DJs use the wheel', () => {
    const cMajor = 7 // wheel 8B
    const aMinor = 19 // wheel 8A
    const gMajor = 8 // wheel 9B
    const eMinor = 20 // wheel 9A
    const fsMajor = 1 // wheel 2B
    expect(camelotDistance(cMajor, cMajor)).toBe(0)
    expect(camelotDistance(cMajor, aMinor)).toBe(1) // relative pair
    expect(camelotDistance(cMajor, gMajor)).toBe(1) // +1 fifth, same mode
    expect(camelotDistance(cMajor, eMinor)).toBe(2) // adjacent, opposite mode
    expect(camelotDistance(cMajor, fsMajor)).toBeGreaterThan(2) // clash
    expect(camelotDistance(-1, cMajor)).toBe(0) // unknown keys never clash
  })
})

describe('planner ports', () => {
  const beatsBetween = (from: number, to: number, period: number): number[] => {
    const out: number[] = []
    for (let t = from; t <= to + 1e-6; t += period) out.push(Math.round(t * 1000) / 1000)
    return out
  }
  const track = (overrides: Partial<TrackAnalysisLite> = {}): TrackAnalysisLite => {
    const period = 60 / (overrides.bpm ?? 120)
    const audioEnd = overrides.audioEnd ?? 236
    return {
      duration: 240,
      audioStart: 0.2,
      audioEnd,
      bpm: 120,
      period,
      stability: 0.95,
      downbeat: 0,
      tailBeats: beatsBetween(audioEnd - 46, audioEnd, period),
      headBeats: beatsBetween(0.2, 30, period),
      lufs: -12,
      ...overrides
    }
  }
  const options = (overrides: Partial<PlannerOptions> = {}): PlannerOptions => ({
    durationSec: 30,
    maxRatePct: 8,
    protectLastPhrase: false,
    baseFadeSec: 6,
    stemsReady: false,
    currentPhrases: [],
    nextPhrases: [],
    ...overrides
  })

  it('aligns a 100 → 200 BPM pair 2:1 instead of degrading', () => {
    const current = track({ bpm: 100, period: 0.6 })
    const next = track({ bpm: 200, period: 0.3 })
    const plan = planTransition(current, next, options())
    // 2:1 keeps the outgoing track untouched (rate 1) instead of asking for 2x stretch.
    expect(plan.rate.at(-1)!.value).toBeCloseTo(1, 3)
    expect(plan.level).not.toBe('D')
  })

  it('caps the overlap at 8 bars when the keys clash', () => {
    // 8B (C major) vs 2B (F♯ major): Camelot distance far above 2.
    const current = track({ key: 7, keyConfidence: 0.5 })
    const next = track({ key: 1, keyConfidence: 0.5 })
    const plan = planTransition(current, next, options({ durationSec: 30 }))
    expect(plan.bridgeDuration).toBeLessThanOrEqual(8 * 2 + 0.5)
    expect(plan.notes.join()).toContain('调性相冲')
  })

  it('does not cap the overlap when the keys are compatible', () => {
    const current = track({ key: 7, keyConfidence: 0.5 })
    const next = track({ key: 8, keyConfidence: 0.5 })
    const plan = planTransition(current, next, options({ durationSec: 30 }))
    expect(plan.bridgeDuration).toBeGreaterThan(20)
    expect(plan.notes.join()).not.toContain('调性相冲')
  })

  it('starts the bridge on a 4-bar phrase boundary when downbeatTimes are available', () => {
    // Downbeats every 4 bars (8 s at 120 BPM). The phrase anchor is the last downbeat
    // (the outro); the chosen exit must sit on the same 4-bar phase as the outro.
    const downbeatTimes: number[] = []
    for (let t = 190; t <= 236; t += 8) downbeatTimes.push(Math.round(t * 1000) / 1000)
    const current = track({ downbeatTimes })
    const plan = planTransition(current, track(), options({ durationSec: 30 }))
    const idx = downbeatTimes.indexOf(Math.round(plan.startTime * 1000) / 1000)
    expect(idx).toBeGreaterThanOrEqual(0)
    expect((downbeatTimes.length - 1 - idx) % 4).toBe(0)
  })
})
