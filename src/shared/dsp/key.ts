/**
 * Camelot key estimation — ported from HyPlayer-Nextgen (Analysis/Dsp/KeyEstimator.cs).
 *
 * Chroma energy from an FFT magnitude spectrum, correlated against the Krumhansl-Schmuckler
 * major/minor profiles, then mapped onto the Camelot wheel so two tracks can be compared with
 * a single "distance" number that DJs actually use: same number opposite mode = 1, adjacent
 * number same mode = 1, adjacent number opposite mode = 2, everything else ≥ 3.
 */

import { hannWindow, magnitudeSpectrum } from './fft'

export interface KeyEstimate {
  /**
   * Camelot slot encoded as 0..23: 0..11 = major wheels 1B..12B (value = wheel - 1),
   * 12..23 = minor wheels 1A..12A (value = wheel + 11). -1 = unknown.
   */
  key: number
  confidence: number
}

/** Krumhansl-Schmuckler profiles, indexed from C. */
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

/**
 * Camelot wheel position for each pitch class (C=0).
 * Major: C=8B, G=9B, D=10B ... (each perfect fifth steps +1 on the wheel).
 * Minor: relative minors share the number with their relative major, so C minor = 5A (E♭=5B).
 */
const MAJOR_WHEEL = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1]
const MINOR_WHEEL = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10]

function correlation(a: number[], b: number[]): number {
  const n = a.length
  let ma = 0
  let mb = 0
  for (let i = 0; i < n; i++) {
    ma += a[i]!
    mb += b[i]!
  }
  ma /= n
  mb /= n
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma
    const y = b[i]! - mb
    num += x * y
    da += x * x
    db += y * y
  }
  const denom = Math.sqrt(da * db)
  return denom > 1e-12 ? num / denom : 0
}

/**
 * 12-bin chroma from a mono PCM signal. Only 80–2000 Hz contributes: below that the FFT
 * resolution smears pitch classes together, above that harmonics dominate the fundamental.
 */
export function chroma(pcm: Float32Array, sampleRate: number): number[] {
  const frameSize = 4096
  const hop = 2048
  const win = hannWindow(frameSize)
  const bins = frameSize / 2
  const binHz = sampleRate / frameSize
  const minBin = Math.max(1, Math.floor(80 / binHz))
  const maxBin = Math.min(bins - 1, Math.ceil(2000 / binHz))
  const out = new Array<number>(12).fill(0)
  const frame = new Float64Array(frameSize)
  const binPitch = new Int16Array(bins)
  for (let b = minBin; b <= maxBin; b++) {
    const hz = b * binHz
    if (hz <= 0) continue
    const midi = 69 + 12 * Math.log2(hz / 440)
    binPitch[b] = Math.round(midi) % 12
  }

  const frames = Math.max(0, Math.floor((pcm.length - frameSize) / hop) + 1)
  const stride = Math.max(1, Math.floor(frames / 600)) // cap work: ~600 frames is plenty for a key
  let used = 0
  for (let f = 0; f < frames; f += stride) {
    const off = f * hop
    for (let i = 0; i < frameSize; i++) frame[i] = pcm[off + i] ?? 0
    const mag = magnitudeSpectrum(frame, win)
    for (let b = minBin; b <= maxBin; b++) {
      const m = mag[b]!
      if (m > 0) out[binPitch[b]!] = (out[binPitch[b]!] ?? 0) + m * m
    }
    used++
  }
  if (used === 0) return out
  // Log-compress so one loud chord does not flatten everything else.
  for (let i = 0; i < 12; i++) out[i] = Math.log1p(out[i]!)
  return out
}

export function estimateKey(pcm: Float32Array, sampleRate: number): KeyEstimate {
  const c = chroma(pcm, sampleRate)
  let energy = 0
  for (const v of c) energy += v
  if (energy <= 0) return { key: -1, confidence: 0 }

  let best = -1
  let bestScore = -Infinity
  let secondScore = -Infinity
  // Rotation r means "profile root sits on pitch class r".
  for (let r = 0; r < 12; r++) {
    const rotated = c.slice(r).concat(c.slice(0, r))
    const maj = correlation(rotated, MAJOR_PROFILE)
    const min = correlation(rotated, MINOR_PROFILE)
    if (maj > bestScore) {
      secondScore = bestScore
      bestScore = maj
      best = MAJOR_WHEEL[r]! - 1 // major slot: wheel-1, 0..11
    } else if (maj > secondScore) secondScore = maj
    if (min > bestScore) {
      secondScore = bestScore
      bestScore = min
      best = MINOR_WHEEL[r]! + 11 // minor slot: wheel+11, 12..23
    } else if (min > secondScore) secondScore = min
  }
  if (best < 0) return { key: -1, confidence: 0 }
  // Confidence: margin between the two best candidate correlations. A clear key wins by a lot.
  const confidence = Math.max(0, Math.min(1, bestScore - Math.max(0, secondScore)))
  return { key: best, confidence: Math.round(confidence * 1000) / 1000 }
}

function wheelOf(key: number): number {
  return key < 12 ? key + 1 : key - 11
}
function isMinor(key: number): boolean {
  return key >= 12
}

/** DJ Camelot distance: 0 same slot, 1 = energy-compatible mix, ≥3 = clashing keys. */
export function camelotDistance(a: number, b: number): number {
  if (a < 0 || b < 0) return 0
  const wa = wheelOf(a)
  const wb = wheelOf(b)
  const ring = Math.min(Math.abs(wa - wb), 12 - Math.abs(wa - wb))
  const sameMode = isMinor(a) === isMinor(b)
  if (ring === 0) return sameMode ? 0 : 1
  if (ring === 1) return sameMode ? 1 : 2
  return sameMode ? ring + 1 : ring
}
