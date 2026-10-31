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
import { useStore } from '../state/store'
import styles from './BottomBar.module.css'

/**
 * 液态玻璃悬浮底栏。
 *
 * 规格照 Miuix 版管理器（LSPosed + MIUIX 主题的「悬浮底栏」）的实现：
 *   `app/src/main/java/io/github/nexalloy/ui/liquid/FluidFloatingBottomBar.kt`
 *
 * 从那份源码里落下来的数值：
 *   底栏 62dp / 指示器 48dp / 每个 tab 86dp / 左右内边距 6dp / 指示器左右 inset 4dp
 *   指示器 = 横条，宽度在相邻 tab 之间按 progress 线性插值
 *   拖出边界时按 0.25 倍位移（阻尼），可越界 0.3 格
 *   速度变形 stretch = clamp(|v| * 0.08, 0, 0.14)，scaleX 1+stretch、scaleY 1-0.25*stretch
 *   弹簧 spring(dampingRatio 0.78, stiffness 420)，松手吸附到最近 tab
 *   图标随 proximity 从 0.65 亮度过渡到主色并放大 1.08×，标签 11sp 近距离加粗
 *   材质 textureBlur(blurRadius 25) + 半透明底 30% + 1dp 白 12% 描边 + 8dp 投影
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
  dispersion: 1.2,
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

/** 与 Kotlin 端 spring(0.78f, 420f) 等价的阻尼弹簧 */
const SPRING_ZETA = 0.78
const SPRING_OMEGA = Math.sqrt(420)
/** 拖出边界时只走 0.25 倍（edge dampening） */
const EDGE_DAMPING = 0.25
/** 允许拖出 0.3 格 */
const OVERSHOOT = 0.3
/** 指示器左右各收 4dp */
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
  const randomRef = useRef<HTMLButtonElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())
  const metricsRef = useRef<{ left: number; width: number }[]>([])

  // 指示器位置（单位：tab index，可越界）
  const [progress, setProgress] = useState(0)
  const progressRef = useRef(0)
  const velocityRef = useRef(0)
  const targetRef = useRef(0)
  const rafRef = useRef(0)
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startProgress: number
    moved: boolean
    lastX: number
    lastT: number
  } | null>(null)
  const dragCleanupRef = useRef<(() => void) | null>(null)
  const [dragging, setDragging] = useState(false)
  const [stretch, setStretch] = useState(0)
  const [webgl, setWebgl] = useState(false)

  const keys: string[] = NAV.map((entry) => entry.key as string)
  const activeKey = activeKeyOf(view.kind)
  const activeIndex = Math.max(0, keys.indexOf(activeKey))
  const lastIndex = keys.length - 1

  const activate = (key: string): void => {
    if (key === 'settings') {
      setView({ kind: 'settings' })
      return
    }
    setSearch('')
    setView({ kind: key } as never)
  }

  // ---- 弹簧动画循环（半隐式欧拉，等价于 Compose 的 spring(0.78, 420)） ----

  const runSpring = (target: number): void => {
    targetRef.current = target
    if (rafRef.current) return
    let last = performance.now()
    const tick = (now: number): void => {
      const dt = Math.min(0.032, (now - last) / 1000)
      last = now
      const x = progressRef.current
      const v = velocityRef.current
      const accel = -2 * SPRING_ZETA * SPRING_OMEGA * v - SPRING_OMEGA * SPRING_OMEGA * (x - targetRef.current)
      const nextV = v + accel * dt
      const nextX = x + nextV * dt
      progressRef.current = nextX
      velocityRef.current = nextV
      setProgress(nextX)
      setStretch(Math.min(0.14, Math.abs(nextV) * 0.08))
      if (Math.abs(nextX - targetRef.current) < 0.001 && Math.abs(nextV) < 0.05) {
        progressRef.current = targetRef.current
        velocityRef.current = 0
        rafRef.current = 0
        setProgress(targetRef.current)
        setStretch(0)
        return
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }

  // 选中项变化（外部触发，如键盘/其他入口）：弹簧滑过去
  useLayoutEffect(() => {
    if (dragRef.current) return
    const index = Math.max(0, keys.indexOf(activeKeyOf(view.kind)))
    if (Math.abs(progressRef.current - index) > 0.001) runSpring(index)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, view.kind])

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      dragCleanupRef.current?.()
    }
  }, [])

  // ---- 布局测量 ----

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
    if (!bar) return undefined
    measure()
    setProgress(progressRef.current)
    const ro = new ResizeObserver(() => {
      measure()
      setProgress(progressRef.current)
    })
    ro.observe(bar)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 指针落在哪个 tab（源码 indexAt 的等价实现） */
  const indexAt = (clientX: number): number => {
    const bar = barRef.current
    const list = metricsRef.current
    if (!bar || list.length === 0) return activeIndex
    const x = clientX - bar.getBoundingClientRect().left
    for (let i = 0; i < list.length; i++) {
      const m = list[i]!
      if (x >= m.left && x <= m.left + m.width) return i
    }
    return x < (list[0]?.left ?? 0) ? 0 : lastIndex
  }

  /** 拖拽过程中：按 tab 宽度换算 progress（源码 dragAmount.x / avgWidth） */
  const dragMove = (clientX: number): void => {
    const state = dragRef.current
    if (!state) return
    if (!state.moved) {
      if (Math.abs(clientX - state.startX) < 4) return
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
    velocityRef.current = instantVelocity
    setProgress(next)
    setStretch(Math.min(0.14, Math.abs(instantVelocity) * 0.08))
  }

  /** 松手：吸附到最近一格，弹簧归位，变了才切页 */
  const dragEnd = (): void => {
    const state = dragRef.current
    dragRef.current = null
    if (!state) return
    setDragging(false)
    const target = Math.max(0, Math.min(lastIndex, Math.round(progressRef.current)))
    runSpring(target)
    if (target !== activeIndex) activate(keys[target]!)
  }

  const dragCancel = (): void => {
    dragRef.current = null
    setDragging(false)
    runSpring(activeIndex)
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
    // 按下立刻吸到手指下那一格（源码 onDragStarted → updateValue(indexAt)）
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
    }
    velocityRef.current = 0
    progressRef.current = index
    targetRef.current = index
    setProgress(index)
    setStretch(0)
    setDragging(true)

    // 用 window 级监听而不是 pointer capture：
    // 捕获在鼠标移出元素时会被 Chromium 取消（pointercancel），进度会被打回起点。
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

  // 横向滚动
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

  // 玻璃轨道（液态玻璃材质，对应源码里的 textureBlur）
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

  // ---- 指示器几何：相邻 tab 之间插值 + 边缘阻尼 ----

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
    const fraction = progress - a
    const b = Math.min(lastIndex, a + 1)
    const ma = metrics[a]!
    const mb = metrics[b]!
    return {
      left: ma.left + (mb.left - ma.left) * fraction,
      width: ma.width + (mb.width - ma.width) * fraction
    }
  })()

  return (
    <nav className={styles.dock} aria-label="资料库导航" data-webgl={webgl ? '1' : '0'}>
      <div
        className={styles.bar}
        ref={barRef}
        role="tablist"
        aria-label="资料库分区"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
      >
        <div className={styles.track} ref={trackRef}>
          <div className={styles.strip}>
            <span
              className={styles.pill}
              style={{
                width: Math.max(0, raw.width - PILL_INSET * 2),
                transform: `translateX(${raw.left + PILL_INSET}px) translateY(-50%) scaleX(${1 + stretch}) scaleY(${1 - stretch * 0.25})`
              }}
              data-dragging={dragging ? 'true' : 'false'}
              aria-hidden="true"
            />
            {NAV.map((entry, index) => {
              const active = view.kind === entry.key || (entry.key === 'recent' && view.kind === 'album')
              const distance = Math.abs(progress - index)
              const proximity = Math.max(0, Math.min(1, 1 - distance))
              const near = distance < 0.45
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
                  style={{ color: `rgba(255, 255, 255, ${(0.6 + proximity * 0.4).toFixed(3)})` }}
                  onClick={() => {
                    if (progressRef.current !== index) runSpring(index)
                    activate(entry.key)
                  }}
                  title={entry.label}
                >
                  <span
                    className={styles.icon}
                    style={{ transform: `scale(${1 + proximity * 0.08})` }}
                  >
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
