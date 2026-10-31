/**
 * STFT / iSTFT —— 分轨推理的数学底座。
 *
 * 选择 n_fft = 4096、hop = 1024：4096/2+1 = 2049，正好是 UVR / MDX-Net 系 ONNX 模型
 * 期望的频率维（dim_f = 2049），hop 1024 给出 4 倍重叠，Hann 窗满足 COLA，重建无损。
 *
 * 复数谱按 [frame][bin] 连续存放；喂给 ONNX 前再转置成 [1, C, 2049, T]，这是模型要的布局。
 */

export interface StftOptions {
  nFft: number
  hop: number
  /**
   * 是否居中补零（librosa 的 center=True）。
   * - true ：频点数 = nFft/2 + 1（第 0 个 bin 是 DC，最后一个是 Nyquist）
   * - false：频点数 = nFft/2，帧从 startSample + f*hop 起算（UVR / MDX-Net 的做法）
   *
   * MDX-Net 系模型是按 center=False 训练的（dim_f = n_fft/2，例如 n_fft=4096 → 2048），
   * 而本应用原先只用居中频谱（2049），于是所有真实 UVR 模型都会被判为「签名不兼容」。
   */
  center?: boolean
}

export const DEFAULT_STFT: StftOptions = { nFft: 4096, hop: 1024, center: true }

/** 给定频点数，返回能喂给这个模型的频谱配置；返回 null 表示本应用的 FFT 跑不了它。 */
export function stftProfileFor(bins: number): StftOptions | null {
  switch (bins) {
    case 2049:
      return { nFft: 4096, hop: 1024, center: true }
    case 2048:
      return { nFft: 4096, hop: 1024, center: false }
    case 4097:
      return { nFft: 8192, hop: 2048, center: true }
    case 4096:
      return { nFft: 8192, hop: 2048, center: false }
    // 6144 点 STFT：MDX-Net 的 dim_f=3072 一族（如 VOC-FT）。6144 = 2^11 × 3，
    // 不是 2 的幂 —— 由下面的 Bluestein 任意长度 FFT 支撑。
    case 3073:
      return { nFft: 6144, hop: 1024, center: true }
    case 3072:
      return { nFft: 6144, hop: 1024, center: false }
    default:
      return null
  }
}

/** 周期 Hann 窗（w[0] = 0），COLA 条件下 sum(w²) 在三帧内恒为 1.5。 */
export function hannWindow(n: number): Float32Array {
  const w = new Float32Array(n)
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n)
  return w
}

/** 原地 radix-2 FFT（长度必须是 2 的幂）。 */
export function fftInPlace(re: Float32Array, im: Float32Array): void {
  const n = re.length
  if (n <= 1) return
  if ((n & (n - 1)) !== 0) throw new Error(`FFT 长度必须是 2 的幂，收到 ${n}`)

  // 位反转置换
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]!
      re[i] = re[j]!
      re[j] = tr
      const ti = im[i]!
      im[i] = im[j]!
      im[j] = ti
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wRe = Math.cos(ang)
    const wIm = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let curRe = 1
      let curIm = 0
      for (let k = 0; k < len / 2; k++) {
        const a = i + k
        const b = a + len / 2
        const xRe = re[b]! * curRe - im[b]! * curIm
        const xIm = re[b]! * curIm + im[b]! * curRe
        re[b] = re[a]! - xRe
        im[b] = im[a]! - xIm
        re[a] = re[a]! + xRe
        im[a] = im[a]! + xIm
        const nextRe = curRe * wRe - curIm * wIm
        curIm = curRe * wIm + curIm * wRe
        curRe = nextRe
      }
    }
  }
}

/**
 * Bluestein（chirp-z）算法：把任意长度的 DFT 化为一次 2 的幂卷积。
 * X[k] = exp(-iθk)·Σ x[n]·exp(-iθn²)·exp(+iθ(k-n)²)，θ = π/n
 * 卷积用长度 ≥ 2n-1 的 2 的幂 FFT 完成（复用上面的 radix-2）。
 * chirp 的角度按 k² mod 2n 折算 —— exp(iπ(k+2n)²/n) = exp(iπk²/n)，周期性保证无损。
 */
function bluesteinFft(re: Float32Array, im: Float32Array): void {
  const n = re.length
  const m = 1 << Math.ceil(Math.log2(2 * n - 1))
  const period = 2 * n
  const cosW = new Float32Array(n)
  const sinW = new Float32Array(n)
  for (let k = 0; k < n; k++) {
    const theta = (Math.PI * ((k * k) % period)) / n
    cosW[k] = Math.cos(theta)
    sinW[k] = Math.sin(theta)
  }
  const aRe = new Float32Array(m)
  const aIm = new Float32Array(m)
  const bRe = new Float32Array(m)
  const bIm = new Float32Array(m)
  for (let k = 0; k < n; k++) {
    // a[k] = x[k]·exp(+iθk)
    aRe[k] = re[k]! * cosW[k]! + im[k]! * sinW[k]!
    aIm[k] = im[k]! * cosW[k]! - re[k]! * sinW[k]!
    // 卷积核 b[j] = exp(+iθj)，j ∈ [-(N-1), N-1]，存放在数组索引 j+(N-1)：
    // 正索引 j=k 放在 k+(N-1)，负索引 j=-k 放在 (N-1)-k
    const pos = k + n - 1
    bRe[pos] = cosW[k]!
    bIm[pos] = sinW[k]!
    if (k > 0) {
      bRe[n - 1 - k] = cosW[k]!
      bIm[n - 1 - k] = sinW[k]!
    }
  }
  fftInPlace(aRe, aIm)
  fftInPlace(bRe, bIm)
  for (let i = 0; i < m; i++) {
    const tRe = aRe[i]! * bRe[i]! - aIm[i]! * bIm[i]!
    aIm[i] = aRe[i]! * bIm[i]! + aIm[i]! * bRe[i]!
    aRe[i] = tRe
  }
  ifftInPlace(aRe, aIm)
  for (let k = 0; k < n; k++) {
    const cRe = aRe[k + n - 1]!
    const cIm = aIm[k + n - 1]!
    // X[k] = exp(-iθk)·c[k+n-1]
    re[k] = cRe * cosW[k]! + cIm * sinW[k]!
    im[k] = cIm * cosW[k]! - cRe * sinW[k]!
  }
}

/** 任意长度的正变换入口：2 的幂走 radix-2，其余走 Bluestein。 */
export function fftAnyInPlace(re: Float32Array, im: Float32Array): void {
  const n = re.length
  if (n <= 1) return
  if ((n & (n - 1)) === 0) {
    fftInPlace(re, im)
    return
  }
  bluesteinFft(re, im)
}

/** 任意长度的逆变换：共轭 → 正变换 → 共轭 / n。 */
export function ifftAnyInPlace(re: Float32Array, im: Float32Array): void {
  const n = re.length
  for (let i = 0; i < n; i++) im[i] = -im[i]!
  fftAnyInPlace(re, im)
  const inv = 1 / n
  for (let i = 0; i < n; i++) {
    re[i] = re[i]! * inv
    im[i] = -im[i]! * inv
  }
}

/** 逆 FFT：共轭 → FFT → 共轭 / n。 */
export function ifftInPlace(re: Float32Array, im: Float32Array): void {
  const n = re.length
  for (let i = 0; i < n; i++) im[i] = -im[i]!
  fftInPlace(re, im)
  const inv = 1 / n
  for (let i = 0; i < n; i++) {
    re[i] = re[i]! * inv
    im[i] = -im[i]! * inv
  }
}

export interface Spectrum {
  /** [channel][frame * bins + bin] */
  re: Float32Array[]
  im: Float32Array[]
  frames: number
  bins: number
}

/**
 * 从 `startSample` 开始取 `frames` 帧。第 f 帧覆盖 `startSample + f*hop - nFft/2` 到 +nFft，
 * 越界部分补零 —— 等价于 librosa 的 center=True，保证首尾也能重建。
 */
export function stft(
  channels: Float32Array[],
  startSample: number,
  frames: number,
  opts: StftOptions = DEFAULT_STFT
): Spectrum {
  const { nFft, hop } = opts
  const center = opts.center !== false
  const bins = center ? nFft / 2 + 1 : nFft / 2
  const win = hannWindow(nFft)
  const out: Spectrum = {
    re: channels.map(() => new Float32Array(frames * bins)),
    im: channels.map(() => new Float32Array(frames * bins)),
    frames,
    bins
  }
  const re = new Float32Array(nFft)
  const im = new Float32Array(nFft)
  const length = channels[0]?.length ?? 0

  for (let frame = 0; frame < frames; frame++) {
    const origin = startSample + frame * hop - (center ? nFft >> 1 : 0)
    for (let ch = 0; ch < channels.length; ch++) {
      const src = channels[ch]!
      for (let i = 0; i < nFft; i++) {
        const idx = origin + i
        re[i] = idx >= 0 && idx < length ? src[idx]! * win[i]! : 0
        im[i] = 0
      }
      fftAnyInPlace(re, im)
      const base = frame * bins
      for (let b = 0; b < bins; b++) {
        out.re[ch]![base + b] = re[b]!
        out.im[ch]![base + b] = im[b]!
      }
    }
  }
  return out
}

/**
 * 把复数谱重建回时域并累加到 `target`，同时累加窗能量到 `norm`。
 * mask 直接乘在谱上（实 mask），因此不需要相位重建以外的任何处理。
 */
export function istftAdd(
  target: Float32Array[],
  norm: Float32Array,
  specRe: Float32Array[],
  specIm: Float32Array[],
  startSample: number,
  frames: number,
  opts: StftOptions = DEFAULT_STFT
): void {
  const { nFft, hop } = opts
  const center = opts.center !== false
  const bins = center ? nFft / 2 + 1 : nFft / 2
  const win = hannWindow(nFft)
  const re = new Float32Array(nFft)
  const im = new Float32Array(nFft)
  const length = target[0]?.length ?? 0

  for (let frame = 0; frame < frames; frame++) {
    const origin = startSample + frame * hop - (center ? nFft >> 1 : 0)
    const base = frame * bins
    for (let ch = 0; ch < target.length; ch++) {
      const srcRe = specRe[ch]
      const srcIm = specIm[ch]
      if (!srcRe || !srcIm) continue
      // 共轭对称补全上半边
      for (let b = 0; b < bins; b++) {
        re[b] = srcRe[base + b]!
        im[b] = srcIm[base + b]!
      }
      for (let b = 1; b < nFft / 2; b++) {
        re[nFft - b] = re[b]!
        im[nFft - b] = -im[b]!
      }
      ifftAnyInPlace(re, im)
      const dst = target[ch]!
      for (let i = 0; i < nFft; i++) {
        const idx = origin + i
        if (idx < 0 || idx >= length) continue
        dst[idx] = dst[idx]! + re[i]! * win[i]!
      }
    }
    for (let i = 0; i < nFft; i++) {
      const idx = origin + i
      if (idx < 0 || idx >= length) continue
      norm[idx] = norm[idx]! + win[i]! * win[i]!
    }
  }
}

/** 用上面累加的窗能量归一化，得到最终波形。 */
export function applyNorm(target: Float32Array[], norm: Float32Array): void {
  for (const channel of target) {
    for (let i = 0; i < channel.length; i++) {
      const n = norm[i]!
      if (n > 1e-6) channel[i] = channel[i]! / n
    }
  }
}

/** 每 `windowSec` 一个采样点的 RMS 包络，归一到 0..1。用于人声乐句检测。 */
export function rmsCurve(samples: Float32Array, sampleRate: number, windowSec = 0.1): number[] {
  const step = Math.max(1, Math.round(sampleRate * windowSec))
  const out: number[] = []
  let peak = 0
  for (let i = 0; i < samples.length; i += step) {
    let sum = 0
    const end = Math.min(samples.length, i + step)
    for (let k = i; k < end; k++) sum += samples[k]! * samples[k]!
    const rms = Math.sqrt(sum / Math.max(1, end - i))
    out.push(rms)
    if (rms > peak) peak = rms
  }
  if (peak > 0) for (let i = 0; i < out.length; i++) out[i] = out[i]! / peak
  return out
}

/**
 * 从人声能量曲线找「有人在唱」的乐句：阈值 + 最短时长 + 合并短间隔。
 * 规划器拿它来挑「人声退出点」。
 */
export function detectPhrases(
  curve: number[],
  windowSec: number,
  offsetSec = 0,
  threshold = 0.12,
  minGapSec = 0.45,
  minPhraseSec = 0.6
): { start: number; end: number }[] {
  const phrases: { start: number; end: number }[] = []
  let start = -1
  for (let i = 0; i < curve.length; i++) {
    const loud = curve[i]! > threshold
    if (loud && start < 0) start = i
    if (!loud && start >= 0) {
      const from = offsetSec + start * windowSec
      const to = offsetSec + i * windowSec
      if (to - from >= minPhraseSec) phrases.push({ start: from, end: to })
      start = -1
    }
  }
  if (start >= 0) {
    const from = offsetSec + start * windowSec
    const to = offsetSec + curve.length * windowSec
    if (to - from >= minPhraseSec) phrases.push({ start: from, end: to })
  }
  // 合并间隔很小的相邻乐句，避免规划器在换气处误判停顿
  const merged: { start: number; end: number }[] = []
  for (const phrase of phrases) {
    const last = merged[merged.length - 1]
    if (last && phrase.start - last.end < minGapSec) last.end = phrase.end
    else merged.push({ ...phrase })
  }
  return merged
}

/**
 * 从 ONNX 输出里取人声掩码。
 *
 * 输出的布局是 [1, C, bins, frames] —— **时间维在最后**，所以第 (b, f) 个元素
 * 位于 c*bins*frames + b*frames + f。按 frame-major 读会把掩码整体转置，
 * 分轨结果就是一片噪声（这是之前那版分轨「能跑但完全不对」的原因）。
 *
 * 第 0 通道是人声（UVR 的 MDX / MDX23C 都取第一通道），伴奏用 1 - 掩码。
 */
export function readVocalMask(
  data: Float32Array,
  bins: number,
  frames: number,
  paddedFrames: number
): Float32Array {
  const out = new Float32Array(frames * bins)
  for (let frame = 0; frame < frames; frame++) {
    const to = frame * bins
    for (let bin = 0; bin < bins; bin++) {
      const raw = data[bin * paddedFrames + frame]!
      out[to + bin] = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0
    }
  }
  return out
}
