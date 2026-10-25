/**
 * TransitionPlanner — a pure function from two analyses + settings to a serialisable timeline.
 *
 * It knows nothing about audio devices, the UI or the filesystem, which is what makes it testable
 * and what keeps a bad plan from ever reaching the speakers: if the numbers cannot work out, it
 * returns a lower level instead of a broken mix.
 */
import { camelotDistance } from '../dsp/key'

export type TransitionLevel = 'A' | 'B' | 'C' | 'D' | 'E'

export interface Phrase {
  start: number
  end: number
}

export interface TrackAnalysisLite {
  duration: number
  audioStart: number
  audioEnd: number
  bpm: number
  period: number
  stability: number
  downbeat: number
  tailBeats: number[]
  headBeats: number[]
  lufs: number
  /** Camelot slot (see shared/dsp/key.ts), optional: analysed before v1.3.6 lacks it. */
  key?: number
  keyConfidence?: number
  /** Downbeat times in the tail window (absolute seconds), from the DP tracker. */
  downbeatTimes?: number[]
}

export interface PlannerOptions {
  durationSec: number
  maxRatePct: number
  protectLastPhrase: boolean
  baseFadeSec: number
  /** Both decks have a separated vocal stem cached for the transition window. */
  stemsReady: boolean
  /** Vocal phrases for the current track (from the stem curve or from the lyric timing). */
  currentPhrases: Phrase[]
  /** Vocal phrases for the next track, absolute seconds. */
  nextPhrases: Phrase[]
  /** Prefer gapless when the two tracks are a continuous album pair. */
  sameAlbum?: boolean
  consecutive?: boolean
}

export interface Keyframe {
  at: number
  value: number
}

export interface TransitionPlan {
  level: TransitionLevel
  /**
   * Mix technique, ported from HyPlayer's MixTechnique. `beatmix` = the default bar-aligned
   * bed entry; `filtercut` = the outgoing track is swept out with a high-pass filter (used
   * when the BPM gap is too wide for a time-stretched blend). Absent = beatmix.
   */
  technique?: 'beatmix' | 'filtercut'
  /** Absolute seconds in the current track where the bridge takes over. */
  startTime: number
  /** Absolute seconds in the current track where Deck B takes over. */
  endTime: number
  bridgeDuration: number
  /** Position in the next track that lines up with `nextBedIn` inside the bridge. */
  nextStartOffset: number
  /** Bridge-relative playback rate of the current mix (1 = untouched). */
  rate: Keyframe[]
  currentGain: Keyframe[]
  nextGain: Keyframe[]
  /** Bridge-relative time where the next bed starts. */
  nextBedIn: number
  /** Bridge-relative time where the next vocal is expected. */
  nextVocalIn: number
  vocalOut: { start: number; end: number } | null
  bassSwapAt: number
  /** FilterCut only: outgoing-side high-pass sweep, bridge-relative (Hz at start → Hz at end). */
  highpassSweep?: { fromHz: number; toHz: number } | null
  /** Bridge-relative time where the UI should switch to the next track. */
  uiSwitchAt: number
  /** Beat-phase mismatch at the moment the next bed enters. */
  alignmentErrorMs: number
  entryFadeSec: number
  exitFadeSec: number
  notes: string[]
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
const smoothstep = (x: number): number => {
  const t = clamp(x, 0, 1)
  return t * t * (3 - 2 * t)
}

function lastPhraseBefore(phrases: Phrase[], t: number): Phrase | null {
  let found: Phrase | null = null
  for (const p of phrases) {
    if (p.start < t) found = p
  }
  return found
}

/** First moment at or after `from` where no phrase is sounding, preferring a real gap. */
function nextGap(phrases: Phrase[], from: number, until: number): number | null {
  const sorted = [...phrases].sort((a, b) => a.start - b.start)
  let cursor = from
  for (const p of sorted) {
    if (p.end <= from) continue
    if (p.start > cursor + 0.35) return cursor
    if (p.start > until) break
    cursor = Math.max(cursor, p.end)
  }
  return cursor <= until ? cursor : null
}

function crossfadeCurve(
  from: number,
  to: number,
  steps = 24
): { current: Keyframe[]; next: Keyframe[] } {
  const current: Keyframe[] = []
  const next: Keyframe[] = []
  for (let i = 0; i <= steps; i++) {
    const t = from + ((to - from) * i) / steps
    const x = (t - from) / Math.max(1e-6, to - from)
    current.push({ at: round3(t), value: round4(Math.cos((x * Math.PI) / 2)) })
    next.push({ at: round3(t), value: round4(Math.sin((x * Math.PI) / 2)) })
  }
  return { current, next }
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000
const round4 = (v: number): number => Math.round(v * 10000) / 10000

function gainForLoudness(a: TrackAnalysisLite, b: TrackAnalysisLite): number {
  const diff = a.lufs - b.lufs
  return clamp(Math.pow(10, diff / 20), 0.55, 1.9)
}

/** Bridge-relative current-track source position after time-varying rate, by trapezoid integration. */
export function integratedPosition(rate: Keyframe[], t: number, dt = 0.005): number {
  if (rate.length === 0) return t
  let pos = 0
  let cursor = 0
  let currentRate = rate[0]!.value
  while (cursor < t) {
    const next = Math.min(t, cursor + dt)
    // find rate active at next boundary
    let r = currentRate
    for (const k of rate) {
      if (k.at <= next) r = k.value
      else break
    }
    pos += ((currentRate + r) / 2) * (next - cursor)
    currentRate = r
    cursor = next
  }
  return pos
}

/**
 * Exit point on a downbeat, preferring a 4-bar phrase boundary (HyPlayer ChooseExit).
 * `downbeatTimes` (DP tracker) wins when present; otherwise downbeats are derived from
 * tailBeats + the downbeat phase. The phrase anchor is the *last* downbeat (the outro):
 * walking candidates backwards from the end, the first one whose global index sits on the
 * same 4-bar phase as the outro wins — that is what makes the handover feel "on the one".
 * Returns null when nothing lands before `latest`.
 */
function pickPhraseExit(
  track: TrackAnalysisLite,
  latest: number,
  minimum: number
): { time: number; phraseAligned: boolean } | null {
  const barSec = track.period * 4
  const downbeats =
    track.downbeatTimes && track.downbeatTimes.length >= 4
      ? track.downbeatTimes
      : track.tailBeats.filter((_, i) => (i + track.downbeat) % 4 === 0)
  if (downbeats.length === 0) return null
  const anchorIndex = downbeats.length - 1
  const candidates: number[] = []
  for (const d of downbeats) {
    if (d > latest + 0.05) continue
    if (d < minimum) continue
    candidates.push(d)
  }
  if (candidates.length === 0) return null
  for (let ci = candidates.length - 1; ci >= 0; ci--) {
    const d = candidates[ci]!
    const idx = downbeats.indexOf(d)
    if (((idx - anchorIndex) % 4 + 4) % 4 === 0) return { time: d, phraseAligned: true }
  }
  // Fall back to the last candidate that still leaves a full bar before the end.
  const withRoom = candidates.filter((d) => d + barSec <= latest)
  if (withRoom.length > 0) return { time: withRoom[withRoom.length - 1]!, phraseAligned: false }
  return { time: candidates[candidates.length - 1]!, phraseAligned: false }
}

export function planTransition(
  current: TrackAnalysisLite,
  next: TrackAnalysisLite,
  options: PlannerOptions
): TransitionPlan {
  const notes: string[] = []
  let target = clamp(options.durationSec, 8, 45)
  const e1 = current.audioEnd > 0 ? current.audioEnd : current.duration
  const barSec = current.period * 4

  // ---- Level E: a continuous album pair stays gapless, without any processing at all.
  if (options.sameAlbum && options.consecutive && current.duration - e1 < 0.35 && next.audioStart < 0.35) {
    return {
      level: 'E',
      technique: 'beatmix',
      startTime: e1,
      endTime: e1,
      bridgeDuration: 0,
      nextStartOffset: 0,
      rate: [{ at: 0, value: 1 }],
      currentGain: [{ at: 0, value: 1 }],
      nextGain: [{ at: 0, value: 1 }],
      nextBedIn: 0,
      nextVocalIn: 0,
      vocalOut: null,
      bassSwapAt: 0,
      highpassSweep: null,
      uiSwitchAt: 0,
      alignmentErrorMs: 0,
      entryFadeSec: 0.02,
      exitFadeSec: 0.02,
      notes: ['同专辑连续曲目，保持无缝播放']
    }
  }

  // Key clash (HyPlayer): two tracks a Camelot distance > 2 apart fight in the overlap,
  // so cap the blend at 8 bars and get out.
  const keyDistance = camelotDistance(current.key ?? -1, next.key ?? -1)
  const keyClash =
    keyDistance > 2 && (current.keyConfidence ?? 0) > 0.03 && (next.keyConfidence ?? 0) > 0.03
  if (keyClash) {
    const cap = Math.max(8 * barSec, 10)
    if (target > cap) {
      target = cap
      notes.push(`调性相冲（Camelot 距离 ${keyDistance}），重叠限 8 小节`)
    }
  }

  // 0.55 太苛刻：真实歌曲里拍点吸附会有几十毫秒抖动，稳定度算出来常常只有 0.4~0.5，
  // 结果每一首都被判成「拍点不可靠」直接掉到 D 级。改成 0.4，并要求拍点周期在合理区间。
  const beatsUsable =
    current.stability >= 0.4 && next.stability >= 0.4 && current.period > 0.2 && next.period > 0.2
  // Half-/double-time alignment (HyPlayer BestRate): 100 → 200 BPM still mixes 2:1.
  // Our stretch acts on the outgoing track, so the rate candidates are periodA / (periodB·k).
  let rateRatio = current.period / next.period
  let multiplier = 1
  for (const k of [1, 2, 0.5]) {
    const r = current.period / (next.period * k)
    if (Math.abs(r - 1) < Math.abs(rateRatio - 1)) {
      rateRatio = r
      multiplier = k
    }
  }
  if (multiplier !== 1) notes.push(`按 ${multiplier === 2 ? '对半' : '倍频'}拍对齐（2:1）`)
  const rateExcess = Math.abs(rateRatio - 1)
  const maxRate = clamp(options.maxRatePct, 1, 12) / 100
  // Both periods come from a tempo estimate with a few tenths of a percent of error, so the cap
  // gets a 0.5 % tolerance; without it a nominal 100 → 108 BPM pair would always degrade.
  const RATE_TOLERANCE = 0.005
  const rateAllowed = rateExcess <= maxRate + RATE_TOLERANCE && beatsUsable

  // ---- Level D: equal-power crossfade over the *effective* end, never the file length.
  if (!beatsUsable) {
    const fade = clamp(options.baseFadeSec, 2, 12)
    const startTime = Math.max(0, e1 - fade)
    const curve = crossfadeCurve(0, fade)
    notes.push('拍点不可靠，降级为基础交叉淡化')
    return {
      level: 'D',
      technique: 'beatmix',
      startTime,
      endTime: e1,
      bridgeDuration: fade,
      nextStartOffset: 0,
      rate: [{ at: 0, value: 1 }],
      currentGain: curve.current,
      nextGain: curve.next.map((k) => ({ at: k.at, value: round4(k.value * gainForLoudness(current, next)) })),
      nextBedIn: 0,
      nextVocalIn: 0,
      vocalOut: null,
      bassSwapAt: fade * 0.45,
      highpassSweep: null,
      uiSwitchAt: startTime + fade * 0.5,
      alignmentErrorMs: 0,
      entryFadeSec: 0.35,
      exitFadeSec: 0.35,
      notes
    }
  }

  // ---- FilterCut (HyPlayer MixTechnique.FilterCut): the BPM gap is too wide to stretch,
  // so blend over a few bars while sweeping the outgoing track out with a high-pass filter.
  if (!rateAllowed) {
    const bars = Math.max(4, Math.min(8, Math.floor(target / barSec)))
    const overlap = bars * barSec
    const latest = e1 - Math.max(0, overlap * 0.25)
    const exit = pickPhraseExit(current, latest, Math.max(0, e1 - 45))
    const startTime = exit ? exit.time : Math.max(0, e1 - overlap)
    const bridgeDuration = Math.max(2, e1 - startTime)
    const currentGain: Keyframe[] = [
      { at: 0, value: 1 },
      { at: round3(bridgeDuration * 0.7), value: 1 },
      { at: round3(bridgeDuration), value: 0 }
    ]
    const nextGain: Keyframe[] = [
      { at: 0, value: 0 },
      { at: round3(bridgeDuration * 0.5), value: 0 },
      { at: round3(bridgeDuration), value: round4(gainForLoudness(current, next)) }
    ]
    notes.push(`BPM 差 ${Math.round(rateExcess * 1000) / 10}% 超限，高通扫频切出（${bars} 小节）`)
    return {
      level: 'C',
      technique: 'filtercut',
      startTime: round3(startTime),
      endTime: round3(e1),
      bridgeDuration: round3(bridgeDuration),
      nextStartOffset: 0,
      rate: [{ at: 0, value: 1 }],
      currentGain,
      nextGain,
      nextBedIn: 0,
      nextVocalIn: 0,
      vocalOut: null,
      bassSwapAt: 0,
      highpassSweep: { fromHz: 300, toHz: 18000 },
      uiSwitchAt: round3(startTime + bridgeDuration * 0.5),
      alignmentErrorMs: 0,
      entryFadeSec: 0.35,
      exitFadeSec: 0.35,
      notes
    }
  }

  // ---- Where can the bridge start?  Always on a downbeat (4-bar phrase if possible),
  // always before the effective end. Walking back up to one full phrase (4 bars) to hit
  // the right phase is fine — that is exactly what makes the handover feel "on the one".
  let startTime = e1 - target
  const exit = pickPhraseExit(current, startTime + barSec, Math.max(0, e1 - 45))
  if (exit && startTime - exit.time <= 4 * barSec && e1 - exit.time <= 45) startTime = exit.time

  // ---- Protect the last vocal phrase: the bridge may not begin before it is over.
  if (options.protectLastPhrase && options.currentPhrases.length > 0) {
    const last = lastPhraseBefore(options.currentPhrases, e1)
    if (last && last.end > startTime) {
      const earliest = e1 - 8
      startTime = Math.min(Math.max(startTime, last.end + 0.4), Math.max(earliest, last.end + 0.4))
      notes.push('保护末句人声，过渡起点后移')
      if (last.end > e1 - 3) {
        const fade = clamp(options.baseFadeSec, 2, 12)
        const s = Math.max(0, e1 - Math.min(fade, 6))
        const curve = crossfadeCurve(0, e1 - s)
        notes.push('末句过于贴近结尾，降级为基础交叉淡化')
        return {
          level: 'D',
          startTime: s,
          endTime: e1,
          bridgeDuration: e1 - s,
          nextStartOffset: 0,
          rate: [{ at: 0, value: 1 }],
          currentGain: curve.current,
          nextGain: curve.next.map((k) => ({
            at: k.at,
            value: round4(k.value * gainForLoudness(current, next))
          })),
          nextBedIn: 0,
          nextVocalIn: 0,
          vocalOut: null,
          bassSwapAt: (e1 - s) * 0.45,
          highpassSweep: null,
          technique: 'beatmix',
          uiSwitchAt: s + (e1 - s) * 0.5,
          alignmentErrorMs: 0,
          entryFadeSec: 0.35,
          exitFadeSec: 0.35,
          notes
        }
      }
    }
  }

  let bridgeDuration = e1 - startTime
  if (bridgeDuration < 8) {
    // Not enough room: fall back rather than squeeze a 3 s "transition" out of the规划器.
    const fade = clamp(Math.min(options.baseFadeSec, bridgeDuration), 1.2, 12)
    const s = Math.max(0, e1 - fade)
    const curve = crossfadeCurve(0, e1 - s)
    notes.push('过渡窗口不足 8 秒，降级为基础交叉淡化')
    return {
      level: 'D',
      startTime: s,
      endTime: e1,
      bridgeDuration: e1 - s,
      nextStartOffset: 0,
      rate: [{ at: 0, value: 1 }],
      currentGain: curve.current,
      nextGain: curve.next.map((k) => ({ at: k.at, value: round4(k.value * gainForLoudness(current, next)) })),
      nextBedIn: 0,
      nextVocalIn: 0,
      vocalOut: null,
      bassSwapAt: (e1 - s) * 0.45,
      highpassSweep: null,
      technique: 'beatmix',
      uiSwitchAt: s + (e1 - s) * 0.5,
      alignmentErrorMs: 0,
      entryFadeSec: 0.35,
      exitFadeSec: 0.35,
      notes
    }
  }
  bridgeDuration = clamp(bridgeDuration, 8, 45)

  // BPM 太宽的配对已经在上面走了 FilterCut，所以这里 rateAllowed 恒为真：
  // A 级 = 有分轨（人声先退 + 变速对齐），C 级 = 无分轨的同款规划（人声改用歌词时间轴）。
  // 旧版 B 级（有分轨但不许变速）的职责由 FilterCut 接管。
  const stems = options.stemsReady
  const level: TransitionLevel = stems ? 'A' : 'C'
  if (rateAllowed && rateExcess > maxRate) notes.push('按估算误差容差放行变速')
  if (!stems) notes.push('分轨未就绪，整曲节拍对齐混音')

  // ---- Vocal exit inside the first 40% of the window.
  let vocalOut: { start: number; end: number } | null = null
  if (stems) {
    const limit = bridgeDuration * 0.4
    const relative = options.currentPhrases.map((p) => ({
      start: p.start - startTime,
      end: p.end - startTime
    }))
    const soundingAtStart = relative.some((p) => p.start <= 0.02 && p.end > 0.05)
    if (!soundingAtStart) {
      notes.push('人声在过渡起点前已结束，直接进入伴奏')
    } else {
      const gap = nextGap(relative, 0.02, limit + 0.6)
      const outStart = gap !== null ? Math.min(gap, limit) : Math.min(bridgeDuration * 0.12, limit)
      const fade = clamp(bridgeDuration * 0.06, 1, 4)
      vocalOut = { start: round3(outStart), end: round3(Math.min(bridgeDuration * 0.45, outStart + fade)) }
    }
  }

  // ---- Rate ramp: silent start, S curve, finished before the next bed arrives.
  const rampStart = vocalOut ? vocalOut.end : bridgeDuration * 0.15
  const maxLevel = level === 'A' ? rateRatio : 1
  const nextBedIn = clamp(
    Math.max(rampStart + 2, bridgeDuration * 0.42),
    1,
    bridgeDuration - Math.max(3, bridgeDuration * 0.2)
  )
  const rampEnd = Math.max(rampStart + 1, nextBedIn - 0.1)
  const rate: Keyframe[] = []
  const steps = Math.max(8, Math.round((rampEnd - rampStart) * 8))
  for (let i = 0; i <= steps; i++) {
    const t = rampStart + ((rampEnd - rampStart) * i) / steps
    const x = (t - rampStart) / Math.max(1e-6, rampEnd - rampStart)
    rate.push({ at: round3(t), value: round4(1 + (maxLevel - 1) * smoothstep(x)) })
  }
  if (rate.length === 0 || rate[0]!.at > 0.001) rate.unshift({ at: 0, value: 1 })
  rate.push({ at: round3(bridgeDuration), value: round4(maxLevel) })

  // ---- Beat-phase alignment at the next bed entry.
  const currentPhaseTime = integratedPosition(rate, nextBedIn)
  const currentPhase = (startTime + currentPhaseTime) / current.period
  const anchor2 = next.headBeats.length > 0 ? next.headBeats[0]! : next.audioStart
  const wantPhase = currentPhase - Math.floor(currentPhase)
  // Half/double-time pairs: one outgoing beat spans `multiplier` beats of the next track,
  // so the phase maps onto the next grid scaled by that factor.
  const phaseBase = anchor2 + wantPhase * multiplier * next.period
  const bar = next.period * 4
  const maxSkip = 8 * bar
  // Choose the whole-bar multiple that puts the entry inside the allowed intro window. Because we
  // only ever add whole bars, the beat phase stays congruent with the stretched current grid.
  let bars = Math.ceil((next.audioStart - phaseBase) / bar)
  let nextStartOffset = phaseBase + bars * bar
  while (nextStartOffset - next.audioStart > maxSkip) {
    bars -= 1
    nextStartOffset = phaseBase + bars * bar
  }
  if (nextStartOffset < next.audioStart - 0.001) {
    bars += 1
    nextStartOffset = phaseBase + bars * bar
  }
  nextStartOffset = Math.round(nextStartOffset * 1000) / 1000
  // Phase is only defined modulo one beat: an integer number of periods away is still aligned.
  const delta = nextStartOffset - phaseBase
  const wrapped = delta - Math.round(delta / next.period) * next.period
  const alignmentErrorMs = Math.abs(wrapped) * 1000

  // ---- Next vocal entry: after the current vocal is gone, on a phrase boundary.
  let nextVocalIn = nextBedIn + Math.max(2, bridgeDuration * 0.18)
  if (options.nextPhrases.length > 0) {
    const offsetInNext = nextStartOffset
    const firstVocal = options.nextPhrases.find((p) => p.start >= offsetInNext - 0.05)
    if (firstVocal) {
      const rel = nextBedIn + (firstVocal.start - nextStartOffset)
      if (rel < bridgeDuration - 0.5) nextVocalIn = Math.max(vocalOut ? vocalOut.end + 0.6 : 0, rel)
    }
  }
  nextVocalIn = clamp(nextVocalIn, nextBedIn, bridgeDuration)

  // ---- Gains: bed crossfade over 1–2 bars, then a low-frequency swap.
  const bedFade = clamp(Math.max(next.period * 4 * 2, 3), 3, bridgeDuration - nextBedIn)
  const bedIn = nextBedIn
  const bedFull = Math.min(bridgeDuration, bedIn + bedFade)
  const loudnessGain = gainForLoudness(current, next)
  const curve = crossfadeCurve(bedIn, bedFull, 48)
  const currentGain: Keyframe[] = [
    { at: 0, value: 1 },
    ...curve.current.map((k) => ({ at: k.at, value: round4(Math.min(1, k.value)) })),
    { at: round3(bridgeDuration), value: 0 }
  ]
  const nextGain: Keyframe[] = [
    { at: 0, value: 0 },
    ...curve.next.map((k) => ({ at: k.at, value: round4(k.value * loudnessGain) })),
    { at: round3(bridgeDuration), value: round4(loudnessGain) }
  ]

  const bassSwapAt = round3(clamp(bedIn + bedFade * 0.45, 0, bridgeDuration))
  const uiSwitchAt = round3(Math.max(vocalOut ? vocalOut.end : 0, bedIn))

  return {
    level,
    technique: 'beatmix',
    startTime: round3(startTime),
    endTime: round3(e1),
    bridgeDuration: round3(bridgeDuration),
    nextStartOffset,
    rate,
    currentGain,
    nextGain,
    nextBedIn: round3(nextBedIn),
    nextVocalIn: round3(nextVocalIn),
    vocalOut,
    bassSwapAt,
    highpassSweep: null,
    uiSwitchAt,
    alignmentErrorMs: Math.round(alignmentErrorMs * 100) / 100,
    entryFadeSec: 0.35,
    exitFadeSec: 0.35,
    notes
  }
}

/** Plan for a short manual skip: always a 0.5–1 s equal-power fade, never AutoMix. */
export function planManualFade(seconds = 0.8): { current: Keyframe[]; next: Keyframe[]; duration: number } {
  const d = clamp(seconds, 0.5, 1)
  const curve = crossfadeCurve(0, d, 12)
  return { current: curve.current, next: curve.next, duration: d }
}

export function gainAt(curve: Keyframe[], t: number): number {
  if (curve.length === 0) return 0
  if (t <= curve[0]!.at) return curve[0]!.value
  for (let i = 1; i < curve.length; i++) {
    const prev = curve[i - 1]!
    const cur = curve[i]!
    if (t <= cur.at) {
      const span = cur.at - prev.at
      if (span <= 0) return cur.value
      const x = (t - prev.at) / span
      return prev.value + (cur.value - prev.value) * x
    }
  }
  return curve[curve.length - 1]!.value
}

export function rateAt(curve: Keyframe[], t: number): number {
  return gainAt(curve, t)
}
