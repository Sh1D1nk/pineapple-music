import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { FULL_OPTIONS, LEGACY_FULL_OPTIONS, loadHyalite, type HyaliteAPI } from './hyalite'
import { PERF_LEGACY } from '../perf/flags'
import { glassStats, noteBuild, noteBuildStart } from './stats'
import { useStore } from '../state/store'

export type GlassMode = 'full' | 'lite' | 'off'

export interface GlassState {
  requested: GlassMode
  effective: GlassMode
  supported: boolean
  degraded: string | null
  notice: string | null
  dismissNotice: () => void
  /** Clears an automatic degradation so the user can force the refracted tier back on. */
  resetDegrade: () => void
}

const GlassContext = createContext<GlassState>({
  requested: 'full',
  effective: 'full',
  supported: true,
  degraded: null,
  notice: null,
  dismissNotice: () => undefined,
  resetDegrade: () => undefined
})

export const useGlass = (): GlassState => useContext(GlassContext)

interface Props {
  mode: GlassMode
  children: ReactNode
}

/**
 * 只给「小表面」挂真实折射：悬浮底栏胶囊、圆形按钮、右键菜单。
 *
 * 大面板（侧栏、待播清单、歌词面板、弹窗）一律 CSS 磨砂 + 高光描边：
 * 位移图的大小与面积成正比，整块 360×480 的面板既超出预算（单块 ≤ 60,000 px²），
 * 滚动时还要每帧重采样，是上一版「玻璃一开就卡」的主因。
 * 性能模式（auto 实测掉帧 / on 强制）会把折射整体换成磨砂，动画不受影响。
 */
export function GlassProvider({ mode, children }: Props): ReactNode {
  const [api, setApi] = useState<HyaliteAPI | null>(null)
  const [degraded, setDegraded] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const perfLow = useStore((s) => s.perfLow)
  const performanceMode = useStore((s) => s.settings.performanceMode)
  const watchers = useRef<{ stop(): void }[]>([])
  const monitor = useRef<number | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const loaded = await loadHyalite()
      if (cancelled) return
      setApi(loaded)
      if (!loaded) {
        setDegraded('Hyalite 无法加载')
        return
      }
      if (!loaded.supported()) {
        setDegraded('当前环境不支持 SVG 背景折射')
        return
      }
      const gpu = await window.lm.invoke<{ accelerated: boolean }>('app/gpu').catch(() => null)
      if (gpu && !gpu.accelerated) {
        setDegraded('GPU 未启用硬件加速')
        return
      }
      const mq = window.matchMedia('(prefers-reduced-transparency: reduce)')
      if (mq.matches) setDegraded('系统已开启「减少透明度」')
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const forcedLite = performanceMode === 'on' || perfLow
  const effective: GlassMode =
    mode === 'off' ? 'off' : forcedLite ? 'lite' : degraded ? (mode === 'full' ? 'lite' : mode) : mode

  useEffect(() => {
    document.documentElement.dataset.glass = effective
    document.documentElement.dataset.perf = forcedLite ? 'low' : 'high'
  }, [effective, forcedLite])

  useEffect(() => {
    for (const watcher of watchers.current) watcher.stop()
    watchers.current = []
    if (api) {
      // Hyalite writes --hyalite / --hyalite-edge inline on every attached element; leaving them
      // behind would keep a filter that points at a removed SVG node.
      for (const el of Array.from(document.querySelectorAll('.glassFull'))) {
        try {
          api.detach(el)
        } catch {
          /* not attached */
        }
        ;(el as HTMLElement).style.removeProperty('--hyalite')
        ;(el as HTMLElement).style.removeProperty('--hyalite-edge')
      }
    }
    if (!api || effective !== 'full') return
    // 只监听小表面；.glassLite 走纯 CSS 磨砂，永远不建位移图
    watchers.current.push(
      api.watch(document.body, '.glassFull', {
        ...(PERF_LEGACY ? LEGACY_FULL_OPTIONS : FULL_OPTIONS),
        onBuild: (info) => {
          noteBuild({ mapSize: info.mapSize, maxDisplacement: info.maxDisplacement })
        }
      })
    )
    return () => {
      for (const watcher of watchers.current) watcher.stop()
      watchers.current = []
    }
  }, [api, effective])

  // Rolling frame-time monitor: 3 s above ~26 ms per frame while the window is visible means the
  // refraction is costing the frame budget, so drop to the frosted tier once.
  useEffect(() => {
    if (!api || effective !== 'full') return
    let raf = 0
    let last = performance.now()
    let frames = 0
    let total = 0
    let windowStart = last
    let slowWindows = 0
    const startedAt = last
    const tick = (now: number): void => {
      const dt = now - last
      last = now
      const measuring = document.visibilityState === 'visible' && dt > 0 && dt < 200
      if (measuring) {
        frames++
        total += dt
      }
      if (now - windowStart > 3000) {
        const warm = now - startedAt < 1500
        const avg = frames > 0 ? total / Math.max(1, frames) : 0
        frames = 0
        total = 0
        windowStart = now
        const verySlow = avg > 42
        if (!warm && avg > 26) {
          slowWindows += verySlow ? 2 : 1
          if (slowWindows >= 3) {
            setDegraded('帧耗时持续偏高，已自动降为简化液态玻璃')
            setNotice('已自动降为「简化」液态玻璃以保持流畅，可在设置中改回')
            return
          }
        } else {
          slowWindows = 0
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [api, effective])

  return (
    <GlassContext.Provider
      value={{
        requested: mode,
        effective,
        supported: api?.supported() ?? true,
        degraded,
        notice,
        dismissNotice: () => setNotice(null),
        resetDegrade: () => {
          setDegraded(null)
          setNotice(null)
        }
      }}
    >
      {children}
    </GlassContext.Provider>
  )
}

/** Rebuild the lens map for an element whose geometry changed without a resize (e.g. radius). */
export function useGlassRefresh(api: HyaliteAPI | null, el: HTMLElement | null): void {
  useEffect(() => {
    if (!api || !el) return
    noteBuildStart()
    api.refresh(el)
    // 实际耗时在 onBuild 里结算
    void glassStats
  }, [api, el])
}
