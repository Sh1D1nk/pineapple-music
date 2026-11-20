import { useEffect } from 'react'
import { frameBudgetMs, frameSummary } from './core'
import { useStore } from '../state/store'

/**
 * 性能守护：只在「自动」模式下工作。
 *
 * 连续两个 2 秒窗口 p95 超过 1.8 帧预算 → 降级（玻璃磨砂、歌词模糊关、背景降采样）；
 * 连续六个窗口回到 1.3 帧预算以内 → 恢复。
 * 它只改材质与采样密度，不碰任何动画参数。
 */
export function PerfGovernor(): null {
  const mode = useStore((s) => s.settings.performanceMode)
  const setPerfLow = useStore((s) => s.setPerfLow)

  useEffect(() => {
    if (mode !== 'auto') {
      setPerfLow(false)
      return undefined
    }
    let bad = 0
    let good = 0
    const timer = window.setInterval(() => {
      const frames = frameSummary()
      if (frames.samples < 30) return
      const budget = frameBudgetMs()
      const low = useStore.getState().perfLow
      if (frames.p95 > budget * 1.8) {
        bad++
        good = 0
      } else if (frames.p95 < budget * 1.3) {
        good++
        bad = 0
      }
      if (!low && bad >= 2) {
        setPerfLow(true)
        bad = 0
      } else if (low && good >= 6) {
        setPerfLow(false)
        good = 0
      }
    }, 2000)
    return () => window.clearInterval(timer)
  }, [mode, setPerfLow])

  return null
}
