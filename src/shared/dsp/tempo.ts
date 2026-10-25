import { hannWindow, magnitudeSpectrum } from './fft'

export interface OnsetEnvelope {
  env: Float32Array
  /** Low-band onset (kick / bass transients only), same length as `env`. */
  lowEnv: Float32Array
  /** seconds per envelope frame */
  hopSec: number
}

/**
 * Log-compressed spectral flux, the classic percussive onset function. It is deliberately
 * broadband: kick, snare and hats all contribute, which is what a tempo estimator wants.
 * A low-band copy (first ~200 Hz) is emitted alongside: the downbeat estimator weights it,
 * because kick drums land on downbeats far more reliably than hats do.
 */
export function onsetEnvelope(pcm: Float32Array, sampleRate: number): OnsetEnvelope {
  const frameSize = 1024
  const hop = 512
  const win = hannWindow(frameSize)
  const frames = Math.max(0, Math.floor((pcm.length - frameSize) / hop) + 1)
  const flux = new Float32Array(frames)
  const lowFlux = new Float32Array(frames)
  // binHz at 44.1 kHz / 1024 ≈ 43 Hz → bins 1..5 cover ~43-215 Hz.
  const lowBinMax = Math.max(1, Math.min(5, Math.floor(200 / (sampleRate / frameSize))))
  let prev: Float64Array | null = null
  const frame = new Float64Array(frameSize)

  for (let f = 0; f < frames; f++) {
    const off = f * hop
    for (let i = 0; i < frameSize; i++) frame[i] = pcm[off + i] ?? 0
    const mag = magnitudeSpectrum(frame, win)
    let sum = 0
    let lowSum = 0
    if (prev) {
      for (let i = 1; i < mag.length; i++) {
        const v = Math.log1p(mag[i]! * 10)
        const d = v - prev[i]!
        if (d > 0) {
          sum += d
          if (i <= lowBinMax) lowSum += d
        }
      }
    }
    prev = new Float64Array(mag.length)
    for (let i = 1; i < mag.length; i++) prev[i] = Math.log1p(mag[i]! * 10)
    flux[f] = sum
    lowFlux[f] = lowSum
  }

  // Remove the local mean (a ~0.4 s moving average) and half-wave rectify, so a sustained
  // pad does not read as one long onset.
  const rectify = (fluxArr: Float32Array): Float32Array => {
    const out = new Float32Array(frames)
    const radius = Math.max(1, Math.round(0.2 / (hop / sampleRate)))
    for (let i = 0; i < frames; i++) {
      let acc = 0
      let count = 0
      for (let j = Math.max(0, i - radius); j <= Math.min(frames - 1, i + radius); j++) {
        acc += fluxArr[j]!
        count++
      }
      const running = acc / Math.max(1, count)
      out[i] = Math.max(0, fluxArr[i]! - running)
    }
    return out
  }
  const env = rectify(flux)
  const lowRaw = rectify(lowFlux)
  // Normalise to 0..1 by the 99th percentile, so absolute levels do not matter.
  const normalise99 = (arr: Float32Array): Float32Array => {
    const sorted = Float32Array.from(arr).sort()
    const p99 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] ?? 0
    if (p99 <= 0) return arr
    for (let i = 0; i < arr.length; i++) arr[i] = arr[i]! / p99
    return arr
  }
  normalise99(env)
  normalise99(lowRaw)
  return { env, lowEnv: lowRaw, hopSec: hop / sampleRate }
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

/* ------------------------------------------------------------------ DP beat tracking
 *
 * Ported from HyPlayer-Nextgen (Analysis/Dsp/BeatTracker.cs), which is itself the classic
 * Ellis (2007) dynamic-programming beat tracker. Unlike `trackBeats` above — a fixed grid
 * with local snapping — the DP path solves for the globally best beat sequence, so tempo
 * drift and rubato passages stay locked instead of sliding off after a bar or two.
 */

export interface BeatTrackDP {
  bpm: number
  /** 0..1 blend of onset salience at beats and inter-beat-interval regularity. */
  confidence: number
  /** Absolute beat times (seconds, already offset by windowStartSec). */
  beatTimes: number[]
  /** Downbeat subset of beatTimes (every 4th, phase chosen by low-band energy). */
  downbeatTimes: number[]
  /** Index of the downbeat phase inside the beat sequence (0..3), compatible with grid.downbeat. */
  downbeatPhase: number
}

/** Local-maximum comb filter tempo with a 120 BPM prior; ~Ellis EstimateTempo. */
function dpEstimateTempo(onset: Float32Array, fps: number, minBpm: number, maxBpm: number): number {
  const minLag = Math.max(2, Math.floor((fps * 60) / maxBpm))
  const maxLag = Math.min(onset.length - 2, Math.ceil((fps * 60) / minBpm))
  const n = onset.length
  if (maxLag >= n / 2 || maxLag < minLag) return 0
  const ac = new Float64Array(maxLag + 2)
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    if (lag <= 0) continue
    let acc = 0
    for (let i = lag; i < n; i++) acc += onset[i]! * onset[i - lag]!
    ac[lag] = acc / (n - lag)
  }
  let bestLag = -1
  let best = -Infinity
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (fps * 60) / lag
    const priorV = Math.exp(-0.5 * Math.log2(bpm / 120) ** 2)
    const harmonic = ac[lag]! + (2 * lag <= maxLag + 1 ? 0.5 * ac[2 * lag]! : 0)
    const score = harmonic * priorV
    if (score > best) {
      best = score
      bestLag = lag
    }
  }
  if (bestLag <= 0) return 0
  const y0 = ac[bestLag - 1]!
  const y1 = ac[bestLag]!
  const y2 = ac[bestLag + 1]!
  const denom = y0 - 2 * y1 + y2
  const offset = Math.abs(denom) > 1e-12 ? (0.5 * (y0 - y2)) / denom : 0
  return (fps * 60) / (bestLag + Math.max(-0.5, Math.min(0.5, offset)))
}

/** Ellis dynamic programming: the globally best beat sequence through the onset envelope. */
function trackDp(onset: Float32Array, period: number, tightness: number): number[] {
  const n = onset.length
  const local = new Float64Array(n)
  const radius = Math.max(1, Math.round(period))
  const kernel = new Float64Array(2 * radius + 1)
  for (let k = -radius; k <= radius; k++) kernel[k + radius] = Math.exp(-0.5 * ((k * 32) / period) ** 2)
  for (let i = 0; i < n; i++) {
    let acc = 0
    for (let k = -radius; k <= radius; k++) {
      const j = i + k
      if (j >= 0 && j < n) acc += onset[j]! * kernel[k + radius]!
    }
    local[i] = acc
  }

  const cumscore = new Float64Array(n)
  const backlink = new Int32Array(n)
  const windowStart = Math.round(2 * period)
  const windowEnd = Math.max(1, Math.round(period / 2))
  let maxLocal = 0
  for (let i = 0; i < n; i++) maxLocal = Math.max(maxLocal, local[i]!)
  let first = true
  for (let i = 0; i < n; i++) {
    let bestScore = -Infinity
    let bestIndex = -1
    for (let lag = windowEnd; lag <= windowStart; lag++) {
      const j = i - lag
      if (j < 0) break
      const penalty = -tightness * Math.log(lag / period) ** 2
      const score = cumscore[j]! + penalty
      if (score > bestScore) {
        bestScore = score
        bestIndex = j
      }
    }
    if (bestIndex < 0 || (first && local[i]! < 0.01 * maxLocal)) {
      cumscore[i] = local[i]!
      backlink[i] = -1
    } else {
      cumscore[i] = local[i]! + bestScore
      backlink[i] = bestIndex
      first = false
    }
  }

  // Start backtracking from the last strong peak above half the median peak height.
  const maxima: number[] = []
  for (let i = 1; i < n - 1; i++) {
    if (cumscore[i]! >= cumscore[i - 1]! && cumscore[i]! >= cumscore[i + 1]!) maxima.push(cumscore[i]!)
  }
  if (maxima.length === 0) return []
  maxima.sort((a, b) => a - b)
  const threshold = 0.5 * maxima[Math.floor(maxima.length / 2)]!
  let tail = -1
  for (let i = n - 2; i >= 1; i--) {
    if (cumscore[i]! >= cumscore[i - 1]! && cumscore[i]! >= cumscore[i + 1]! && cumscore[i]! > threshold) {
      tail = i
      break
    }
  }
  if (tail < 0) return []

  const beats: number[] = []
  for (let b = tail; b >= 0; b = backlink[b]!) beats.push(b)
  beats.reverse()

  // Trim weak beats at both ends (intro fade-in / outro fade-out have no clean onsets).
  let sumSq = 0
  for (const b of beats) sumSq += local[b]! ** 2
  const rms = Math.sqrt(sumSq / Math.max(1, beats.length))
  const trim = 0.5 * rms
  let start = 0
  while (start < beats.length && local[beats[start]!]! < trim) start++
  let end = beats.length - 1
  while (end > start && local[beats[end]!]! < trim) end--
  return beats.slice(start, end + 1)
}

/** Parabolic refinement of a beat frame against the onset envelope. */
function dpRefine(onset: Float32Array, frame: number): number {
  let best = frame
  for (let k = Math.max(1, frame - 2); k <= Math.min(onset.length - 2, frame + 2); k++) {
    if (onset[k]! > onset[best]!) best = k
  }
  if (best <= 0 || best >= onset.length - 1) return best
  const y0 = onset[best - 1]!
  const y1 = onset[best]!
  const y2 = onset[best + 1]!
  const denom = y0 - 2 * y1 + y2
  if (Math.abs(denom) < 1e-9) return best
  return best + Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denom))
}

/** Downbeat phase from low-band energy: kicks land on 1 far more often than hats do. */
function dpDownbeatPhase(beats: number[], lowEnv: Float32Array, env: Float32Array, hopSec: number): number {
  if (beats.length < 8) return 0
  const low = new Float64Array(beats.length)
  const all = new Float64Array(beats.length)
  for (let i = 0; i < beats.length; i++) {
    const f = Math.round(beats[i]! / hopSec)
    let l = 0
    let a = 0
    for (let k = Math.max(0, f - 2); k <= Math.min(env.length - 1, f + 2); k++) {
      l = Math.max(l, lowEnv[k]!)
      a = Math.max(a, env[k]!)
    }
    low[i] = l
    all[i] = a
  }
  let bestPhase = 0
  let bestScore = -Infinity
  for (let phase = 0; phase < 4; phase++) {
    let score = 0
    let count = 0
    for (let i = phase; i < beats.length; i += 4) {
      score += 2 * low[i]! + all[i]!
      count++
    }
    score /= Math.max(1, count)
    if (score > bestScore) {
      bestScore = score
      bestPhase = phase
    }
  }
  return bestPhase
}

function dpConfidence(
  onset: Float32Array,
  beatFrames: number[],
  sortedIbi: number[],
  medianIbi: number
): number {
  if (beatFrames.length === 0) return 0
  let mean = 0
  for (const v of onset) mean += v
  mean /= Math.max(1, onset.length)
  let atBeats = 0
  for (const f of beatFrames) atBeats += onset[f]!
  atBeats /= beatFrames.length
  const salience = mean > 0 ? Math.max(0, Math.min(1, (atBeats / mean - 1) / 3)) : 0
  const inner = sortedIbi.slice(Math.floor(sortedIbi.length / 10), Math.max(1, sortedIbi.length * 0.8))
  const avg = inner.reduce((a, b) => a + b, 0) / Math.max(1, inner.length)
  const std = Math.sqrt(
    inner.reduce((a, b) => a + (b - avg) ** 2, 0) / Math.max(1, inner.length - 1)
  )
  const regularity = Math.max(0, Math.min(1, 1 - std / (0.1 * medianIbi)))
  return Math.round((0.5 * salience + 0.5 * regularity) * 1000) / 1000
}

/**
 * Full DP beat tracking over one analysis window. Falls back to an empty result when the
 * window is too short for any sensible grid; the caller keeps its old estimate in that case.
 */
export function trackBeatsDP(
  env: Float32Array,
  lowEnv: Float32Array,
  hopSec: number,
  windowStartSec: number
): BeatTrackDP {
  const fps = 1 / hopSec
  const empty: BeatTrackDP = { bpm: 0, confidence: 0, beatTimes: [], downbeatTimes: [], downbeatPhase: 0 }
  if (env.length < fps * 8) return empty

  const bpm = dpEstimateTempo(env, fps, 60, 200)
  if (bpm <= 0) return empty
  const period = fps * 60 / bpm
  const frames = trackDp(env, period, 100)
  if (frames.length < 8) return empty

  const times = frames.map((f) => dpRefine(env, f) * hopSec + windowStartSec)
  const ibis: number[] = []
  for (let i = 1; i < times.length; i++) ibis.push(times[i]! - times[i - 1]!)
  const sorted = [...ibis].sort((a, b) => a - b)
  const medianIbi = sorted[Math.floor(sorted.length / 2)]!
  const refinedBpm = 60 / medianIbi

  const phase = dpDownbeatPhase(times, lowEnv, env, hopSec)
  const downbeatTimes: number[] = []
  for (let i = phase; i < times.length; i += 4) downbeatTimes.push(times[i]!)
  const confidence = dpConfidence(env, frames, sorted, medianIbi)
  return {
    bpm: Math.round(refinedBpm * 100) / 100,
    confidence,
    beatTimes: times.map((t) => Math.round(t * 1000) / 1000),
    downbeatTimes: downbeatTimes.map((t) => Math.round(t * 1000) / 1000),
    downbeatPhase: phase
  }
}

/** 2x / 0.5x half- or double-time alignment, ported from AutoMixPlanner.BestRate. */
export function bestRateMultiplier(bpmA: number, bpmB: number): { rate: number; multiplier: number } {
  let best = { rate: bpmA / bpmB, multiplier: 1 }
  for (const m of [2, 0.5]) {
    const rate = bpmA / (bpmB * m)
    if (Math.abs(rate - 1) < Math.abs(best.rate - 1)) best = { rate, multiplier: m }
  }
  return best
}
