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
 * 底部导航（液态玻璃主题专用）。
 *
 * 交互照参考实现的 LiquidGlassNavbar 做，不是「点一下换个底色」：
 *   按下      → 透镜立刻胀大并滑到手指下那一格（还没松手，选中还没变）
 *   拖动      → 位移超过 4px 才算拖，之后透镜跟手连续移动，可以停在两格之间
 *   松手      → 吸附到最近一格，这时才真正切页；按已选中的格子是原地开花 + 无操作
 *   取消      → pointercancel 撤回按下前的选中
 *   键盘      → ←/→ 上一项/下一项，Home/End 首尾，直接生效
 *
 * 玻璃是 WebGL2 画的（LiquidGlass 只画玻璃、不接管 DOM），没有 WebGL2 时退回 CSS 玻璃。
 */

const NAV: {
  key: 'recent' | 'artists' | 'albums' | 'songs' | 'favorites'
  label: string
  icon: IconName
}[] = [
  { key: 'recent', label: '最近添加', icon: 'clock' },
  { key: 'artists', label: '艺人', icon: 'mic' },
  { key: 'albums', label: '专辑', icon: 'disc' },
  { key: 'songs', label: '歌曲', icon: 'music' },
  { key: 'favorites', label: '收藏', icon: 'star' }
]

/** 参考实现的材质取向：体折射为主、边缘带一点色散，rim/highlight 给足，光从左上打（136°）。 */
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

const activeKeyOf = (kind: string): string =>
  kind === 'settings' ? 'settings' : kind === 'album' ? 'recent' : kind === 'artist' ? 'artists' : kind

interface Metric {
  key: string
  left: number
  width: number
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
  const itemRefs = useRef(new Map<string, HTMLButtonElement>())
  const metricsRef = useRef<Metric[]>([])
  const dragRef = useRef<{
    pointerId: number
    x0: number
    y0: number
    startIndex: number
    moved: boolean
    width: number
  } | null>(null)

  const [lens, setLens] = useState<{ left: number; width: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [pressed, setPressed] = useState(false)
  const [webgl, setWebgl] = useState(false)

  const keys: string[] = [...NAV.map((entry) => entry.key as string), 'settings']
  const activeKey = activeKeyOf(view.kind)
  const activeIndex = Math.max(0, keys.indexOf(activeKey))

  const activate = (key: string): void => {
    if (key === 'settings') {
      setView({ kind: 'settings' })
      return
    }
    setSearch('')
    setView({ kind: key } as never)
  }

  /** 读真实布局：窗口缩放、字号变化、标签变化都不会让透镜错位 */
  const measure = (): Metric[] => {
    const list: Metric[] = []
    for (const key of keys) {
      const el = itemRefs.current.get(key)
      if (el) list.push({ key, left: el.offsetLeft, width: el.offsetWidth })
    }
    metricsRef.current = list
    return list
  }

  useLayoutEffect(() => {
    const list = measure()
    const hit = list.find((m) => m.key === activeKey) ?? list[0]
    if (hit) setLens({ left: hit.left, width: hit.width })
    // keys 由常量派生，长度固定
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, view.kind])

  useEffect(() => {
    const bar = barRef.current
    if (!bar) return undefined
    const ro = new ResizeObserver(() => {
      const list = measure()
      const hit = list.find((m) => m.key === activeKeyOf(useStore.getState().view.kind)) ?? list[0]
      if (hit) setLens({ left: hit.left, width: hit.width })
    })
    ro.observe(bar)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- 指针：按下预览 / 拖动跟手 / 松手吸附 ---------------------------------

  const indexAt = (clientX: number): number => {
    const bar = barRef.current
    const list = metricsRef.current
    if (!bar || list.length === 0) return 0
    const x = clientX - bar.getBoundingClientRect().left
    let best = 0
    let bestDistance = Number.POSITIVE_INFINITY
    list.forEach((metric, index) => {
      const distance = Math.abs(x - (metric.left + metric.width / 2))
      if (distance < bestDistance) {
        bestDistance = distance
        best = index
      }
    })
    return best
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    const bar = barRef.current
    if (!bar) return
    // 自己接管整个手势：阻止文本选择与后续兼容 click，避免与 click 逻辑双触发
    event.preventDefault()
    try {
      bar.setPointerCapture(event.pointerId)
    } catch {
      /* 合成的 pointer 无法捕获 */
    }
    // 和参考实现一样：按过之后焦点落在轨道上，方向键立刻可用
    bar.focus({ preventScroll: true })
    const index = indexAt(event.clientX)
    const metric = metricsRef.current[index]
    if (!metric) return
    dragRef.current = {
      pointerId: event.pointerId,
      x0: event.clientX,
      y0: event.clientY,
      startIndex: activeIndex,
      moved: false,
      width: metric.width
    }
    setPressed(true)
    setDragging(true)
    // 按下即预览：透镜先胀着滑到手指下（此时还没切页）
    setLens({ left: metric.left, width: metric.width })
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const state = dragRef.current
    const bar = barRef.current
    if (!state || !bar || event.pointerId !== state.pointerId) return
    if (!state.moved) {
      // 4px 以内算点击，不算拖动（否则轻按一抖就跑偏）
      if (Math.hypot(event.clientX - state.x0, event.clientY - state.y0) < 4) return
      state.moved = true
    }
    const rect = bar.getBoundingClientRect()
    const raw = event.clientX - rect.left - state.width / 2
    const max = bar.clientWidth - 6 - state.width
    setLens({ left: Math.max(6, Math.min(max, raw)), width: state.width })
  }

  const finishGesture = (event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean): void => {
    const state = dragRef.current
    if (!state || event.pointerId !== state.pointerId) return
    dragRef.current = null
    setDragging(false)
    setPressed(false)
    const list = metricsRef.current
    const targetIndex = cancelled ? state.startIndex : indexAt(event.clientX)
    const target = list[targetIndex] ?? list[activeIndex]
    if (target) setLens({ left: target.left, width: target.width })
    // 取消 → 回原项；点已选中 → 原地开花后无操作；否则切页
    if (cancelled) return
    if (target?.key === activeKey && !state.moved) return
    if (target) activate(target.key)
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => finishGesture(event, false)
  const onPointerCancel = (event: ReactPointerEvent<HTMLDivElement>): void => finishGesture(event, true)

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const last = keys.length - 1
    let next: number | null = null
    if (event.key === 'ArrowLeft') next = Math.max(0, activeIndex - 1)
    else if (event.key === 'ArrowRight') next = Math.min(last, activeIndex + 1)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = last
    if (next === null) return
    event.preventDefault()
    activate(keys[next]!)
  }

  // ---- 玻璃 -----------------------------------------------------------------

  useEffect(() => {
    const bar = barRef.current
    const random = randomRef.current
    if (!bar) return undefined
    const instances: { destroy: () => void; refresh?: () => void }[] = []
    const options = {
      backdrop: 'auto' as const,
      // 白字压在玻璃上：tint 保证可读，frost 只留一点点——
      // 模糊给多了就把折射糊成磨砂，底边那圈弯曲的内容才是液态玻璃的签名
      tint: 0.45,
      tintTone: 'dark' as const,
      frost: 0.12,
      maxDpr: 1.5,
      // 滚动时不逐帧重绘 DOM 背景（那是纯 CPU 的 paint），停手 160ms 后补一帧
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
      // 没有 WebGL2（或上下文创建失败）：保持 CSS 玻璃，功能不受影响
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
      <div
        className={styles.bar}
        ref={barRef}
        role="tablist"
        aria-label="资料库分区"
        tabIndex={-1}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onKeyDown={onKeyDown}
      >
        {lens && (
          <span
            className={styles.lens}
            data-pressed={pressed ? 'true' : 'false'}
            style={{
              transform: `translateX(${lens.left}px)${pressed ? ' scale(1.08, 1.16)' : ''}`,
              width: lens.width,
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
              ref={(el) => {
                if (el) itemRefs.current.set(entry.key, el)
                else itemRefs.current.delete(entry.key)
              }}
              className={styles.item}
              // 鼠标手势由容器的 pointer 逻辑处理；这里只接键盘触发的 click（detail === 0）
              onClick={(event) => {
                if (event.detail === 0) activate(entry.key)
              }}
              title={entry.label}
            >
              <Icon name={entry.icon} size={22} />
              <span className={styles.label}>{entry.label}</span>
            </button>
          )
        })}

        <span className={styles.separator} aria-hidden="true" />

        <button
          type="button"
          role="tab"
          aria-selected={view.kind === 'settings'}
          data-nav="settings"
          data-active={view.kind === 'settings'}
          ref={(el) => {
            if (el) itemRefs.current.set('settings', el)
            else itemRefs.current.delete('settings')
          }}
          className={styles.item}
          onClick={(event) => {
            if (event.detail === 0) activate('settings')
          }}
          title="设置"
        >
          <Icon name="gear" size={21} />
          <span className={styles.label}>设置</span>
        </button>
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
