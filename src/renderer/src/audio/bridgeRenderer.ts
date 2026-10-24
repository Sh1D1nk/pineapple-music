import SignalsmithStretch from 'signalsmith-stretch'
import type { SongMeta } from '@shared/types'
import { integratedPosition, type TransitionPlan } from '@shared/transition/planner'
import { bridge } from '../bridge'

const SR = 44100

interface RenderResult {
  buffer: AudioBuffer
  stretched: boolean
}

function applyGains(param: AudioParam, curve: { at: number; value: number }[]): void {
  if (curve.length === 0) return
  param.setValueAtTime(curve[0]!.value, 0)
  for (let i = 1; i < curve.length; i++) {
    const point = curve[i]!
    param.linearRampToValueAtTime(point.value, Math.max(0, point.at))
  }
}

function toBuffer(ctx: BaseAudioContext, left: Float32Array, right: Float32Array): AudioBuffer {
  const frames = Math.min(left.length, right.length)
  const buffer = ctx.createBuffer(2, Math.max(1, frames), SR)
  buffer.copyToChannel(left.subarray(0, frames) as Float32Array<ArrayBuffer>, 0)
  buffer.copyToChannel(right.subarray(0, frames) as Float32Array<ArrayBuffer>, 1)
  return buffer
}

/**
 * Offline render of the bridge clip. Everything is done in an OfflineAudioContext with the
 * Signalsmith Stretch AudioWorklet, so it runs far faster than realtime and never competes with
 * playback for the audio thread.
 */
export async function renderBridge(
  plan: TransitionPlan,
  current: SongMeta,
  next: SongMeta,
  onProgress?: (ratio: number) => void
): Promise<RenderResult | null> {
  const length = Math.ceil(plan.bridgeDuration * SR)
  if (length <= 0) return null

  const sourceLenCurrent = integratedPosition(plan.rate, plan.bridgeDuration) + 0.5
  const sourceLenNext = Math.max(1, plan.bridgeDuration - plan.nextBedIn + 0.4)

  onProgress?.(0.1)
  const [currentSeg, nextSeg] = await Promise.all([
    bridge.segment(current.id, plan.startTime, Math.min(sourceLenCurrent, current.durationSec - plan.startTime)),
    bridge.segment(next.id, plan.nextStartOffset, Math.min(sourceLenNext, next.durationSec - plan.nextStartOffset))
  ])
  onProgress?.(0.45)

  const ctx = new OfflineAudioContext(2, length, SR)
  const master = ctx.createGain()
  master.gain.value = 1
  master.connect(ctx.destination)

  // ---- next deck: original speed, enters at nextBedIn, bass returns at the swap point
  const nextBuffer = toBuffer(ctx, nextSeg.left, nextSeg.right)
  const nextSrc = ctx.createBufferSource()
  nextSrc.buffer = nextBuffer
  const nextGain = ctx.createGain()
  const nextLow = ctx.createBiquadFilter()
  nextLow.type = 'lowshelf'
  nextLow.frequency.value = 160
  nextLow.gain.setValueAtTime(-14, 0)
  nextLow.gain.linearRampToValueAtTime(0, plan.bassSwapAt)
  applyGains(nextGain.gain, plan.nextGain.map((k) => ({ at: k.at - plan.nextBedIn, value: k.value })))
  nextSrc.connect(nextGain)
  nextGain.connect(nextLow)
  nextLow.connect(master)
  nextSrc.start(plan.nextBedIn)

  // ---- current deck: time-varying stretch, bass removed at the swap point
  const currentBuffer = toBuffer(ctx, currentSeg.left, currentSeg.right)
  const currentGain = ctx.createGain()
  const currentHigh = ctx.createBiquadFilter()
  currentHigh.type = 'highshelf'
  currentHigh.frequency.value = 160
  currentHigh.gain.setValueAtTime(0, 0)
  currentHigh.gain.linearRampToValueAtTime(-14, plan.bassSwapAt)
  applyGains(currentGain.gain, plan.currentGain.map((k) => ({ at: k.at, value: k.value })))
  currentHigh.connect(currentGain)
  currentGain.connect(master)

  let stretched = false
  try {
    const stretch = (await SignalsmithStretch(ctx, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2]
    })) as AudioNode & {
      addBuffers: (buffers: Float32Array[]) => Promise<unknown>
      schedule: (change: Record<string, unknown>) => void
      start: (when?: number) => void
    }
    await stretch.addBuffers([currentSeg.left, currentSeg.right])
    stretch.schedule({ output: 0, active: true, input: 0, rate: 1 })
    let lastAt = 0
    for (const point of plan.rate) {
      if (point.at <= lastAt + 0.001) continue
      stretch.schedule({ output: point.at, rate: point.value })
      lastAt = point.at
    }
    stretch.connect(currentHigh)
    stretched = true
  } catch (err) {
    console.warn('[bridge] stretch unavailable, rendering at original speed:', String(err))
    const plain = ctx.createBufferSource()
    plain.buffer = currentBuffer
    plain.connect(currentHigh)
    plain.start(0)
  }

  onProgress?.(0.6)
  const rendered = await ctx.startRendering()
  onProgress?.(1)
  return { buffer: rendered, stretched }
}

/** Cheap equal-power fallback used when the bridge cannot be rendered in time. */
export function planFallbackFade(duration = 6): { at: number; value: number }[] {
  const out: { at: number; value: number }[] = []
  for (let i = 0; i <= 24; i++) {
    const t = (duration * i) / 24
    out.push({ at: t, value: Math.cos(((i / 24) * Math.PI) / 2) })
  }
  return out
}
