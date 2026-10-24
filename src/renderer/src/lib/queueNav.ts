import type { RepeatMode } from '@shared/types'

/**
 * 队列推进的纯函数：一次用户操作 = 恰好一格。
 *
 * 之前「切歌重复」的观感有一半来自这里没有可验证的规则 —— index + 1 写在 action 里，
 * 越界与循环混在同一段分支中，出问题时只能靠肉眼看。抽出来之后可以直接单测：
 * 连点 10 次必须正好前进 10 格，不多不少。
 */
export function nextQueueIndex(current: number, length: number, repeat: RepeatMode): number | null {
  if (length <= 0) return null
  const next = current + 1
  if (next < length) return next
  // 只在「列表循环」时回到队首；单曲循环的交由 ended 处理器自己重播
  return repeat === 'all' ? 0 : null
}

export function prevQueueIndex(current: number, length: number): number {
  if (length <= 0) return 0
  return Math.max(0, Math.min(current - 1, length - 1))
}

/** 连续点按的落点，只用于测试与诊断：从 start 连点 steps 次会停在哪一格。 */
export function advanceBy(start: number, steps: number, length: number, repeat: RepeatMode): number {
  let index = start
  for (let i = 0; i < steps; i++) {
    const next = nextQueueIndex(index, length, repeat)
    if (next === null) return index
    index = next
  }
  return index
}
