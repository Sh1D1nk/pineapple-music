import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import { useStore } from './state/store'
import { GlassProvider } from './glass/GlassProvider'
import { Sidebar } from './components/Sidebar'
import { BottomBar } from './components/BottomBar'
import { TopBar } from './components/TopBar'
import { QueuePanel } from './components/QueuePanel'
import { LyricsPanel } from './components/LyricsPanel'
import { CoverFlow } from './components/CoverFlow'
import { FullscreenPlayer } from './components/FullscreenPlayer'
import { LyricsMenu } from './components/LyricsMenu'
import { LyricsSettingsDialog } from './components/LyricsSettingsDialog'
import { SongInfoDialog } from './components/SongInfoDialog'
import { ContextMenu } from './components/ContextMenu'
import { Icon } from './components/Icon'
import { SongsView } from './views/SongsView'
import { AlbumsView } from './views/AlbumsView'
import { AlbumDetail } from './views/AlbumDetail'
import { ArtistsView, ArtistDetail } from './views/ArtistsView'
import { FavoritesView } from './views/FavoritesView'
import { SearchView } from './views/SearchView'
import { SettingsView } from './views/SettingsView'
import { TransitionLab } from './views/TransitionLab'
import { EmptyState } from './views/EmptyState'
import { startAutoMixScheduler } from './audio/automix'
import { withViewTransition } from './lib/transition'
import { bridge } from './bridge'
import { useGlass } from './glass/GlassProvider'
import styles from './components/views.module.css'
import overlayStyles from './components/overlays.module.css'
import { ProgressWidget } from './components/ProgressWidget'

function useTheme(): void {
  const settings = useStore((s) => s.settings)
  useEffect(() => {
    const root = document.documentElement
    const liquid = settings.theme === 'liquid'
    const apply = (): void => {
      const dark =
        settings.theme === 'dark' ||
        liquid ||
        (settings.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
      root.dataset.theme = dark ? 'dark' : 'light'
      // 液态玻璃主题：内容底色沿用深色令牌，另挂 skin/nav 两个标记给底栏与留白用
      if (liquid) {
        root.dataset.skin = 'liquid'
        root.dataset.nav = 'bottom'
      } else {
        delete root.dataset.skin
        delete root.dataset.nav
      }
    }
    apply()
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [settings.theme])
}

function useShortcuts(): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      const typing =
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')
      const state = useStore.getState()

      if (event.key === 'Escape') {
        if (state.coverFlowOpen) state.setCoverFlowOpen(false)
        else if (state.infoSongId) state.setInfoSongId(null)
        else if (state.contextMenu) state.setContextMenu(null)
        // 歌词页内的浮层优先于整页：先收菜单，再收设置窗，最后才退出歌词页
        else if (state.lyricsMenu) state.setLyricsMenu(null)
        else if (state.lyricsSettingsOpen) state.setLyricsSettingsOpen(false)
        else if (state.fullscreen) state.setFullscreen(false)
        else if (state.queueOpen) state.setQueueOpen(false)
        else if (state.lyricsOpen) state.setLyricsOpen(false)
        // 详情页（专辑/艺人）按 Esc 也回上一层
        else if (state.view.kind === 'album' || state.view.kind === 'artist') withViewTransition(() => state.goBack())
        return
      }
      if (typing) return

      if (event.code === 'Space') {
        event.preventDefault()
        state.togglePlay()
        return
      }
      if (event.ctrlKey && event.key === 'ArrowRight') {
        event.preventDefault()
        state.next()
      } else if (event.ctrlKey && event.key === 'ArrowLeft') {
        event.preventDefault()
        state.prev()
      } else if (event.ctrlKey && event.key === 'ArrowUp') {
        event.preventDefault()
        state.setVolume(Math.min(1, state.playback.volume + 0.05))
      } else if (event.ctrlKey && event.key === 'ArrowDown') {
        event.preventDefault()
        state.setVolume(Math.max(0, state.playback.volume - 0.05))
      } else if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        state.setCoverFlowOpen(!state.coverFlowOpen)
      } else if (event.ctrlKey && event.altKey && event.key.toLowerCase() === 'l') {
        // 插件原快捷键：Ctrl+Alt+L 开关歌词页（宿主可能占用了 Ctrl+L，所以两个都留）
        event.preventDefault()
        state.setFullscreen(!state.fullscreen)
      } else if (event.ctrlKey && event.key.toLowerCase() === 'l') {
        event.preventDefault()
        state.setLyricsOpen(!state.lyricsOpen)
      } else if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'l') {
        event.preventDefault()
        state.setView({ kind: 'lab' })
      } else if (event.key === 'F11') {
        event.preventDefault()
        void bridge.setFullScreen(!state.fullscreen)
        state.setFullscreen(!state.fullscreen)
      }
    }
    // 鼠标侧键：Chromium 把后退/前进映射成 button 3 / 4，拦下默认行为交给应用自己处理
    const onMouse = (event: MouseEvent): void => {
      if (event.button === 3) {
        event.preventDefault()
        withViewTransition(() => useStore.getState().goBack())
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mouseup', onMouse)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mouseup', onMouse)
    }
  }, [])
}

function useDropTarget(): boolean {
  const setDragActive = useStore((s) => s.setDragActive)
  const dragActive = useStore((s) => s.dragActive)
  useEffect(() => {
    let depth = 0
    const onEnter = (event: DragEvent): void => {
      if (!event.dataTransfer?.types.includes('Files')) return
      depth++
      setDragActive(true)
    }
    const onLeave = (): void => {
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragActive(false)
    }
    const onOver = (event: DragEvent): void => {
      event.preventDefault()
    }
    const onDrop = (): void => {
      depth = 0
      setDragActive(false)
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('dragover', onOver)
    window.addEventListener('drop', onDrop)
    return (): void => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('drop', onDrop)
      setDragActive(false)
      
    }
  }, [setDragActive])
  return dragActive
}

/** 主导航切换时的方向类：向上切（歌曲→最近添加）内容向上滚，反之向下。 */
function navClass(direction: 'left' | 'right' | 'none'): string {
  return direction === 'left' ? 'viewSwapLeft' : direction === 'right' ? 'viewSwapRight' : ''
}

function Pages(): JSX.Element {
  const view = useStore((s) => s.view)
  const songCount = useStore((s) => s.songIds.length)

  if (view.kind === 'settings') return <SettingsView />
  if (view.kind === 'lab') return <TransitionLab />
  if (songCount === 0) return <EmptyState />
  switch (view.kind) {
    case 'songs':
      return <SongsView />
    case 'albums':
      return <AlbumsView title="专辑" mode="albums" />
    case 'artists':
      return <ArtistsView />
    case 'favorites':
      return <FavoritesView />
    case 'album':
      return <AlbumDetail albumKey={view.key} />
    case 'artist':
      return <ArtistDetail name={view.name} />
    case 'search':
      return <SearchView />
    case 'recent':
    default:
      return <AlbumsView title="最近添加" mode="recent" />
  }
}

function Toasts(): JSX.Element {
  const toasts = useStore((s) => s.toasts)
  return (
    <div className={overlayStyles.toasts}>
      {toasts.map((toast) => (
        <div key={toast.id} className={overlayStyles.toast}>
          {toast.text}
        </div>
      ))}
    </div>
  )
}

function GlassNotice(): JSX.Element | null {
  const glass = useGlass()
  useEffect(() => {
    if (!glass.notice) return
    const timer = window.setTimeout(() => glass.dismissNotice(), 5000)
    return () => window.clearTimeout(timer)
  }, [glass])
  if (!glass.notice) return null
  return (
    <div className={overlayStyles.toasts} style={{ bottom: 76 }}>
      <div className={overlayStyles.toast}>{glass.notice}</div>
    </div>
  )
}

export function App(): JSX.Element {
  const settings = useStore((s) => s.settings)
  const view = useStore((s) => s.view)
  const navDirection = useStore((s) => s.navDirection)
  const coverFlowOpen = useStore((s) => s.coverFlowOpen)
  const setCoverFlowOpen = useStore((s) => s.setCoverFlowOpen)
  const viewKey = JSON.stringify(view)
  const ready = useStore((s) => s.ready)
  const init = useStore((s) => s.init)
  const queueOpen = useStore((s) => s.queueOpen)
  const sidebarWidth = settings.sidebarWidth
  const dragActive = useDropTarget()
  const [kicked, setKicked] = useState(false)

  useTheme()
  useShortcuts()

  useEffect(() => {
    void init().then(() => setKicked(true))
  }, [init])

  useEffect(() => {
    if (!kicked) return
    const stop = startAutoMixScheduler()
    return stop
  }, [kicked])

  useEffect(() => {
    document.documentElement.style.setProperty('--sidebar-w', `${sidebarWidth}px`)
  }, [sidebarWidth])

  // 每个视图记住自己的滚动位置：从专辑详情退回列表要落回原处，
  // 正向切到新页面才归零（否则详情页的 hero 会被上一页的滚动位置切掉一半）。
  // 用 layout effect 在绘制前写入，避免「先画在顶部再跳回去」的二次闪动。
  const scrollMemory = useRef(new Map<string, number>())
  const viewKeyRef = useRef(viewKey)
  viewKeyRef.current = viewKey
  const lastView = useRef<{ key: string; kind: string }>({ key: viewKey, kind: view.kind })
  // 滚动位置必须「边滚边记」：视图切换的 layout effect 是在新页面已经换上之后才跑的，
  // 那时读到的 scrollTop 已经被新页面夹成 0，记下来的是错的。
  useEffect(() => {
    const el = document.getElementById('contentScroll')
    if (!el) return undefined
    // 顶部渐隐遮罩只在内容真的滚到玻璃条下方时出现：它常驻的话，
    // 就是横在所有页面顶部的那条「渐变小横条」。直接改 classList 绕过 React ——
    // 滚动每秒几十次，不值得为它重渲染整棵树。
    const edge = document.querySelector('.scrollEdgeTop')
    const onScroll = (): void => {
      scrollMemory.current.set(viewKeyRef.current, el.scrollTop)
      edge?.classList.toggle('scrollEdgeVisible', el.scrollTop > 4)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])
  useLayoutEffect(() => {
    const el = document.getElementById('contentScroll')
    if (!el) return
    const prev = lastView.current
    if (prev.key === viewKey) return
    // 切页动画期间给玻璃降压：backdrop-filter 的实时重采样是翻页掉帧的主因
    // （实测 20fps → 100+fps）。动画只有 ~420ms，结束立刻恢复真实玻璃。
    const root = document.documentElement
    root.dataset.fx = 'cheap'
    const fxTimer = window.setTimeout(() => {
      delete root.dataset.fx
    }, 420)
    const fromDetail = prev.kind === 'album' || prev.kind === 'artist'
    if (fromDetail) {
      el.scrollTop = scrollMemory.current.get(viewKey) ?? 0
    } else {
      // 正向进入新页面：从顶部开始，并丢掉上一次残留的位置
      scrollMemory.current.delete(viewKey)
      el.scrollTop = 0
    }
    // 换页后按新位置同步遮罩可见性（回到底部的页面不该留着渐隐条）
    document.querySelector('.scrollEdgeTop')?.classList.toggle('scrollEdgeVisible', el.scrollTop > 4)
    lastView.current = { key: viewKey, kind: view.kind }
    return () => {
      window.clearTimeout(fxTimer)
      // effect 重跑时先清掉再重设，避免属性残留把玻璃永久降级
      delete root.dataset.fx
    }
  }, [viewKey, view.kind])

  return (
    <GlassProvider mode={settings.glass}>
      <div className="app">
        <div className="contentLayer">
          <div className="scrollEdgeTop" />
          <div id="contentScroll" className={`contentScroll ${queueOpen ? 'withQueue' : ''}`}>
            <div key={viewKey} className={`viewSwap ${navClass(navDirection)}`} data-nav-dir={navDirection}>
              <Pages />
            </div>
          </div>
        </div>

        <div className="floatLayer">
          {settings.theme === 'liquid' ? <BottomBar /> : <Sidebar />}
          <TopBar />
          <QueuePanel />
          <LyricsPanel />
          <CoverFlow
            open={coverFlowOpen}
            onClose={() => setCoverFlowOpen(false)}
          />
        </div>

        <div className="overlayLayer">
          <FullscreenPlayer />
          <LyricsSettingsDialog />
          <LyricsMenu />
          <SongInfoDialog />
          <ContextMenu />
          <Toasts />
          <GlassNotice />
        </div>

        {dragActive && (
          <div className={styles.dropOverlay}>
            <Icon name="folderPlus" size={34} />
            松开以导入音乐
          </div>
        )}

        {!ready && (
          <div className={overlayStyles.scrim} style={{ backdropFilter: 'none' }}>
            <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>正在载入资料库…</div>
          </div>
        )}
      </div>
    </GlassProvider>
  )
}
