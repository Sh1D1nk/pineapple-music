import { describe, expect, it } from 'vitest'
import {
  integratedPosition,
  planTransition,
  type PlannerOptions,
  type TrackAnalysisLite
} from '../src/shared/transition/planner'

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
  protectLastPhrase: true,
  baseFadeSec: 6,
  stemsReady: false,
  currentPhrases: [],
  nextPhrases: [],
  ...overrides
})

describe('TransitionPlanner', () => {
  it('plans a C-level beat-aligned mix when stems are unavailable', () => {
    const plan = planTransition(track(), track({ bpm: 120 }), options())
    expect(plan.level).toBe('C')
    expect(plan.bridgeDuration).toBeGreaterThanOrEqual(28)
    expect(plan.vocalOut).toBeNull()
    expect(plan.alignmentErrorMs).toBeLessThan(20)
    expect(plan.currentGain.at(-1)?.value).toBe(0)
    expect(plan.nextGain[0]?.value).toBe(0)
    expect(plan.nextGain.at(-1)?.value).toBeGreaterThan(0.5)
    expect(plan.notes.join()).toContain('分轨未就绪')
  })

  it('starts the bridge on a bar line before the effective end', () => {
    const plan = planTransition(track(), track(), options())
    const downbeats = beatsBetween(190, 236, 0.5).filter((_, i) => i % 4 === 0)
    const nearest = Math.min(...downbeats.map((t) => Math.abs(t - plan.startTime)))
    expect(nearest).toBeLessThan(0.02)
    expect(plan.startTime + plan.bridgeDuration).toBeCloseTo(236, 0)
  })

  it('fades the current vocal out inside the first 40% when stems exist', () => {
    const plan = planTransition(
      track(),
      track({ bpm: 118 }),
      options({
        stemsReady: true,
        protectLastPhrase: false,
        currentPhrases: [
          { start: 196, end: 198 },
          { start: 203, end: 209 },
          { start: 218, end: 220 }
        ]
      })
    )
    expect(plan.level).toBe('A')
    expect(plan.vocalOut).not.toBeNull()
    expect(plan.vocalOut!.start).toBeLessThanOrEqual(plan.bridgeDuration * 0.42)
    expect(plan.vocalOut!.start).toBeGreaterThanOrEqual(1.5)
    expect(plan.rate.at(-1)!.value).toBeCloseTo(120 / 118, 1)
  })

  it('ramps 100 → 108 BPM without pitch change and keeps the error under 20 ms', () => {
    const current = track({ bpm: 100, period: 0.6, audioEnd: 236, tailBeats: beatsBetween(190, 236, 0.6) })
    const next = track({ bpm: 108, period: 60 / 108, headBeats: beatsBetween(0.3, 30, 60 / 108) })
    const plan = planTransition(current, next, options({ stemsReady: true }))
    expect(plan.level).toBe('A')
    expect(plan.rate.at(-1)!.value).toBeCloseTo(0.6 / (60 / 108), 2)
    for (let i = 1; i < plan.rate.length; i++) {
      expect(plan.rate[i]!.value).toBeGreaterThanOrEqual(plan.rate[i - 1]!.value - 1e-6)
    }
    expect(plan.alignmentErrorMs).toBeLessThan(20)
  })

  it('uses a high-pass filter cut when the tempo gap exceeds the allowed range', () => {
    const current = track({ bpm: 100, period: 0.6 })
    const next = track({ bpm: 130, period: 60 / 130 })
    const plan = planTransition(current, next, options({ stemsReady: true, maxRatePct: 8 }))
    expect(plan.level).toBe('C')
    expect(plan.technique).toBe('filtercut')
    expect(plan.highpassSweep).toEqual({ fromHz: 300, toHz: 18000 })
    expect(plan.rate.at(-1)!.value).toBe(1)
    expect(plan.bridgeDuration).toBeLessThanOrEqual(8 * 2 + 0.5)
    expect(plan.notes.join()).toContain('高通扫频')
  })

  it('drops to D when the beat grid is unreliable', () => {
    const plan = planTransition(
      track({ stability: 0.2 }),
      track({ stability: 0.2 }),
      options({ baseFadeSec: 6 })
    )
    expect(plan.level).toBe('D')
    expect(plan.bridgeDuration).toBeCloseTo(6, 1)
    expect(plan.startTime + plan.bridgeDuration).toBeCloseTo(236, 0)
  })

  it('shortens or skips the transition when the last phrase hugs the end', () => {
    const plan = planTransition(
      track(),
      track(),
      options({
        stemsReady: true,
        currentPhrases: [{ start: 234.5, end: 235.6 }]
      })
    )
    expect(plan.level).toBe('D')
    expect(plan.notes.join()).toContain('末句')
  })

  it('moves the start past a protected last phrase instead of cutting it', () => {
    const plan = planTransition(
      track(),
      track(),
      options({ stemsReady: true, currentPhrases: [{ start: 213, end: 216 }] })
    )
    expect(plan.startTime).toBeGreaterThanOrEqual(216.3)
    expect(plan.bridgeDuration).toBeLessThanOrEqual(20)
  })

  it('skips at most 8 bars of a very long intro', () => {
    const next = track({ bpm: 120, headBeats: beatsBetween(60, 90, 0.5) })
    const plan = planTransition(track({ bpm: 120 }), next, options())
    const bar = 0.5 * 4
    expect(plan.nextStartOffset - 60).toBeLessThanOrEqual(8 * bar + 0.01)
    expect(plan.alignmentErrorMs).toBeLessThan(20)
  })

  it('keeps a continuous album pair gapless', () => {
    const plan = planTransition(
      track({ audioEnd: 240, duration: 240 }),
      track({ audioStart: 0, audioEnd: 200 }),
      options({ sameAlbum: true, consecutive: true })
    )
    expect(plan.level).toBe('E')
    expect(plan.bridgeDuration).toBe(0)
  })

  it('integrates a time-varying rate exactly', () => {
    const rate = [
      { at: 0, value: 1 },
      { at: 5, value: 1.1 },
      { at: 10, value: 1.1 }
    ]
    const pos = integratedPosition(rate, 10, 0.0005)
    expect(pos).toBeGreaterThan(10.4)
    expect(pos).toBeLessThan(10.6)
  })

  it('matches the loudness of the two tracks with a bounded gain', () => {
    const quieterNext = planTransition(track({ lufs: -8 }), track({ lufs: -16 }), options())
    expect(quieterNext.nextGain.at(-1)!.value).toBeCloseTo(1.9, 2)
    const louderNext = planTransition(track({ lufs: -16 }), track({ lufs: -8 }), options())
    expect(louderNext.nextGain.at(-1)!.value).toBeGreaterThan(0.5)
    expect(louderNext.nextGain.at(-1)!.value).toBeLessThan(0.6)
  })
})
