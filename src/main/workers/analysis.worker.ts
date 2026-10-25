import { parentPort } from 'node:worker_threads'
import { estimateTempo, onsetEnvelope, trackBeats, trackBeatsDP } from '@shared/dsp/tempo'
import { estimateKey } from '@shared/dsp/key'

export interface AnalyzeRequest {
  id: number
  sampleRate: number
  head: Float32Array
  headStart: number
  tail: Float32Array
  tailStart: number
}

export interface AnalyzeOk {
  id: number
  ok: true
  bpm: number
  bpmConfidence: number
  bpmCandidates: number[]
  period: number
  stability: number
  downbeat: number
  tailBeats: number[]
  headBeats: number[]
  /** Absolute downbeat times per window (DP tracker); empty when the DP path did not win. */
  tailDownbeats: number[]
  headDownbeats: number[]
  /** Camelot slot 0..23 (see shared/dsp/key.ts), -1 = unknown. */
  key: number
  keyConfidence: number
  engine: string
}

export interface AnalyzeFail {
  id: number
  ok: false
  error: string
}

export type AnalyzeResponse = AnalyzeOk | AnalyzeFail

function rms(pcm: Float32Array): number {
  let sum = 0
  const step = Math.max(1, Math.floor(pcm.length / 20000))
  let count = 0
  for (let i = 0; i < pcm.length; i += step) {
    sum += pcm[i]! * pcm[i]!
    count++
  }
  return Math.sqrt(sum / Math.max(1, count))
}

interface WindowTrack {
  beatTimes: number[]
  downbeatTimes: number[]
  downbeatPhase: number
  stability: number
  engine: string
}

/** DP tracker first (globally optimal), grid-snapping tracker as the fallback. */
function trackWindow(
  pcm: Float32Array,
  sampleRate: number,
  windowStartSec: number
): WindowTrack {
  const env = onsetEnvelope(pcm, sampleRate)
  const dp = trackBeatsDP(env.env, env.lowEnv, env.hopSec, windowStartSec)
  if (dp.beatTimes.length >= 8 && dp.confidence >= 0.2) {
    // Stability from inter-beat intervals, same definition the legacy tracker reports.
    const diffs: number[] = []
    for (let i = 1; i < dp.beatTimes.length; i++) diffs.push(dp.beatTimes[i]! - dp.beatTimes[i - 1]!)
    let stability = 0
    if (diffs.length >= 4) {
      const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length
      const variance = diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / diffs.length
      const cv = mean > 0 ? Math.sqrt(variance) / mean : 1
      stability = Math.max(0, Math.min(1, 1 - cv * 6))
    }
    return {
      beatTimes: dp.beatTimes,
      downbeatTimes: dp.downbeatTimes,
      downbeatPhase: dp.downbeatPhase,
      stability: Math.round(stability * 100) / 100,
      engine: 'dp-beat-tracking'
    }
  }
  const tempo = estimateTempo(env.env, env.hopSec)
  const track = trackBeats(env.env, env.hopSec, tempo, windowStartSec, 600)
  return {
    beatTimes: track.beatTimes,
    downbeatTimes: [],
    downbeatPhase: tempo.downbeat,
    stability: track.stability,
    engine: 'spectral-flux-autocorrelation'
  }
}

export function analyzeWindows(req: Omit<AnalyzeRequest, 'id'>): AnalyzeOk {
  const tailEnergy = rms(req.tail)
  const headEnergy = rms(req.head)
  // Prefer the louder window for the tempo estimate; a fade-out outro has no transients.
  const primaryIsTail = tailEnergy >= headEnergy * 0.7
  const primary = primaryIsTail ? req.tail : req.head
  const primaryStart = primaryIsTail ? req.tailStart : req.headStart
  const other = primaryIsTail ? req.head : req.tail
  const otherStart = primaryIsTail ? req.headStart : req.tailStart

  // Tempo still comes from the primary window's envelope (bpm / period / candidates fields
  // keep their original meaning); the DP tracker contributes the beat grid itself.
  const primaryEnv = onsetEnvelope(primary, req.sampleRate)
  const tempo = estimateTempo(primaryEnv.env, primaryEnv.hopSec)
  const primaryTrack = trackWindow(primary, req.sampleRate, primaryStart)
  const otherTrack = trackWindow(other, req.sampleRate, otherStart)

  const tailBeats = primaryIsTail ? primaryTrack.beatTimes : otherTrack.beatTimes
  const headBeats = primaryIsTail ? otherTrack.beatTimes : primaryTrack.beatTimes
  const tailDownbeats = primaryIsTail ? primaryTrack.downbeatTimes : otherTrack.downbeatTimes
  const headDownbeats = primaryIsTail ? otherTrack.downbeatTimes : primaryTrack.downbeatTimes
  const stability = Math.min(primaryTrack.stability, otherTrack.stability || primaryTrack.stability)
  const downbeatPhase = primaryIsTail ? primaryTrack.downbeatPhase : otherTrack.downbeatPhase

  // Key from whichever window carries more pitched energy; the other one may be noise / fade.
  const keyHead = estimateKey(req.head, req.sampleRate)
  const keyTail = estimateKey(req.tail, req.sampleRate)
  const keyResult = keyHead.confidence >= keyTail.confidence ? keyHead : keyTail

  return {
    id: 0,
    ok: true,
    bpm: Math.round(tempo.bpm * 10) / 10,
    bpmConfidence: Math.round(tempo.confidence * 100) / 100,
    bpmCandidates: tempo.candidates,
    period: Math.round(tempo.beatPeriod * primaryEnv.hopSec * 10000) / 10000,
    stability: Math.round(stability * 100) / 100,
    downbeat: downbeatPhase,
    tailBeats,
    headBeats,
    tailDownbeats,
    headDownbeats,
    key: keyResult.key,
    keyConfidence: keyResult.confidence,
    engine: primaryTrack.engine
  }
}

if (parentPort) {
  parentPort.on('message', (req: AnalyzeRequest) => {
    try {
      const result = analyzeWindows(req)
      const payload: AnalyzeOk = { ...result, id: req.id }
      parentPort!.postMessage(payload)
    } catch (err) {
      const payload: AnalyzeFail = { id: req.id, ok: false, error: String(err) }
      parentPort!.postMessage(payload)
    }
  })
}
