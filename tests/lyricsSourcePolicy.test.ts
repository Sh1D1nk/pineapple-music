import { describe, expect, it } from 'vitest'
import { effectiveSources, lyricsCacheStamp } from '../src/main/lyrics/sourcePolicy'

describe('歌词源取用策略', () => {
  it('自动回退开启时按完整优先级尝试', () => {
    expect(effectiveSources(['sidecar', 'embedded', 'text'], true)).toEqual([
      'sidecar',
      'embedded',
      'text'
    ])
  })

  it('自动回退关闭时只尝试第一个来源（不悄悄换源）', () => {
    expect(effectiveSources(['sidecar', 'embedded', 'text'], false)).toEqual(['sidecar'])
    expect(effectiveSources(['embedded', 'sidecar'], false)).toEqual(['embedded'])
  })

  it('过滤非法来源', () => {
    expect(effectiveSources(['sidecar', 'bogus' as never, 'text'], true)).toEqual([
      'sidecar',
      'text'
    ])
  })

  it('空优先级返回空数组', () => {
    expect(effectiveSources([], true)).toEqual([])
  })

  it('缓存键包含回退模式，切换开关不会命中旧缓存', () => {
    const base = {
      sidecarPath: '/m/a.lrc',
      sidecarMtimeMs: 100,
      songMtimeMs: 200,
      priority: ['sidecar', 'embedded'] as ('sidecar' | 'embedded' | 'text')[]
    }
    const on = lyricsCacheStamp({ ...base, autoFallback: true })
    const off = lyricsCacheStamp({ ...base, autoFallback: false })
    expect(on).not.toBe(off)
    expect(on).toContain('fb')
    expect(off).toContain('strict')
  })

  it('缓存键随优先级与文件时间变化', () => {
    const base = {
      sidecarPath: '/m/a.lrc',
      sidecarMtimeMs: 100,
      songMtimeMs: 200,
      autoFallback: true
    }
    const a = lyricsCacheStamp({ ...base, priority: ['sidecar'] })
    const b = lyricsCacheStamp({ ...base, priority: ['embedded', 'sidecar'] })
    const c = lyricsCacheStamp({ ...base, sidecarMtimeMs: 101, priority: ['sidecar'] })
    expect(a).not.toBe(b)
    expect(a).not.toBe(c)
  })
})
