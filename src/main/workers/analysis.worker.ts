import { parentPort } from 'node:worker_threads'
import { estimateTempo, onsetEnvelope, trackBeats } from '@shared/dsp/tempo'

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

export function analyzeWindows(req: Omit<AnalyzeRequest, 'id'>): AnalyzeOk {
  const tailEnergy = rms(req.tail)
  const headEnergy = rms(req.head)
  // Prefer the louder window for the tempo estimate; a fade-out outro has no transients.
  const primaryIsTail = tailEnergy >= headEnergy * 0.7
  const primary = primaryIsTail ? req.tail : req.head
  const primaryStart = primaryIsTail ? req.tailStart : req.headStart

  const env = onsetEnvelope(primary, req.sampleRate)
  const tempo = estimateTempo(env.env, env.hopSec)
  const track = trackBeats(env.env, env.hopSec, tempo, primaryStart, 600)

  const other = primaryIsTail ? req.head : req.tail
  const otherStart = primaryIsTail ? req.headStart : req.tailStart
  const otherEnv = onsetEnvelope(other, req.sampleRate)
  const otherTrack = trackBeats(otherEnv.env, otherEnv.hopSec, tempo, otherStart, 600)

  const tailBeats = primaryIsTail ? track.beatTimes : otherTrack.beatTimes
  const headBeats = primaryIsTail ? otherTrack.beatTimes : track.beatTimes
  const stability = Math.min(track.stability, otherTrack.stability || track.stability)

  return {
    id: 0,
    ok: true,
    bpm: Math.round(tempo.bpm * 10) / 10,
    bpmConfidence: Math.round(tempo.confidence * 100) / 100,
    bpmCandidates: tempo.candidates,
    period: Math.round(tempo.beatPeriod * env.hopSec * 10000) / 10000,
    stability: Math.round(stability * 100) / 100,
    downbeat: tempo.downbeat,
    tailBeats,
    headBeats,
    engine: 'spectral-flux-autocorrelation'
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
