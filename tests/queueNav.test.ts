// 队列推进：一次操作 = 恰好一格。
// 之前 index + 1 的越界/循环分支混在 store action 里，出问题只能肉眼复现；
// 抽成纯函数后可以机械验证「连点 10 次正好前进 10 首」。

import { describe, expect, it } from 'vitest'
import { advanceBy, nextQueueIndex, prevQueueIndex } from '../src/renderer/src/lib/queueNav'

describe('queueNav: 下一首', () => {
  it('advances exactly one slot per call', () => {
    expect(nextQueueIndex(0, 20, 'off')).toBe(1)
    expect(nextQueueIndex(7, 20, 'off')).toBe(8)
  })

  it('lands on the 11th track after ten clicks', () => {
    // 从第 1 首开始连点 10 次 → 第 11 首（索引 10），不多不少
    expect(advanceBy(0, 10, 30, 'off')).toBe(10)
  })

  it('stops at the end when repeat is off', () => {
    expect(nextQueueIndex(9, 10, 'off')).toBeNull()
    expect(advanceBy(8, 5, 10, 'off')).toBe(9)
  })

  it('wraps to the top only when repeat-all is on', () => {
    expect(nextQueueIndex(9, 10, 'all')).toBe(0)
    expect(nextQueueIndex(9, 10, 'one')).toBeNull()
  })

  it('handles an empty queue without inventing an index', () => {
    expect(nextQueueIndex(0, 0, 'all')).toBeNull()
  })
})

describe('queueNav: 上一首', () => {
  it('never goes negative and clamps at both ends', () => {
    expect(prevQueueIndex(0, 10)).toBe(0)
    expect(prevQueueIndex(3, 10)).toBe(2)
    expect(prevQueueIndex(11, 10)).toBe(9)
    expect(prevQueueIndex(0, 0)).toBe(0)
  })
})
