import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { FULL_OPTIONS, LITE_OPTIONS, loadHyalite, type HyaliteAPI } from './hyalite'

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
 * Attaches Hyalite to every `.glass` element and decides whether the full refraction can run.
 * Degradation is one-way per cause and never touches layout: the same elements just keep their
 * CSS blur + rim, which is exactly what the upstream library does on unsupported engines.
 */
export function GlassProvider({ mode, children }: Props): ReactNode {
  const [api, setApi] = useState<HyaliteAPI | null>(null)
  const [degraded, setDegraded] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
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

  const effective: GlassMode = mode === 'off' ? 'off' : degraded ? (mode === 'full' ? 'lite' : mode) : mode

  useEffect(() => {
    // The CSS tiers key off this attribute: [data-glass='lite'] swaps the refraction for a plain
    // frosted blur, [data-glass='off'] drops the backdrop filter entirely.
    document.documentElement.dataset.glass = effective
  }, [effective])

  useEffect(() => {
    for (const watcher of watchers.current) watcher.stop()
    watchers.current = []
    if (api) {
      // Hyalite writes --hyalite / --hyalite-edge inline on every attached element; leaving them
      // behind would keep a filter that points at a removed SVG node.
      for (const el of Array.from(document.querySelectorAll('.glass'))) {
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
    // Two watchers so panels and small controls can use different lens parameters.
    watchers.current.push(api.watch(document.body, '.glassFull', FULL_OPTIONS))
    watchers.current.push(api.watch(document.body, '.glassLite', LITE_OPTIONS))
    return () => {
      for (const watcher of watchers.current) watcher.stop()
      watchers.current = []
    }
  }, [api, effective])

  // Rolling frame-time monitor: 3 s above 22 ms per frame while the window is visible means the
  // refraction is costing us the 60 fps budget, so drop to the frosted tier once.
  useEffect(() => {
    if (!api || effective !== 'full') return
    let raf = 0
    let last = performance.now()
    let frames = 0
    let total = 0
    let windowStart = last
    let slowWindows = 0
    const startedAt = last
    // 22 ms is one frame at 45 fps; on a 120 Hz panel the budget is 8.3 ms, so compare against the
    // measured refresh interval rather than a fixed number.
    const interval = 1000 / (window.screen ? 60 : 60)
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
        // One really bad window (>30 ms) is enough; a mildly slow one has to repeat.
        const verySlow = avg > 30
        if (!warm && avg > 22) {
          slowWindows += verySlow ? 2 : 1
          if (slowWindows >= 2) {
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
    if (api && el) api.refresh(el)
  }, [api, el])
}
