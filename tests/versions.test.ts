import { describe, expect, it } from 'vitest'
import { compareVersions } from '../src/shared/versions'

describe('compareVersions', () => {
  it('按数字段比较，不受 v 前缀影响', () => {
    expect(compareVersions('v1.6.0', '1.5.9')).toBe(1)
    expect(compareVersions('1.6.0', 'v1.6.0')).toBe(0)
    expect(compareVersions('1.4.9', '1.5.0')).toBe(-1)
  })

  it('位数不同时按缺失段为 0 处理', () => {
    expect(compareVersions('1.6', '1.6.0')).toBe(0)
    expect(compareVersions('1.6.1', '1.6')).toBe(1)
    expect(compareVersions('2', '1.99.99')).toBe(1)
  })

  it('忽略构建元数据', () => {
    expect(compareVersions('1.6.0+build.5', '1.6.0')).toBe(0)
  })
})
