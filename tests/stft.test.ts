import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STFT,
  applyNorm,
  detectPhrases,
  fftAnyInPlace,
  fftInPlace,
  ifftInPlace,
  istftAdd,
  rmsCurve,
  stft
} from '../src/shared/stem/stft'

const SR = 44100

function tone(seconds: number, freq: number): Float32Array {
  const out = new Float32Array(Math.floor(seconds * SR))
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / SR) * 0.5
  return out
}

describe('FFT', () => {
  it('round-trips through fft/ifft', () => {
    const n = 1024
    const re = new Float32Array(n)
    const im = new Float32Array(n)
    for (let i = 0; i < n; i++) re[i] = Math.sin(i * 0.1) + Math.cos(i * 0.03)
    const original = re.slice()
    fftInPlace(re, im)
    ifftInPlace(re, im)
    for (let i = 0; i < n; i++) expect(Math.abs(re[i]! - original[i]!)).toBeLessThan 
      (1e-4)
  })

  it('rejects non power-of-two lengths', () => {
    expect(() => fftInPlace(new Float32Array(3), new Float32Array(3))).toThrow()
  })

  it('Bluestein 任意长度 FFT 与直接 DFT 一致（n=6144 的正弦峰值应落在对应 bin）', () => {
    // 6144 点：n_fft=6144（VOC-FT 一族）的实测长度
    const n = 6144
    const bin = 97 // 任选一个非零 bin
    const re = new Float32Array(n)
    const im = new Float32Array(n)
    for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * bin * i) / n)
    fftAnyInPlace(re, im)
    // 正弦的频谱应集中在 ±bin（虚部/实部幅度 ≈ n/2）
    expect(Math.hypot(re[bin]!, im[bin]!)).toBeGreaterThan(n * 0.45)
    expect(Math.hypot(re[n - bin]!, im[n - bin]!)).toBeGreaterThan(n * 0.45)
    // 其它位置应接近 0（泄漏之外）
    const stray = Math.hypot(re[bin + 7]!, im[bin + 7]!)
    expect(stray).toBeLessThan(n * 0.01)
  })
})

describe('STFT / iSTFT', () => {
  it('reconstructs the signal (COLA + window normalisation)', () => {
    const signal = tone(1.2, 440)
    const channels = [signal, signal.map((v) => v * 0.5)]
    const frames = Math.ceil((signal.length + DEFAULT_STFT.nFft) / DEFAULT_STFT.hop)
    const spec = stft(channels, 0, frames)
    expect(spec.bins).toBe(2049)

    const target = [new Float32Array(signal.length), new Float32Array(signal.length)]
    const norm = new Float32Array(signal.length)
    istftAdd(target, norm, spec.re, spec.im, 0, frames)
    applyNorm(target, norm)

    let maxError = 0
    for (let i = 0; i < signal.length; i++) {
      maxError = Math.max(maxError, Math.abs(target[0]![i]! - signal[i]!))
    }
    // 边缘（补零区）不参与比较
    expect(maxError).toBeLessThan(1e-3)
  })

  it('splits a signal into two halves whose sum is the original', () => {
    const signal = tone(0.6, 220)
    const frames = Math.ceil((signal.length + DEFAULT_STFT.nFft) / DEFAULT_STFT.hop)
    const spec = stft([signal], 0, frames)
    const vocRe = [new Float32Array(frames * spec.bins)]
    const vocIm = [new Float32Array(frames * spec.bins)]
    const insRe = [new Float32Array(frames * spec.bins)]
    const insIm = [new Float32Array(frames * spec.bins)]
    const mask = 0.35
    for (let i = 0; i < frames * spec.bins; i++) {
      vocRe[0]![i] = spec.re[0]![i]! * mask
      vocIm[0]![i] = spec.im[0]![i]! * mask
      insRe[0]![i] = spec.re[0]![i]! * (1 - mask)
      insIm[0]![i] = spec.im[0]![i]! * (1 - mask)
    }
    const vocals = [new Float32Array(signal.length)]
    const inst = [new Float32Array(signal.length)]
    const normA = new Float32Array(signal.length)
    const normB = new Float32Array(signal.length)
    istftAdd(vocals, normA, vocRe, vocIm, 0, frames)
    istftAdd(inst, normB, insRe, insIm, 0, frames)
    applyNorm(vocals, normA)
    applyNorm(inst, normB)

    let vocalRms = 0
    let instRms = 0
    let sumError = 0
    for (let i = 0; i < signal.length; i++) {
      vocalRms += vocals[0]![i]! ** 2
      instRms += inst[0]![i]! ** 2
      sumError = Math.max(sumError, Math.abs(vocals[0]![i]! + inst[0]![i]! - signal[i]!))
    }
    vocalRms = Math.sqrt(vocalRms / signal.length)
    instRms = Math.sqrt(instRms / signal.length)
    expect(vocalRms / instRms).toBeGreaterThan(0.4)
    expect(vocalRms / instRms).toBeLessThan(0.7)
    expect(sumError).toBeLessThan(1e-3)
  })
})

describe('vocal curve & phrases', () => {
  it('finds silent gaps between sung phrases', () => {
    const seconds = 6
    const pcm = new Float32Array(seconds * SR)
    const sing = (from: number, to: number): void => {
      for (let i = Math.floor(from * SR); i < Math.floor(to * SR); i++) {
        pcm[i] = Math.sin((2 * Math.PI * 300 * i) / SR) * 0.6
      }
    }
    sing(0.5, 2)
    sing(3, 5)
    const curve = rmsCurve(pcm, SR, 0.05)
    expect(curve.length).toBe(120)
    const phrases = detectPhrases(curve, 0.05, 0, 0.12, 0.4, 0.5)
    expect(phrases.length).toBe(2)
    expect(phrases[0]!.start).toBeGreaterThan(0.3)
    expect(phrases[0]!.end).toBeLessThan(2.4)
    expect(phrases[1]!.start).toBeGreaterThan(2.6)
  })
})
