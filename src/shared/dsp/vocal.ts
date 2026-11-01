import { fftInPlace } from '../stem/stft'

/**
 * 轻量人声活动检测（VAD）—— AutoMix 的「快速通道」。
 *
 * 为什么需要它：分轨（UVR/MDX）一首歌要几分钟，而过渡规划只需要知道「人声在哪些区间、
 * 什么时候退出」。用分轨去拿这个信息是拿开山刀削铅笔。这里用纯 DSP 在已有的
 * 尾窗 PCM 上算一遍，毫秒级出结果。
 *
 * 判据（人声的两个可测特征）：
 *   1. 中频占比：人声基频与共振峰集中在 300–3400 Hz，这一段的能量占比明显高于伴奏
 *      （bass/kick 在低频、hi-hat 在高频，占比都低）
 *   2. 能量高于自适应噪声底：用整段能量的低分位数当噪声底，避免安静段被误判
 *
 * 后处理：中值平滑 → 最短乐句 → 合并短间隙，输出与分轨 phrases 同构的区间。
 */

export interface VocalPhrase {
  start: number
  end: number
}

export interface VocalOptions {
  /** 帧长（采样点），1024 @44.1k ≈ 23ms */
  frameSize?: number
  /** 帧移（采样点），512 ≈ 11.6ms */
  hopSize?: number
  /** 中频带下限 / 上限（Hz） */
  bandLow?: number
  bandHigh?: number
  /** 中频占比的绝对下限（0..1） */
  midRatio?: number
  /** 相对自身基线的跃升倍数：人声进来时中频占比会突然抬升 */
  midBoost?: number
  /** 相对静音噪声底的能量倍数（只用来排除静音，不参与「唱没唱」的判断） */
  energyFactor?: number
  /** 最短乐句（秒） */
  minPhraseSec?: number
  /** 合并间隙（秒） */
  minGapSec?: number
}

const DEFAULTS: Required<VocalOptions> = {
  frameSize: 1024,
  hopSize: 512,
  bandLow: 300,
  bandHigh: 3400,
  midRatio: 0.1,
  midBoost: 1.35,
  energyFactor: 1.5,
  minPhraseSec: 0.5,
  minGapSec: 0.35
}

function percentile(sorted: Float32Array, p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))
  return sorted[idx]!
}

/**
 * 从 `offsetSec` 开始的 PCM 里找出「有人在唱」的区间（绝对秒）。
 * 输入应是已经解码的单声道 float32（-1..1）。
 */
export function detectVocalPhrases(
  pcm: Float32Array,
  sampleRate: number,
  offsetSec = 0,
  options: VocalOptions = {}
): VocalPhrase[] {
  const o = { ...DEFAULTS, ...options }
  const frame = Math.max(256, o.frameSize)
  const hop = Math.max(128, o.hopSize)
  if (pcm.length < frame) return []
  const frames = Math.floor((pcm.length - frame) / hop) + 1
  const win = new Float32Array(frame)
  for (let i = 0; i < frame; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / frame)
  const re = new Float32Array(frame)
  const im = new Float32Array(frame)
  const binHz = sampleRate / frame
  const lo = Math.max(1, Math.floor(o.bandLow / binHz))
  const hi = Math.min(frame / 2 - 1, Math.ceil(o.bandHigh / binHz))

  // 逐帧特征：总能量 + 中频能量
  const energy = new Float32Array(frames)
  const midRatio = new Float32Array(frames)
  for (let f = 0; f < frames; f++) {
    const base = f * hop
    let total = 0
    for (let i = 0; i < frame; i++) {
      const v = pcm[base + i]! * win[i]!
      re[i] = v
      im[i] = 0
      total += v * v
    }
    energy[f] = total
    if (total <= 1e-12) {
      midRatio[f] = 0
      continue
    }
    fftInPlace(re, im)
    let mid = 0
    for (let b = lo; b <= hi; b++) mid += re[b]! * re[b]! + im[b]! * im[b]!
    // Parseval：Σ|X[k]|² = N·Σx²，所以比值要除回帧长才是真正的能量占比
    midRatio[f] = mid / (total * frame)
  }

  // 能量只做「排除静音」的底线：伴奏往往比人声更响，拿能量当主判据会把歌声挡在门外。
  // 主判据是中频占比，且用「相对自身基线」而不是纯绝对值 ——
  // 真实混音里人声常被压到 0.16 左右，而同段伴奏基线可能只有 0.05，
  // 只看绝对值会漏检；看跃升则不受混音厚度影响。
  const sorted = Float32Array.from(energy).sort()
  const floor = Math.max(1e-7, percentile(sorted, 0.05))
  const thr = floor * o.energyFactor
  const midSorted = Float32Array.from(midRatio).sort()
  const midBase = percentile(midSorted, 0.5)
  const midThr = Math.max(o.midRatio, midBase * o.midBoost)

  // 单帧判定 + 3 帧中值平滑（去掉鼓点的瞬时误触发）
  const raw = new Uint8Array(frames)
  for (let f = 0; f < frames; f++) raw[f] = energy[f]! > thr && midRatio[f]! >= midThr ? 1 : 0
  const smooth = new Uint8Array(frames)
  for (let f = 0; f < frames; f++) {
    const a = Math.max(0, f - 1)
    const b = Math.min(frames - 1, f + 1)
    const sum = raw[a]! + raw[f]! + raw[b]!
    smooth[f] = sum >= 2 ? 1 : 0
  }

  // 合并成区间（帧 → 秒）
  const hopSec = hop / sampleRate
  const frameSec = frame / sampleRate
  const phrases: VocalPhrase[] = []
  let start = -1
  for (let f = 0; f < frames; f++) {
    if (smooth[f] === 1 && start < 0) start = f
    if (smooth[f] === 0 && start >= 0) {
      phrases.push({ start: offsetSec + start * hopSec, end: offsetSec + f * hopSec + frameSec })
      start = -1
    }
  }
  if (start >= 0) {
    phrases.push({ start: offsetSec + start * hopSec, end: offsetSec + frames * hopSec + frameSec })
  }

  // 合并短间隙 → 丢弃过短乐句
  const merged: VocalPhrase[] = []
  for (const p of phrases) {
    const last = merged[merged.length - 1]
    if (last && p.start - last.end < o.minGapSec) last.end = p.end
    else merged.push({ ...p })
  }
  return merged.filter((p) => p.end - p.start >= o.minPhraseSec)
}
