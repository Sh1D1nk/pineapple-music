import { memo, useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import { useStore } from './state/store'
import { useTrayBridge } from './hooks/useTrayBridge'
import { useNetMusicBridge } from './hooks/useNetMusicBridge'
import { NetMusicView } from './views/NetMusicView'
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
import { GlassLab } from './views/GlassLab'
import { EmptyState } from './views/EmptyState'
import { startAutoMixScheduler } from './audio/automix'
import { withViewTransition } from './lib/transition'
import { bridge } from './bridge'
import { useGlass } from './glass/GlassProvider'
import styles from './components/views.module.css'
import overlayStyles from './components/overlays.module.css'
import { ProgressWidget } from './components/ProgressWidget'
import { FloatBar } from './components/FloatBar'
import { PerfHud } from './perf/PerfHud'
import { PerfGovernor } from './perf/Governor'
import { finishPaint, hudEnabled, onHudChange, phase, setHud } from './perf/core'
import { PERF_LEGACY, PERF_NO_KEEPALIVE } from './perf/flags'
import type { View } from './state/store'

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
      } else if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'p') {
        event.preventDefault()
        setHud(!hudEnabled())
      } else if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'g') {
        event.preventDefault()
        state.setView({ kind: 'glasslab' })
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

/** 页面内容本体。切页时不再重建它 —— 见 ViewHost 的保活缓存。 */
function renderView(view: View): JSX.Element {
  if (view.kind === 'netmusic') return <div />
  if (view.kind === 'settings') return <SettingsView />
  if (view.kind === 'lab') return <TransitionLab />
  if (view.kind === 'glasslab') return <GlassLab />
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

/**
 * 保活页面本体。memo 是关键：切页时父组件重渲染，隐藏页面不该跟着重建元素树
 * （艺人页 300 行、专辑页十几个卡片，每次切页都重算就是几十毫秒的提交）。
 */
const Pane = memo(function Pane({ view }: { view: View }): JSX.Element {
  const songCount = useStore((s) => s.songIds.length)
  const exempt = view.kind === 'settings' || view.kind === 'lab' || view.kind === 'glasslab' || view.kind === 'netmusic'
  if (songCount === 0 && !exempt) return <EmptyState />
  return renderView(view)
})

const MAX_KEPT_VIEWS = 8

/**
 * 页面保活宿主。
 *
 * 之前是 `key={viewKey}` 一次性重建整棵视图树：切回列表要重新挂载几百张卡片、
 * 重新发起封面请求、重新分组曲库——这就是「切回来总要先白一下」的来源。
 * 现在每个访问过的页面各留一份 DOM，切走的 display:none，切回即出；
 * 入场动画仍用同一组关键帧（38px + opacity + 同一条贝塞尔）通过 WAAPI 重放，
 * 观感与原来的 .viewSwap 完全一致，但不再重建组件。
 */
function ViewHost(): JSX.Element {
  useTrayBridge()
  useNetMusicBridge()
  useEffect(() => {
    // 插件点「在 Pinnet 里播放」→ 主进程转发过来
    return window.lm.on('navigate', ((view: { kind: string }) => {
      if (view?.kind === 'netmusic') {
        useStore.getState().setView(view as never)
        useStore.getState().setFullscreen(true)
      } else if (view?.kind) {
        useStore.getState().setView(view as never)
      }
    }) as never)
  }, [])
  const view = useStore((s) => s.view)
  const navDirection = useStore((s) => s.navDirection)
  const key = JSON.stringify(view)
  const [entries, setEntries] = useState<{ key: string; view: View }[]>(() => [{ key, view }])

  // 渲染期派生：新页面加入缓存，超过上限时淘汰最久未用（绝不淘汰当前页）
  if (!entries.some((entry) => entry.key === key)) {
    const next = [...entries, { key, view }]
    while (next.length > MAX_KEPT_VIEWS) {
      const victim = next.findIndex((entry) => entry.key !== key)
      if (victim < 0) break
      next.splice(victim, 1)
    }
    setEntries(next)
  }

  useLayoutEffect(() => {
    phase('commit')
    const el = document.querySelector(`[data-view-key="${CSS.escape(key)}"]`) as HTMLElement | null
    const root = document.documentElement
    // 原生 View Transition 自己负责切页动画；主导航才重放 .viewSwap 的关键帧
    if (el && navDirection !== 'none' && !root.dataset.vt) {
      const dx = navDirection === 'left' ? 38 : -38
      el.animate(
        [
          { opacity: 0, transform: `translate3d(${dx}px, 0, 0)` },
          { opacity: 1, transform: 'none' }
        ],
        { duration: 440, easing: 'cubic-bezier(0.32, 0.72, 0, 1)', fill: 'both' }
      )
    }
    let inner = 0
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => finishPaint())
    })
    return () => {
      cancelAnimationFrame(outer)
      cancelAnimationFrame(inner)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  // A/B 对照：legacy 模式回到「每次切页整棵重建」，基线数字用它测
  if (PERF_LEGACY || PERF_NO_KEEPALIVE) {
    return (
      <div key={key} className="viewPane viewPaneActive">
        <Pane view={view} />
      </div>
    )
  }

  return (
    <>
      {entries.map((entry) => {
        const active = entry.key === key
        return (
          <div
            key={entry.key}
            data-view-key={entry.key}
            className={active ? 'viewPane viewPaneActive' : 'viewPane viewPaneHidden'}
            aria-hidden={!active}
            inert={!active}
          >
            <Pane view={entry.view} />
          </div>
        )
      })}
    </>
  )
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
  const [hud, setHudVisible] = useState(hudEnabled())

  useEffect(() => onHudChange(setHudVisible), [])

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
      <PerfGovernor />
      <div className="app" data-control-bar={settings.controlBar} data-perf-mode={settings.performanceMode}>
        <div className={`contentLayer ${settings.controlBar !== 'top' ? 'withBottomBar' : ''}`}>
          <div className="scrollEdgeTop" />
          <div id="contentScroll" className={`contentScroll ${queueOpen ? 'withQueue' : ''}`}>
            <div className="viewPaneStack" data-nav-dir={navDirection}>
              <ViewHost />
            </div>
          </div>
        </div>

        <div className="floatLayer">
          {settings.theme === 'liquid' ? <BottomBar /> : <Sidebar />}
          {settings.controlBar === 'float' ? (
            <FloatBar />
          ) : (
            <TopBar variant={settings.controlBar === 'bottom' ? 'bottom' : 'top'} />
          )}
          <QueuePanel />
          <LyricsPanel />
          <CoverFlow
            open={coverFlowOpen}
            onClose={() => setCoverFlowOpen(false)}
          />
        </div>

        {/* 预热 GPU：全屏磨砂遮罩（歌曲信息/右键菜单）首次出现时要编译 blur 着色器，
            集显上第一次能慢 400ms+。常驻一块 4×4 的微缩磨砂，启动即编译。 */}
        <div className="blurWarm" aria-hidden="true" />

        <div className="overlayLayer">
          <FullscreenPlayer />
          <LyricsSettingsDialog />
          <LyricsMenu />
          <SongInfoDialog />
          <ContextMenu />
          <Toasts />
          <GlassNotice />
          <PerfHud active={hud} />
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
