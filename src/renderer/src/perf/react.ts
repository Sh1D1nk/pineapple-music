import { useLayoutEffect } from 'react'
import { finishPaint, phase } from './core'

/**
 * 面板/浮层用：打开后记录提交与首帧。
 * 视图页面由 App 的 ViewHost 统一记录，这里只服务「状态驱动的浮层」。
 */
export function useOpenPaint(active: boolean): void {
  useLayoutEffect(() => {
    if (!active) return undefined
    phase('commit')
    let inner = 0
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => finishPaint())
    })
    return () => {
      cancelAnimationFrame(outer)
      cancelAnimationFrame(inner)
    }
  }, [active])
}
