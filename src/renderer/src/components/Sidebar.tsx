import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import { Icon, type IconName } from './Icon'
import { useStore } from '../state/store'
import { ProgressWidget } from './ProgressWidget'
import styles from './Sidebar.module.css'

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

export function Sidebar(): JSX.Element {
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const setSearch = useStore((s) => s.setSearch)
  const settings = useStore((s) => s.settings)
  const updateSettings = useStore((s) => s.updateSettings)
  const songs = useStore((s) => s.songs)
  const songIds = useStore((s) => s.songIds)
  const playRandom = useStore((s) => s.playRandom)
  const pushToast = useStore((s) => s.pushToast)

  const onRandom = (): void => {
    if (songIds.length === 0) {
      pushToast('曲库还是空的，先添加一些音乐吧')
      return
    }
    playRandom()
  }

  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const navRef = useRef<HTMLElement>(null)
  const [thumb, setThumb] = useState<{ top: number; height: number; show: boolean }>({
    top: 0,
    height: 36,
    show: false
  })
  const debounce = useRef<number | null>(null)

  // 高亮块在栏目之间平滑滑动：一次 transform 动画会依次经过「专辑」「艺人」，
  // 视觉上就是顺着列表滚过去，而不是硬切。
  useLayoutEffect(() => {
    const nav = navRef.current
    if (!nav) return
    const active = nav.querySelector<HTMLElement>('[data-active="true"]')
    if (!active) return
    setThumb({ top: active.offsetTop, height: active.offsetHeight, show: true })
  }, [view.kind, view, songs.length])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (debounce.current) window.clearTimeout(debounce.current)
    debounce.current = window.setTimeout(() => {
      // store.search 与输入框一致时是 no-op：挂载（含 StrictMode 双挂载）时两者同为空，
      // 不做这次守卫，setSearch('') 会把 init 恢复的详情页重置成最近添加。
      if (useStore.getState().search === query) return
      setSearch(query)
    }, 120)
    return () => {
      if (debounce.current) window.clearTimeout(debounce.current)
    }
  }, [query, setSearch])

  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = settings.sidebarWidth
    const target = event.currentTarget
    target.setPointerCapture(event.pointerId)
    const onMove = (move: PointerEvent): void => {
      const width = Math.max(200, Math.min(320, startWidth + move.clientX - startX))
      document.documentElement.style.setProperty('--sidebar-w', `${width}px`)
    }
    const onUp = (): void => {
      const width = Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w')
      )
      target.releasePointerCapture(event.pointerId)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      void updateSettings({ sidebarWidth: Math.round(width) })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <aside className={`glass glassLite ${styles.sidebar}`} style={{ width: 'var(--sidebar-w)' }}>
      <div className={styles.searchWrap}>
        <Icon name="search" size={15} className={styles.searchIcon} />
        <input
          ref={inputRef}
          className={styles.search}
          placeholder="搜索"
          value={query}
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setQuery('')
              inputRef.current?.blur()
            }
          }}
        />
      </div>

      <div className={styles.groupTitle}>资料库</div>
      <nav className={styles.nav} ref={navRef}>
        {thumb.show && (
          <span
            className={styles.thumb}
            style={{ transform: `translateY(${thumb.top}px)`, height: thumb.height }}
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
              className={`${styles.item} ${active ? styles.activeItem : ''}`}
              onClick={() => {
                setQuery('')
                setView({ kind: entry.key } as never)
              }}
            >
              <Icon name={entry.icon} size={20} />
              <span>{entry.label}</span>
            </button>
          )
        })}
      </nav>

      {/* 随机推荐：一次点击 = 随机挑一首歌播放 + 落到全屏歌词页（含下一首歌词信息）。
          它是动作不是页面，所以放在主导航之外。 */}
      <button type="button" className={styles.randomButton} onClick={onRandom} title="随机挑一首歌播放">
        <Icon name="sparkles" size={18} />
        <span>随机推荐</span>
      </button>

      <div className={styles.spacer} />
      <ProgressWidget count={Object.keys(songs).length} />

      <div className={styles.footer}>
        <button
          type="button"
          data-nav="settings"
          className={styles.footerButton}
          onClick={() => setView({ kind: 'settings' })}
        >
          <Icon name="gear" size={18} />
          <span>设置</span>
        </button>
      </div>

      <div className={styles.divider} aria-hidden="true" />
      <div className={styles.resizeHandle} onPointerDown={startResize} />
    </aside>
  )
}
