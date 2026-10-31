import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { LiquidGlass } from 'apple-liquid-glass-webgl'
import { Icon, type IconName } from './Icon'
import { LiquidDropletFilter } from './LiquidDropletFilter'
import { useStore } from '../state/store'
import styles from './BottomBar.module.css'

/**
 * 液态玻璃悬浮底栏 —— 对照 HeyBox-LiquidGlass（小黑盒模块）+ KernelSU 的行为：
 *
 *   尺寸/材质：底栏 62 / 气泡 48 / tab 86 / 内边距 6 / 气泡左右 inset 4
 *   气泡材质：折射 + 色散（RGB 错位 1.6px）+ 模糊 3px；底栏色散保持很弱
 *            （原版：底栏 dispersion 0.12，气泡 DISPERSION 0.35 + BLUR_RADIUS 1.2）
 *   位移：380ms OvershootInterpolator(1.1)  → cubic-bezier(.18,1.3,.36,1)
 *   宽变：340ms DecelerateInterpolator(1.6) → cubic-bezier(.12,.75,.2,1)
 *   拖动：跟手（无过渡），速度决定形变 stretch = clamp(|v|*0.08, 0, 0.14)
 *   松手：按 round 吸附，变了才切页
 *
 * 关键修正：气泡绘制在 track 之外（track 是横向滚动容器，会把越界的气泡裁掉）。
 */

const NAV: {
  key: 'recent' | 'artists' | 'albums' | 'songs' | 'favorites' | 'settings'
  label: string
  icon: IconName
}[] = [
  { key: 'recent', label: '最近添加', icon: 'clock' },
  { key: 'artists', label: '艺人', icon: 'mic' },
  { key: 'albums', label: '专辑', icon: 'disc' },
  { key: 'songs', label: '歌曲', icon: 'music' },
  { key: 'favorites', label: '收藏', icon: 'star' },
  { key: 'settings', label: '设置', icon: 'gear' }
]

const MATERIAL = {
  refraction: 84,
  edgeReach: 0.16,
  edgeWidth: 0.22,
  // 底栏几乎不色散（原版 0.12）；大色散只在气泡里
  dispersion: 0.12,
  body: 0.72,
  absorption: 0.58,
  rim: 0.3,
  reflection: 0.34,
  highlight: 0.4,
  lightAngle: 136,
  echo: 0.3,
  hairline: 0.9,
  hairWidth: 0.55
}

const EDGE_DAMPING = 0.25
const OVERSHOOT = 0.3
const PILL_INSET = 4

const activeKeyOf = (kind: string): string =>
  kind === 'settings' ? 'settings' : kind === 'album' ? 'recent' : kind === 'artist' ? 'artists' : kind

export function BottomBar(): JSX.Element {
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const setSearch = useStore((s) => s.setSearch)
  const songIds = useStore((s) => s.songIds)
  const playRandom = useStore((s) => s.playRandom)
  const pushToast = useStore((s) => s.pushToast)

  const barRef = useRef<HTMLDivElement>(null)
  const pillRef = useRef<HTMLSpanElement>(null)
  const randomRef = useRef<HTMLButtonElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())
  const metricsRef = useRef<{ left: number; width: number }[]>([])
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startProgress: number
    moved: boolean
    lastX: number
    lastT: number
  } | null>(null)
  const dragCleanupRef = useRef<(() => void) | null>(null)

  const [progress, setProgress] = useState(0)
  const progressRef = useRef(0)
  const [stretch, setStretch] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [scrollLeft, setScrollLeft] = useState(0)
  const [webgl, setWebgl] = useState(false)

  const keys: string[] = NAV.map((entry) => entry.key as string)
  const activeKey = activeKeyOf(view.kind)
  const activeIndex = Math.max(0, keys.indexOf(activeKey))
  const lastIndex = keys.length - 1

  /** 原版 popChild：按下选中时气泡先弹到 1.16 再回落（90ms 过冲 + 240ms 回弹） */
  const popPill = (): void => {
    const el = pillRef.current
    if (!el) return
    el.animate(
      [{ scale: '1' }, { scale: '1.16', offset: 0.27 }, { scale: '1' }],
      { duration: 330, easing: 'cubic-bezier(0.34, 1.55, 0.64, 1)' }
    )
  }

  const activate = (key: string): void => {
    popPill()
    if (key === 'settings') {
      setView({ kind: 'settings' })
      return
    }
    setSearch('')
    setView({ kind: key } as never)
  }

  const measure = (): { left: number; width: number }[] => {
    const list = keys.map((key) => {
      const tab = tabRefs.current.get(key)
      return tab ? { left: tab.offsetLeft, width: tab.offsetWidth } : { left: 0, width: 0 }
    })
    metricsRef.current = list
    return list
  }

  useEffect(() => {
    const bar = barRef.current
    const track = trackRef.current
    if (!bar) return undefined
    measure()
    setProgress((p) => p)
    const ro = new ResizeObserver(() => {
      measure()
      setProgress((p) => p)
    })
    ro.observe(bar)
    const onScroll = (): void => setScrollLeft(track?.scrollLeft ?? 0)
    track?.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      ro.disconnect()
      track?.removeEventListener('scroll', onScroll)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 选中项变化：气泡走 380ms 过冲曲线滑过去（非拖动时才有过渡）
  useLayoutEffect(() => {
    if (dragRef.current) return
    progressRef.current = activeIndex
    setProgress(activeIndex)
    setStretch(0)
  }, [activeIndex, view.kind])

  const indexAt = (clientX: number): number => {
    const track = trackRef.current
    const list = metricsRef.current
    if (!track || list.length === 0) return activeIndex
    const x = clientX - track.getBoundingClientRect().left + track.scrollLeft
    for (let i = 0; i < list.length; i++) {
      const m = list[i]!
      if (x >= m.left && x <= m.left + m.width) return i
    }
    return x < (list[0]?.left ?? 0) ? 0 : lastIndex
  }

  const dragMove = (clientX: number): void => {
    const state = dragRef.current
    if (!state) return
    if (!state.moved) {
      if (Math.abs(clientX - state.startX) < 3) return
      state.moved = true
    }
    const list = metricsRef.current
    const avgWidth = list.find((m) => m.width > 0)?.width ?? 86
    const delta = (clientX - state.startX) / avgWidth
    const next = Math.max(-OVERSHOOT, Math.min(lastIndex + OVERSHOOT, state.startProgress + delta))

    const now = performance.now()
    const dt = Math.max(1, now - state.lastT) / 1000
    const instantVelocity = (next - progressRef.current) / dt
    state.lastX = clientX
    state.lastT = now

    progressRef.current = next
    setProgress(next)
    setStretch(Math.min(0.14, Math.abs(instantVelocity) * 0.08))
  }

  const dragEnd = (): void => {
    const state = dragRef.current
    dragRef.current = null
    if (!state) return
    setDragging(false)
    const target = Math.max(0, Math.min(lastIndex, Math.round(progressRef.current)))
    progressRef.current = target
    setProgress(target)
    setStretch(0)
    if (target !== activeIndex) activate(keys[target]!)
  }

  const dragCancel = (): void => {
    dragRef.current = null
    setDragging(false)
    setStretch(0)
    progressRef.current = activeIndex
    setProgress(activeIndex)
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    const index = indexAt(event.clientX)
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startProgress: index,
      moved: false,
      lastX: event.clientX,
      lastT: performance.now()
    }
    progressRef.current = index
    setProgress(index)
    setStretch(0)
    setDragging(true)

    // window 级监听：pointer capture 会在鼠标移出元素时被 Chromium 取消
    const pointerId = event.pointerId
    const move = (e: PointerEvent): void => {
      if (e.pointerId === pointerId) dragMove(e.clientX)
    }
    const up = (e: PointerEvent): void => {
      if (e.pointerId !== pointerId) return
      cleanup()
      dragEnd()
    }
    const cancel = (e: PointerEvent): void => {
      if (e.pointerId !== pointerId) return
      cleanup()
      dragCancel()
    }
    const cleanup = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      dragCleanupRef.current = null
    }
    dragCleanupRef.current = cleanup
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const current = Math.max(0, keys.indexOf(activeKey))
    let next: number | null = null
    if (event.key === 'ArrowLeft') next = Math.max(0, current - 1)
    else if (event.key === 'ArrowRight') next = Math.min(lastIndex, current + 1)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = lastIndex
    if (next === null) return
    event.preventDefault()
    activate(keys[next]!)
  }

  useEffect(() => {
    return () => {
      dragCleanupRef.current?.()
    }
  }, [])

  // 横向滚动：竖向滚轮映射到横向
  useEffect(() => {
    const track = trackRef.current
    if (!track) return undefined
    const onWheel = (event: WheelEvent): void => {
      if (Math.abs(event.deltaY) < Math.abs(event.deltaX)) return
      track.scrollLeft += event.deltaY
      event.preventDefault()
    }
    track.addEventListener('wheel', onWheel, { passive: false })
    return () => track.removeEventListener('wheel', onWheel)
  }, [])

  // 玻璃轨道
  useEffect(() => {
    const bar = barRef.current
    const random = randomRef.current
    if (!bar) return undefined
    const instances: { destroy: () => void; refresh?: () => void }[] = []
    const options = {
      backdrop: 'auto' as const,
      shape: 'pill' as const,
      tint: 0.34,
      tintTone: 'dark' as const,
      frost: 0.2,
      maxDpr: 1.5,
      live: false,
      material: MATERIAL
    }
    let timer = 0
    const scroller = document.getElementById('contentScroll')
    const onScroll = (): void => {
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        for (const instance of instances) {
          try {
            instance.refresh?.()
          } catch {
            /* 实例已销毁 */
          }
        }
      }, 160)
    }
    try {
      if (!LiquidGlass.isSupported()) throw new Error('no webgl2')
      instances.push(new LiquidGlass(bar, options) as { destroy: () => void; refresh?: () => void })
      if (random) {
        instances.push(new LiquidGlass(random, { ...options, tint: 0.2 }) as {
          destroy: () => void
          refresh?: () => void
        })
      }
      scroller?.addEventListener('scroll', onScroll, { passive: true })
      setWebgl(true)
    } catch {
      setWebgl(false)
    }
    return () => {
      scroller?.removeEventListener('scroll', onScroll)
      if (timer) window.clearTimeout(timer)
      for (const instance of instances) {
        try {
          instance.destroy()
        } catch {
          /* 上下文已被接管则忽略 */
        }
      }
    }
  }, [])

  const onRandom = (): void => {
    if (songIds.length === 0) {
      pushToast('曲库还是空的，先添加一些音乐吧')
      return
    }
    playRandom()
  }

  // ---- 几何：相邻 tab 之间插值 + 边缘阻尼 ----

  const metrics = metricsRef.current
  const raw = ((): { left: number; width: number } => {
    if (metrics.length === 0) return { left: 0, width: 86 }
    if (progress <= 0) {
      const m = metrics[0]!
      return { left: m.left + progress * m.width * EDGE_DAMPING, width: m.width }
    }
    if (progress >= lastIndex) {
      const m = metrics[lastIndex]!
      const over = progress - lastIndex
      return { left: m.left + over * m.width * EDGE_DAMPING, width: m.width }
    }
    const a = Math.floor(progress)
    const f = progress - a
    const b = Math.min(lastIndex, a + 1)
    const ma = metrics[a]!
    const mb = metrics[b]!
    return { left: ma.left + (mb.left - ma.left) * f, width: ma.width + (mb.width - ma.width) * f }
  })()

  return (
    <nav className={styles.dock} aria-label="资料库导航" data-webgl={webgl ? '1' : '0'}>
      <LiquidDropletFilter />
      <div
        className={styles.bar}
        ref={barRef}
        role="tablist"
        aria-label="资料库分区"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
      >
        {/* 气泡在 track 之外：track 是滚动容器，会把越界的气泡裁掉 */}
        <span
          ref={pillRef}
          className={styles.pill}
          style={{
            width: Math.max(0, raw.width - PILL_INSET * 2),
            transform: `translateX(${raw.left - scrollLeft + PILL_INSET}px) translateY(-50%) scaleX(${1 + stretch}) scaleY(${1 - stretch * 0.25})`,
            transition: dragging ? 'none' : undefined
          }}
          aria-hidden="true"
        />
        <div className={styles.track} ref={trackRef}>
          <div className={styles.strip}>
            {NAV.map((entry, index) => {
              const active = view.kind === entry.key || (entry.key === 'recent' && view.kind === 'album')
              const distance = Math.abs(progress - index)
              const proximity = Math.max(0, Math.min(1, 1 - distance))
              const near = distance < 0.45
              // 原版：lerp(baseColor.copy(alpha=.65), primaryColor, proximity)
              // base = 白 62%，primary = 主题主色 #fa243c
              const r = Math.round(255 + (250 - 255) * proximity)
              const g = Math.round(255 + (36 - 255) * proximity)
              const b = Math.round(255 + (60 - 255) * proximity)
              const alpha = 0.62 + 0.38 * proximity
              return (
                <button
                  key={entry.key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  data-nav={entry.key}
                  data-active={active}
                  ref={(el) => {
                    if (el) tabRefs.current.set(entry.key, el)
                    else tabRefs.current.delete(entry.key)
                  }}
                  className={styles.tab}
                  style={{ color: `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})` }}
                  onClick={() => activate(entry.key)}
                  title={entry.label}
                >
                  <span className={styles.icon} style={{ transform: `scale(${1 + proximity * 0.08})` }}>
                    <Icon name={entry.icon} size={24} />
                  </span>
                  <span className={styles.label} style={{ fontWeight: near ? 600 : 400 }}>
                    {entry.label}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      </div>

      <button
        type="button"
        className={styles.random}
        ref={randomRef}
        onClick={onRandom}
        title="随机挑一首歌播放"
        aria-label="随机推荐"
      >
        <Icon name="sparkles" size={20} />
        <span className={styles.label}>随机</span>
      </button>
    </nav>
  )
}
