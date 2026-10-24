interface Biquad {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

/** ITU-R BS.1770 K-weighting: a high shelf at 1.68 kHz plus a 38 Hz high-pass. */
function kWeighting(sampleRate: number): [Biquad, Biquad] {
  const shelfF = 1681.974450955533
  const shelfG = 3.999843853973347
  const shelfQ = 0.7071752369554196
  let K = Math.tan((Math.PI * shelfF) / sampleRate)
  let Vh = Math.pow(10, shelfG / 20)
  let Vb = Math.pow(Vh, 0.4996667741545416)
  let a0 = 1 + K / shelfQ + K * K
  const shelf: Biquad = {
    b0: (Vh + (Vb * K) / shelfQ + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / shelfQ + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / shelfQ + K * K) / a0
  }

  const hpF = 38.13547087602444
  const hpQ = 0.5003270373238773
  K = Math.tan((Math.PI * hpF) / sampleRate)
  a0 = 1 + K / hpQ + K * K
  const hp: Biquad = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / hpQ + K * K) / a0
  }
  return [shelf, hp]
}

function applyBiquad(input: Float32Array, q: Biquad): Float32Array {
  const out = new Float32Array(input.length)
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i]!
    const y0 = q.b0 * x0 + q.b1 * x1 + q.b2 * x2 - q.a1 * y1 - q.a2 * y2
    out[i] = y0
    x2 = x1
    x1 = x0
    y2 = y1
    y1 = y0
  }
  return out
}

export interface LoudnessResult {
  lufs: number
  truePeakDb: number
}

/** Integrated loudness with the two-stage gate from BS.1770-4. */
export function integratedLoudness(pcm: Float32Array, sampleRate: number): LoudnessResult {
  if (pcm.length === 0) return { lufs: -70, truePeakDb: -120 }
  const [shelf, hp] = kWeighting(sampleRate)
  const filtered = applyBiquad(applyBiquad(pcm, shelf), hp)

  const block = Math.max(1, Math.round(sampleRate * 0.4))
  const step = Math.max(1, Math.round(block / 4))
  const blocks: number[] = []
  for (let start = 0; start + block <= filtered.length; start += step) {
    let sum = 0
    for (let i = start; i < start + block; i++) sum += filtered[i]! * filtered[i]!
    blocks.push(sum / block)
  }
  if (blocks.length === 0) {
    let sum = 0
    for (let i = 0; i < filtered.length; i++) sum += filtered[i]! * filtered[i]!
    blocks.push(sum / filtered.length)
  }

  const toLufs = (ms: number): number => -0.691 + 10 * Math.log10(Math.max(ms, 1e-12))
  const aboveAbsolute = blocks.filter((ms) => toLufs(ms) >= -70)
  const pool = aboveAbsolute.length > 0 ? aboveAbsolute : blocks
  const meanAbs = pool.reduce((a, b) => a + b, 0) / pool.length
  const relativeGate = toLufs(meanAbs) - 10
  const gated = pool.filter((ms) => toLufs(ms) >= relativeGate)
  const meanGated = gated.reduce((a, b) => a + b, 0) / Math.max(1, gated.length)

  let peak = 0
  for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]!))
  return { lufs: toLufs(meanGated), truePeakDb: 20 * Math.log10(Math.max(peak, 1e-6)) }
}

export interface SilenceSpan {
  leadSilence: number
  tailSilence: number
  audioStart: number
  audioEnd: number
}

/** Frame-RMS silence detection at -50 dBFS, 20 ms frames. */
export function detectSilenceBounds(
  pcm: Float32Array,
  sampleRate: number,
  durationSec: number,
  thresholdDb = -50
): SilenceSpan {
  const frame = Math.max(1, Math.round(sampleRate * 0.02))
  const frames = Math.floor(pcm.length / frame)
  if (frames === 0) return { leadSilence: 0, tailSilence: 0, audioStart: 0, audioEnd: durationSec }
  const threshold = Math.pow(10, thresholdDb / 20)
  const loud: boolean[] = new Array(frames)
  for (let f = 0; f < frames; f++) {
    let sum = 0
    for (let i = 0; i < frame; i++) {
      const v = pcm[f * frame + i]!
      sum += v * v
    }
    loud[f] = Math.sqrt(sum / frame) > threshold
  }
  let first = loud.indexOf(true)
  let last = loud.lastIndexOf(true)
  if (first < 0) return { leadSilence: 0, tailSilence: 0, audioStart: 0, audioEnd: durationSec }
  const frameSec = frame / sampleRate
  // Nothing shorter than 100 ms counts as music before/after; keeps a single click from
  // collapsing the whole transition window.
  if (first * frameSec < 0.1) first = 0
  if ((frames - 1 - last) * frameSec < 0.1) last = frames - 1
  const audioStart = first * frameSec
  const audioEnd = Math.min(durationSec, (last + 1) * frameSec)
  return {
    leadSilence: audioStart,
    tailSilence: Math.max(0, durationSec - audioEnd),
    audioStart,
    audioEnd
  }
}
