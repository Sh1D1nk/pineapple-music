import { describe, expect, it } from 'vitest'
import { ENDED_GUARD_MS, shouldAcceptEnded } from '../src/renderer/src/audio/endedGuard'

describe('ended 事件接纳判据', () => {
  it('拒绝旧资源迟到的事件（load() 已把 ended 置回 false）', () => {
    expect(
      shouldAcceptEnded({ withinGuard: true, elementEnded: false, alreadyFired: false })
    ).toBe(false)
  })

  it('拒绝同一首歌的第二次 ended', () => {
    expect(
      shouldAcceptEnded({ withinGuard: false, elementEnded: true, alreadyFired: true })
    ).toBe(false)
  })

  it('接受正常的播完事件', () => {
    expect(
      shouldAcceptEnded({ withinGuard: false, elementEnded: true, alreadyFired: false })
    ).toBe(true)
  })

  it('保护窗口内也接受真实播完（拖到结尾的极端场景不被吞）', () => {
    // 用户刚开播就拖到 95%，歌曲在 900ms 内结束 —— 真实播完必须放行
    expect(
      shouldAcceptEnded({ withinGuard: true, elementEnded: true, alreadyFired: false })
    ).toBe(true)
  })

  it('保护窗口常量是 900ms', () => {
    expect(ENDED_GUARD_MS).toBe(900)
  })
})
