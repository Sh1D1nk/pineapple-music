import { describe, expect, it } from 'vitest'
import { detectVocalPhrases } from '../src/shared/dsp/vocal'

const SR = 44100

/** 伴奏：80Hz bass + 8kHz hi-hat 噪声（都在人声频带之外） */
function backing(seconds: number, gain = 0.35): Float32Array {
  const n = Math.floor(seconds * SR)
  const out = new Float32Array(n)
  let seed = 12345
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    const noise = (seed / 0x7fffffff) * 2 - 1
    out[i] = Math.sin((2 * Math.PI * 80 * i) / SR) * gain + noise * gain * 0.25
  }
  return out
}

/** 人声仿真：440Hz 基频 + 2/3 次谐波 + 4Hz 幅度颤音（中频为主） */
function voice(seconds: number, gain = 0.5): Float32Array {
  const n = Math.floor(seconds * SR)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const env = 0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t)
    const tone =
      Math.sin(2 * Math.PI * 440 * t) +
      0.5 * Math.sin(2 * Math.PI * 880 * t) +
      0.3 * Math.sin(2 * Math.PI * 1320 * t)
    out[i] = tone * gain * env
  }
  return out
}

/** 把 src 叠到 dst 的 atSec 处 */
function place(dst: Float32Array, src: Float32Array, atSec: number): void {
  const off = Math.floor(atSec * SR)
  for (let i = 0; i < src.length && off + i < dst.length; i++) dst[off + i] += src[i]!
}

describe('轻量人声活动检测（AutoMix 快速通道）', () => {
  it('只在有人声的区间触发（伴奏段不误报）', () => {
    // 0-2s 伴奏 / 2-4s 伴奏+人声 / 4-5s 伴奏
    const track = backing(5)
    place(track, voice(2), 2)

    const phrases = detectVocalPhrases(track, SR, 0)
    expect(phrases.length).toBe(1)
    expect(phrases[0]!.start).toBeGreaterThan(1.85)
    expect(phrases[0]!.start).toBeLessThan(2.2)
    expect(phrases[0]!.end).toBeGreaterThan(3.8)
    expect(phrases[0]!.end).toBeLessThan(4.2)
  })

  it('纯伴奏不产生任何乐句', () => {
    const phrases = detectVocalPhrases(backing(4), SR, 0)
    expect(phrases).toHaveLength(0)
  })

  it('两段人声、中间有停顿 → 合并短间隙后仍是两段', () => {
    const track = backing(6)
    place(track, voice(1.2), 2)
    place(track, voice(1.2), 4)

    const phrases = detectVocalPhrases(track, SR, 0)
    expect(phrases.length).toBe(2)
    expect(phrases[0]!.end - phrases[0]!.start).toBeGreaterThan(1)
    expect(phrases[1]!.start).toBeGreaterThan(3.8)
  })

  it('人声被更响的伴奏压住时仍能检出（真实混音场景）', () => {
    // 人声能量约为伴奏的 45%（正常主唱比例），中频占比被稀释到 ~0.15
    const track = backing(5, 0.9)
    place(track, voice(2, 0.85), 2)
    const phrases = detectVocalPhrases(track, SR, 0)
    expect(phrases.length).toBe(1)
    expect(phrases[0]!.start).toBeGreaterThan(1.8)
    expect(phrases[0]!.end).toBeLessThan(4.3)
  })

  it('offset 会加进绝对时间（尾部窗口场景）', () => {
    const track = backing(3)
    place(track, voice(1.5), 1.5)
    const phrases = detectVocalPhrases(track, SR, 120)
    expect(phrases.length).toBe(1)
    expect(phrases[0]!.start).toBeGreaterThan(121.3)
    expect(phrases[0]!.start).toBeLessThan(121.8)
  })
})
