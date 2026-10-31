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
 * 底部导航（液态玻璃主题）——形态对齐参考项目 Playground 的 Tab bar：
 *   一整条胶囊玻璃，图标/文字直接躺在上面；
 *   选中态 = 一颗**圆泡**（不是每格一颗水滴），停在选中格的圆心。
 *
 * 手感：
 *   按下 → 圆泡放大并鼓出胶囊边缘（Playground 里那个凸起的圆）
 *   拖动 → 圆泡跟手移动，沿运动方向拉长、垂直压扁（扭曲），松手前不切页
 *   松手 → 圆泡飞到目标格、缩回原尺寸，落定后才切页
 *   点击 → 同一段飞行轨迹：放大 → 移动 → 缩小归位
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

/** 圆泡直径（px）。比轨道矮一点，按下放大到 1.3 就会鼓出边缘。 */
const BUBBLE = 56

const activeKeyOf = (kind: string): string =>
  kind === 'settings' ? 'settings' : kind === 'album' ? 'recent' : kind === 'artist' ? 'artists' : kind

interface Bubble {
  /** 圆心在 strip 坐标系里的 x */
  x: number
  sx: number
  sy: number
  skew: number
}

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
  const stripRef = useRef<HTMLDivElement>(null)
  const bubbleRef = useRef<HTMLSpanElement>(null)
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    startCenter: number
    moved: boolean
    targetKey: string
  } | null>(null)

  const [bubble, setBubble] = useState<Bubble | null>(null)
  const [dragging, setDragging] = useState(false)
  const [pressed, setPressed] = useState(false)
  const [hoverKey, setHoverKey] = useState<string | null>(null)
  const [webgl, setWebgl] = useState(false)

  const keys: string[] = NAV.map((entry) => entry.key as string)
  const activeKey = activeKeyOf(view.kind)

  const activate = (key: string): void => {
    if (key === 'settings') {
      setView({ kind: 'settings' })
      return
    }
    setSearch('')
    setView({ kind: key } as never)
  }

  /** 某格中心在 strip 坐标系里的位置 */
  const centerOf = (key: string): number | null => {
    const tab = tabRefs.current.get(key)
    if (!tab) return null
    return tab.offsetLeft + tab.offsetWidth / 2
  }

  /** 指针落在哪一格 */
  const tabAt = (clientX: number): string => {
    const strip = stripRef.current
    if (!strip) return activeKey
    const x = clientX - strip.getBoundingClientRect().left
    let best = activeKey
    let bestDistance = Number.POSITIVE_INFINITY
    for (const key of keys) {
      const tab = tabRefs.current.get(key)
      if (!tab) continue
      const center = tab.offsetLeft + tab.offsetWidth / 2
      const distance = Math.abs(x - center)
      if (distance < bestDistance) {
        bestDistance = distance
        best = key
      }
    }
    return best
  }

  // 圆泡停在选中格圆心；窗口尺寸/字体变化时重新对齐
  useLayoutEffect(() => {
    if (dragRef.current) return
    const center = centerOf(activeKey)
    if (center !== null) setBubble({ x: center, sx: 1, sy: 1, skew: 0 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, view.kind])

  useEffect(() => {
    const bar = barRef.current
    if (!bar) return undefined
    const ro = new ResizeObserver(() => {
      if (dragRef.current) return
      const center = centerOf(activeKeyOf(useStore.getState().view.kind))
      if (center !== null) setBubble({ x: center, sx: 1, sy: 1, skew: 0 })
    })
    ro.observe(bar)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    const key = tabAt(event.clientX)
    const center = centerOf(key)
    if (center === null) return
    event.preventDefault()
    const host = barRef.current
    try {
      host?.setPointerCapture(event.pointerId)
    } catch {
      /* 合成指针无法捕获 */
    }
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startCenter: center,
      moved: false,
      targetKey: key
    }
    setPressed(true)
    setDragging(true)
    setHoverKey(key)
    // 按下即预览：圆泡鼓起来停在手指下，但页面还没切
    setBubble({ x: center, sx: 1.3, sy: 1.16, skew: 0 })
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const state = dragRef.current
    const strip = stripRef.current
    if (!state || !strip || event.pointerId !== state.pointerId) return
    const dx = event.clientX - state.startX
    if (!state.moved) {
      if (Math.hypot(dx, event.clientY - state.startY) < 4) return
      state.moved = true
    }
    const target = tabAt(event.clientX)
    state.targetKey = target
    setHoverKey(target)
    const rect = strip.getBoundingClientRect()
    const x = event.clientX - rect.left
    // 扭曲：沿拖动方向拉长、垂直压扁、带一点倾斜
    const stretch = Math.min(1.42, 1.2 + Math.abs(dx) / 200)
    const squash = Math.max(0.78, 1.12 - Math.abs(dx) / 500)
    const skew = Math.max(-12, Math.min(12, dx / 14))
    setBubble({ x, sx: stretch, sy: squash, skew })
  }

  const onPointerUp = async (event: ReactPointerEvent<HTMLDivElement>): Promise<void> => {
    const state = dragRef.current
    if (!state || event.pointerId !== state.pointerId) return
    dragRef.current = null
    const targetKey = state.targetKey
    const targetCenter = centerOf(targetKey)
    const from = bubble
    setPressed(false)
    setDragging(false)
    setHoverKey(null)

    // 点击与拖动都走同一条轨迹：放大 → 移动 → 缩回
    if (from && targetCenter !== null && bubbleRef.current) {
      const el = bubbleRef.current
      const anim = el.animate(
        [
          {
            transform: `translate(${from.x - BUBBLE / 2}px, -50%) scale(${from.sx}, ${from.sy}) skewX(${from.skew}deg)`,
            offset: 0
          },
          {
            transform: `translate(${(from.x + targetCenter) / 2 - BUBBLE / 2}px, -50%) scale(1.34, 1.26) skewX(0deg)`,
            offset: 0.45
          },
          {
            transform: `translate(${targetCenter - BUBBLE / 2}px, -50%) scale(1.12, 1.16) skewX(0deg)`,
            offset: 0.8
          },
          {
            transform: `translate(${targetCenter - BUBBLE / 2}px, -50%) scale(1, 1) skewX(0deg)`,
            offset: 1
          }
        ],
        {
          duration: state.moved ? 420 : 520,
          easing: 'cubic-bezier(0.2, 0.9, 0.25, 1)',
          // 不能 fill:forwards —— 悬留的最终帧会一直压住内联 transform，
          // 下一次按下就推不动圆泡了。动画结束由下面的 setBubble 接管最终位置。
          fill: 'none'
        }
      )
      await anim.finished.catch(() => undefined)
    }
    if (targetCenter !== null) setBubble({ x: targetCenter, sx: 1, sy: 1, skew: 0 })
    if (targetKey !== activeKey) activate(targetKey)
  }

  const onPointerCancel = (): void => {
    dragRef.current = null
    setDragging(false)
    setPressed(false)
    setHoverKey(null)
    const center = centerOf(activeKey)
    if (center !== null) setBubble({ x: center, sx: 1, sy: 1, skew: 0 })
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const last = keys.length - 1
    const current = Math.max(0, keys.indexOf(activeKey))
    let next: number | null = null
    if (event.key === 'ArrowLeft') next = Math.max(0, current - 1)
    else if (event.key === 'ArrowRight') next = Math.min(last, current + 1)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = last
    if (next === null) return
    event.preventDefault()
    activate(keys[next]!)
  }

  // 横向滑动
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
      tint: 0.42,
      tintTone: 'dark' as const,
      frost: 0.12,
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
        onPointerMove={onPointerMove}
        onPointerUp={(event) => void onPointerUp(event)}
        onPointerCancel={onPointerCancel}
      >
        <div className={styles.track} ref={trackRef}>
          <div className={styles.strip} ref={stripRef}>
            {bubble && (
              <span
                ref={bubbleRef}
                className={styles.bubble}
                data-pressed={pressed ? 'true' : 'false'}
                style={{
                  transform: `translate(${bubble.x - BUBBLE / 2}px, -50%) scale(${bubble.sx}, ${bubble.sy}) skewX(${bubble.skew}deg)`,
                  width: BUBBLE,
                  height: BUBBLE,
                  transition: dragging ? 'none' : undefined
                }}
                aria-hidden="true"
              />
            )}
            {NAV.map((entry) => {
              const active = view.kind === entry.key || (entry.key === 'recent' && view.kind === 'album')
              return (
                <button
                  key={entry.key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  data-nav={entry.key}
                  data-active={active}
                  data-hover={hoverKey === entry.key && !active ? 'true' : 'false'}
                  ref={(el) => {
                    if (el) tabRefs.current.set(entry.key, el)
                    else tabRefs.current.delete(entry.key)
                  }}
                  className={styles.tab}
                  onClick={(event) => {
                    if (event.detail === 0) activate(entry.key)
                  }}
                  title={entry.label}
                >
                  <Icon name={entry.icon} size={21} />
                  <span className={styles.label}>{entry.label}</span>
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
