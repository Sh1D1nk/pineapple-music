// 回归测试：分轨模型签名自适应 + 掩码读取方向。
//
// 起因（两个真 bug）：
// 1. 运行时只认 bins=2049（居中频谱），而真实的 UVR / MDX-Net 模型是 2048（不居中），
//    于是所有真模型都被判「签名不兼容」，界面上显示成「没安装分轨模型」。
// 2. ONNX 输出是 [1, C, bins, frames]（时间维在最后），旧代码按 frame-major 读，
//    掩码被整体转置 —— 分轨能跑完，但出来的是噪声。

import { describe, expect, it } from 'vitest'
import {
  applyNorm,
  istftAdd,
  readVocalMask,
  stft,
  stftProfileFor
} from '../src/shared/stem/stft'

const SR = 44100

function tone(seconds: number, freq: number): Float32Array {
  const out = new Float32Array(Math.floor(seconds * SR))
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / SR) * 0.5
  return out
}

describe('模型签名 → 频谱配置', () => {
  it('按频点数挑出能跑的频谱', () => {
    expect(stftProfileFor(2049)).toEqual({ nFft: 4096, hop: 1024, center: true })
    expect(stftProfileFor(2048)).toEqual({ nFft: 4096, hop: 1024, center: false })
    expect(stftProfileFor(4097)).toEqual({ nFft: 8192, hop: 2048, center: true })
    expect(stftProfileFor(4096)).toEqual({ nFft: 8192, hop: 2048, center: false })
  })

  it('n_fft 不是 2 的幂的频点数直接判不可用', () => {
    // 3072 → n_fft=6144，本应用的 radix-2 FFT 跑不了
    expect(stftProfileFor(3072)).toBeNull()
  })
})

describe('不居中频谱', () => {
  it('频点数是 n_fft/2', () => {
    const spec = stft([tone(0.2, 440)], 0, 4, { nFft: 4096, hop: 1024, center: false })
    expect(spec.bins).toBe(2048)
  })

  it('首尾补零后能无损重建', () => {
    const signal = tone(1.2, 440)
    const opts = { nFft: 4096, hop: 1024, center: false }
    const pad = opts.nFft / 2
    const padded = new Float32Array(signal.length + pad * 2)
    padded.set(signal, pad)
    const frames = Math.ceil((padded.length + opts.nFft) / opts.hop)
    const spec = stft([padded], 0, frames, opts)
    const target = [new Float32Array(padded.length)]
    const norm = new Float32Array(padded.length)
    istftAdd(target, norm, spec.re, spec.im, 0, frames, opts)
    applyNorm(target, norm)
    let maxError = 0
    for (let i = pad; i < pad + signal.length; i++) {
      maxError = Math.max(maxError, Math.abs(target[0]![i]! - signal[i - pad]!))
    }
    expect(maxError).toBeLessThan(1e-3)
  })
})

describe('掩码读取方向', () => {
  it('按 [C][bins][frames] 读回 frame-major', () => {
    const bins = 4
    const frames = 3
    // 造一个可辨认的输出：第 (b, f) 个元素 = b * 0.2 + f * 0.05（掩码会被夹在 0..1）
    const data = new Float32Array(bins * frames)
    for (let b = 0; b < bins; b++) for (let f = 0; f < frames; f++) data[b * frames + f] = b * 0.2 + f * 0.05
    const mask = readVocalMask(data, bins, frames, frames)
    for (let f = 0; f < frames; f++) {
      for (let b = 0; b < bins; b++) {
        expect(mask[f * bins + b]!).toBeCloseTo(b * 0.2 + f * 0.05, 5)
      }
    }
  })

  it('超范围与 NaN 被夹住', () => {
    const data = new Float32Array([2, -1, Number.NaN, 0.5])
    const mask = readVocalMask(data, 2, 2, 2)
    expect(mask[0]!).toBe(1)
    expect(mask[1]!).toBe(0)
    expect(mask[2]!).toBe(0)
    expect(mask[3]!).toBe(0.5)
  })
})
