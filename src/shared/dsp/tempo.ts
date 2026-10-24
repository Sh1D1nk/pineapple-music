import { hannWindow, magnitudeSpectrum } from './fft'

export interface OnsetEnvelope {
  env: Float32Array
  /** seconds per envelope frame */
  hopSec: number
}

/**
 * Log-compressed spectral flux, the classic percussive onset function. It is deliberately
 * broadband: kick, snare and hats all contribute, which is what a tempo estimator wants.
 */
export function onsetEnvelope(pcm: Float32Array, sampleRate: number): OnsetEnvelope {
  const frameSize = 1024
  const hop = 512
  const win = hannWindow(frameSize)
  const frames = Math.max(0, Math.floor((pcm.length - frameSize) / hop) + 1)
  const flux = new Float32Array(frames)
  let prev: Float64Array | null = null
  const frame = new Float64Array(frameSize)

  for (let f = 0; f < frames; f++) {
    const off = f * hop
    for (let i = 0; i < frameSize; i++) frame[i] = pcm[off + i] ?? 0
    const mag = magnitudeSpectrum(frame, win)
    let sum = 0
    if (prev) {
      for (let i = 1; i < mag.length; i++) {
        const v = Math.log1p(mag[i]! * 10)
        const d = v - prev[i]!
        if (d > 0) sum += d
      }
    }
    prev = new Float64Array(mag.length)
    for (let i = 1; i < mag.length; i++) prev[i] = Math.log1p(mag[i]! * 10)
    flux[f] = sum
  }

  // Remove the local mean (a ~0.4 s moving average) and half-wave rectify, so a sustained
  // pad does not read as one long onset.
  const env = new Float32Array(frames)
  const radius = Math.max(1, Math.round(0.2 / (hop / sampleRate)))
  let running = 0
  for (let i = 0; i < frames; i++) {
    let acc = 0
    let count = 0
    for (let j = Math.max(0, i - radius); j <= Math.min(frames - 1, i + radius); j++) {
      acc += flux[j]!
      count++
    }
    running = acc / Math.max(1, count)
    env[i] = Math.max(0, flux[i]! - running)
  }
  // Normalise to 0..1 by the 99th percentile, so absolute levels do not matter.
  const sorted = Float32Array.from(env).sort()
  const p99 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] ?? 0
  if (p99 > 0) for (let i = 0; i < frames; i++) env[i] = env[i]! / p99
  return { env, hopSec: hop / sampleRate }
}

function normalise(arr: Float32Array): Float32Array {
  let max = 0
  for (let i = 0; i < arr.length; i++) max = Math.max(max, arr[i]!)
  if (max <= 0) return arr
  const out = new Float32Array(arr.length)
  for (let i = 0; i < arr.length; i++) out[i] = arr[i]! / max
  return out
}

/** Autocorrelation via direct summation; envelope lengths here are a few thousand frames. */
export function autocorrelation(env: Float32Array, maxLag: number): Float32Array {
  const out = new Float32Array(maxLag + 1)
  const n = env.length
  for (let lag = 0; lag <= maxLag; lag++) {
    let acc = 0
    let count = 0
    for (let i = 0; i + lag < n; i++) {
      acc += env[i]! * env[i + lag]!
      count++
    }
    out[lag] = count > 0 ? acc / count : 0
  }
  return out
}

export interface TempoEstimate {
  bpm: number
  confidence: number
  candidates: number[]
  beatPeriod: number
  /** phase in frames, relative to the first frame of the envelope */
  phaseFrames: number
  downbeat: number
}

const MIN_BPM = 50
const MAX_BPM = 210

function prior(bpm: number): number {
  // log-normal around 120 BPM; wide enough not to fight a genuine 70 or 180.
  const x = Math.log2(bpm / 120)
  return Math.exp(-(x * x) / (2 * 0.62 * 0.62))
}

/**
 * Tempo + beat phase from a spectral-flux envelope. Comb-filter scoring over the first four
 * harmonics keeps a subdivided hi-hat pattern from winning at double tempo.
 */
export function estimateTempo(env: Float32Array, hopSec: number): TempoEstimate {
  const minLag = Math.max(2, Math.floor(60 / MAX_BPM / hopSec))
  const maxLag = Math.min(env.length - 2, Math.ceil(60 / MIN_BPM / hopSec))
  const acf = autocorrelation(env, Math.min(env.length - 1, maxLag * 4))
  const scored: { lag: number; score: number; bpm: number }[] = []
  for (let lag = minLag; lag <= maxLag; lag++) {
    let comb = 0
    for (let k = 1; k <= 4; k++) {
      const l = Math.round(lag * k)
      if (l >= acf.length) break
      comb += acf[l]! / k
    }
    const bpm = 60 / (lag * hopSec)
    scored.push({ lag, score: comb * prior(bpm), bpm })
  }
  scored.sort((a, b) => b.score - a.score)
  const best = scored[0]
  if (!best) {
    return { bpm: 120, confidence: 0, candidates: [], beatPeriod: 60 / 120 / hopSec, phaseFrames: 0, downbeat: 0 }
  }

  // Parabolic refinement around the winning lag.
  const rawScore = (lag: number): number => {
    let comb = 0
    for (let k = 1; k <= 4; k++) {
      const l = Math.round(lag * k)
      if (l >= acf.length) break
      comb += acf[l]! / k
    }
    return comb * prior(60 / (lag * hopSec))
  }
  const s0 = rawScore(best.lag - 1)
  const s1 = best.score
  const s2 = rawScore(best.lag + 1)
  const denom = s0 - 2 * s1 + s2
  const delta = Math.abs(denom) > 1e-9 ? (0.5 * (s0 - s2)) / denom : 0
  const refinedLag = best.lag + Math.max(-0.5, Math.min(0.5, delta))
  const bpm = Math.max(MIN_BPM, Math.min(MAX_BPM, 60 / (refinedLag * hopSec)))

  const candidates = [...new Set(scored.slice(0, 8).map((s) => Math.round(s.bpm * 10) / 10))]
  const second = scored[1]?.score ?? 0
  const confidence = s1 > 0 ? Math.max(0, Math.min(1, 1 - second / s1)) : 0

  const period = 60 / bpm / hopSec
  const { phase, downbeat } = bestPhase(env, period)
  return { bpm, confidence, candidates, beatPeriod: period, phaseFrames: phase, downbeat }
}

/** Brute-force beat phase over one period, plus the best of four downbeat offsets. */
export function bestPhase(env: Float32Array, periodFrames: number): { phase: number; downbeat: number } {
  let bestPhaseValue = 0
  let bestScore = -1
  const steps = Math.max(8, Math.min(200, Math.round(periodFrames * 4)))
  for (let s = 0; s < steps; s++) {
    const phase = (s / steps) * periodFrames
    const score = pulseScore(env, periodFrames, phase)
    if (score > bestScore) {
      bestScore = score
      bestPhaseValue = phase
    }
  }
  let downbeat = 0
  let bestBar = -1
  for (let b = 0; b < 4; b++) {
    let score = 0
    for (let k = 0; ; k++) {
      const idx = Math.round(bestPhaseValue + (b + k * 4) * periodFrames)
      if (idx >= env.length) break
      score += env[idx]!
    }
    if (score > bestBar) {
      bestBar = score
      downbeat = b
    }
  }
  return { phase: bestPhaseValue, downbeat }
}

function pulseScore(env: Float32Array, period: number, phase: number): number {
  let score = 0
  const kernel = 1.5
  for (let k = 0; ; k++) {
    const center = phase + k * period
    const lo = Math.max(0, Math.floor(center - kernel))
    const hi = Math.min(env.length - 1, Math.ceil(center + kernel))
    if (lo > env.length - 1) break
    let local = 0
    for (let i = lo; i <= hi; i++) {
      const w = Math.max(0, 1 - Math.abs(i - center) / (kernel + 0.001))
      local = Math.max(local, env[i]! * w)
    }
    score += local
  }
  return score
}

export interface BeatTrack {
  beatTimes: number[]
  stability: number
  periodSec: number
  downbeat: number
}

/**
 * Beat times for a window: walk the grid from the estimated phase, snap each predicted beat to
 * the strongest nearby onset, then report how regular the result is.
 */
export function trackBeats(
  env: Float32Array,
  hopSec: number,
  tempo: TempoEstimate,
  windowStartSec: number,
  maxBeats = 400
): BeatTrack {
  const period = tempo.beatPeriod
  const periodSec = period * hopSec
  const beats: number[] = []
  let k = 0
  for (; k < maxBeats * 4; k++) {
    const pos = tempo.phaseFrames + k * period
    if (pos >= env.length - 1) break
    const search = Math.max(1, Math.round(period * 0.16))
    const lo = Math.max(0, Math.floor(pos) - search)
    const hi = Math.min(env.length - 1, Math.ceil(pos) + search)
    let bestIdx = Math.round(pos)
    let bestVal = -1
    for (let i = lo; i <= hi; i++) {
      if (env[i]! > bestVal) {
        bestVal = env[i]!
        bestIdx = i
      }
    }
    // Only trust the snap when there is actually an onset there.
    const idx = bestVal >= 0.25 ? bestIdx : pos
    const t = windowStartSec + idx * hopSec
    if (beats.length === 0 || t > beats[beats.length - 1]! + periodSec * 0.5) {
      beats.push(Math.round(t * 1000) / 1000)
    }
    if (beats.length >= maxBeats) break
  }

  let stability = 1
  if (beats.length >= 4) {
    const diffs: number[] = []
    for (let i = 1; i < beats.length; i++) diffs.push(beats[i]! - beats[i - 1]!)
    const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length
    const variance = diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / diffs.length
    const cv = mean > 0 ? Math.sqrt(variance) / mean : 1
    stability = Math.max(0, Math.min(1, 1 - cv * 6))
  } else {
    stability = 0
  }
  return { beatTimes: beats, stability, periodSec, downbeat: tempo.downbeat }
}

export { normalise }
