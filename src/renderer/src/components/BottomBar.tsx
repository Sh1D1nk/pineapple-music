import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import { LiquidGlass } from 'apple-liquid-glass-webgl'
import { Icon, type IconName } from './Icon'
import { useStore } from '../state/store'
import styles from './BottomBar.module.css'

/**
 * 底部导航（液态玻璃主题专用）。
 *
 * 结构照抄参考实现（webgl-apple-liquid-glass 的 playground / LiquidGlassNavbar）：
 *   整条是「一块玻璃轨道（track）」，选中项是**一块会在轨道上滑动的玻璃透镜（lens）**，
 *   而不是每个 Tab 各挂一块玻璃。点击仍由真实的 DOM 按钮接收（键盘、aria 不变），
 *   shader 只负责把身后的页面折射进这块玻璃。
 *
 * 玻璃由 WebGL2 绘制（squircle SDF 厚度场 → Snell 折射 → 弯月边缘 → 色散 → 菲涅尔），
 * DOM 内容保持在玻璃之上；没有 WebGL2 时自动退回 CSS 玻璃（data-webgl='0'）。
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
  const [lens, setLens] = useState<{ left: number; width: number } | null>(null)
  const [webgl, setWebgl] = useState(false)

  const activeKey = activeKeyOf(view.kind)

  // 透镜跟随选中项：读真实布局而不是自己算尺寸，窗口缩放/字号变化都不会错位
  useLayoutEffect(() => {
    const bar = barRef.current
    const el = itemRefs.current.get(activeKey)
    if (!bar || !el) return
    setLens({ left: el.offsetLeft, width: el.offsetWidth })
  }, [activeKey, view.kind])

  useEffect(() => {
    const bar = barRef.current
    if (!bar) return undefined
    const ro = new ResizeObserver(() => {
      const el = itemRefs.current.get(activeKeyOf(useStore.getState().view.kind))
      if (el) setLens({ left: el.offsetLeft, width: el.offsetWidth })
    })
    ro.observe(bar)
    return () => ro.disconnect()
  }, [])

  // 玻璃本身：LiquidGlass 只画玻璃、不接管 DOM；卸载时销毁并释放 WebGL 上下文
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
      // 2 倍分辨率在这个尺寸上是纯浪费：玻璃只有 64px 高，1.5 倍肉眼无差，像素填充少一半
      maxDpr: 1.5,
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
      instances.push(new LiquidGlass(bar, options) as { destroy: () => void; refresh: () => void })
      if (random) {
        instances.push(new LiquidGlass(random, { ...options, tint: 0.2 }) as { destroy: () => void; refresh: () => void })
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
      <div className={styles.bar} ref={barRef}>
        {lens && (
          <span
            className={styles.lens}
            style={{ transform: `translateX(${lens.left}px)`, width: lens.width }}
            aria-hidden="true"
          />
        )}
        {NAV.map((entry) => {
          const active = view.kind === entry.key || (entry.key === 'recent' && view.kind === 'album')
          return (
            <button
              key={entry.key}
              type="button"
              data-nav={entry.key}
              data-active={active}
              ref={(el) => {
                if (el) itemRefs.current.set(entry.key, el)
                else itemRefs.current.delete(entry.key)
              }}
              className={styles.item}
              onClick={() => {
                setSearch('')
                setView({ kind: entry.key } as never)
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
          data-nav="settings"
          data-active={view.kind === 'settings'}
          ref={(el) => {
            if (el) itemRefs.current.set('settings', el)
            else itemRefs.current.delete('settings')
          }}
          className={styles.item}
          onClick={() => setView({ kind: 'settings' })}
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
