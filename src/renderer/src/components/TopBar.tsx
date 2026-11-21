import { createContext, useCallback, useContext, useRef, useState, type JSX } from 'react'
import type { SongMeta } from '@shared/types'
import { Icon } from './Icon'
import { Cover } from './Cover'
import { useStore } from '../state/store'
import { coverUrl } from '../bridge'
import { albumKeyOf } from '../lib/group'
import { useAutoMix } from '../audio/automix'
import { formatRemaining, formatTime } from '../lib/format'
import styles from './TopBar.module.css'

/**
 * 控制目标：默认是 Pinnet 本地播放；在「网络音乐」页且插件已连接时切到汽水音乐。
 * 所有子组件都通过这个 hook 取状态和动作，避免每个按钮各写一套分支。
 */
const RemoteContext = createContext(false)

/**
 * 控制栏的本地/远端统一入口。
 *
 * 性能要点：`playback.position` 每 100ms 更新一次（10Hz）。若这里订阅整个 `playback`
 * 对象，TransportGroup / VolumeGroup / PanelGroup 等只含按钮的组件也会跟着每秒重渲染 10 次。
 * 因此全部改成标量订阅，并用 `withProgress` 把进度/时长两条高频订阅「关掉」：
 * selector 在不需要进度时恒返回 0，Zustand 用 Object.is 判定相等 → 不触发重渲染。
 * 只有真正显示进度条与时间的 NowPlayingPill / DockTransport 传 withProgress=true。
 */
function useTarget(withProgress = false): {
  isRemote: boolean
  playing: boolean
  position: number
  duration: number
  volume: number
  muted: boolean
  hasTrack: boolean
  toggle: () => void
  next: () => void
  prev: () => void
  seek: (sec: number) => void
  setVolume: (v: number) => void
  toggleMute: () => void
} {
  const remoteFlag = useContext(RemoteContext)
  const connected = useStore((s) => s.netStatus.connected)
  const net = useStore((s) => s.netMusic)
  // 标量订阅：各字段独立，只有真正变化的字段才唤醒本组件
  const pbPlaying = useStore((s) => s.playback.playing)
  const pbVolume = useStore((s) => s.playback.volume)
  const pbMuted = useStore((s) => s.playback.muted)
  const pbHasTrack = useStore((s) => s.playback.queue.length > 0)
  const pbPosition = useStore((s) => (withProgress ? s.playback.position : 0))
  const pbDuration = useStore((s) => (withProgress ? s.playback.duration : 0))
  const isRemote = remoteFlag && connected
  const send = (cmd: unknown): void => {
    void window.lm.invoke('netmusic/command', cmd)
  }
  const live = net.playing ? net.basePositionMs + (performance.now() - net.baseAt) : net.basePositionMs
  return {
    isRemote,
    playing: isRemote ? net.playing : pbPlaying,
    position: isRemote ? live / 1000 : pbPosition,
    duration: isRemote ? net.durationMs / 1000 : pbDuration,
    volume: isRemote ? net.volume : pbVolume,
    muted: isRemote ? net.muted : pbMuted,
    hasTrack: isRemote ? Boolean(net.track) : pbHasTrack,
    toggle: () => (isRemote ? send({ type: 'toggle' }) : useStore.getState().togglePlay()),
    next: () => (isRemote ? send({ type: 'next' }) : useStore.getState().next()),
    prev: () => (isRemote ? send({ type: 'prev' }) : useStore.getState().prev()),
    seek: (sec) => (isRemote ? send({ type: 'seek', value: sec * 1000 }) : useStore.getState().seek(sec)),
    setVolume: (v) => (isRemote ? send({ type: 'volume', value: v }) : useStore.getState().setVolume(v)),
    toggleMute: () =>
      isRemote
        ? send({ type: 'volume', value: net.muted ? 1 : 0 })
        : useStore.getState().toggleMute()
  }
}

/** 当前曲目的统一取法：本地播放取队列，远端（汽水）取插件状态，包装成同一形状。 */
function useNowPlayingSong(): { song: SongMeta | undefined; remoteCover: string | null } {
  const queue = useStore((s) => s.playback.queue)
  const index = useStore((s) => s.playback.index)
  const songs = useStore((s) => s.songs)
  const target = useTarget()
  const net = useStore((s) => s.netMusic)
  const item = queue[index]
  const localSong = item ? songs[item.songId] : undefined
  const remoteSong = target.isRemote && net.track
    ? ({
        id: net.track.id,
        title: net.track.title,
        artists: net.track.artists ? net.track.artists.split(' / ') : [],
        coverId: null,
        albumKey: '',
        durationSec: net.durationMs / 1000
      } as unknown as SongMeta)
    : undefined
  const song = target.isRemote ? remoteSong : localSong
  const remoteCover = target.isRemote ? net.track?.coverUrl ?? null : null
  return { song, remoteCover }
}

function TransportButtons(): JSX.Element {
  const target = useTarget()
  const playing = target.playing
  const shuffle = useStore((s) => s.playback.shuffle)
  const repeat = useStore((s) => s.playback.repeat)
  const togglePlay = target.toggle
  const next = target.next
  const prev = target.prev
  const toggleShuffle = useStore((s) => s.toggleShuffle)
  const cycleRepeat = useStore((s) => s.cycleRepeat)
  // 汽水没有稳定的「随机/循环」接口：远端模式下直接隐藏，不做假按钮
  const remote = target.isRemote

  return (
    <>
      {!remote && (
      <button
        type="button"
        className={`${styles.iconButton} ${shuffle ? styles.on : ''}`}
        onClick={toggleShuffle}
        title="随机播放"
        aria-pressed={shuffle}
      >
        <Icon name="shuffle" size={16} />
      </button>
      )}
      <button type="button" className={styles.iconButton} onClick={prev} title="上一首 (Ctrl+←)">
        <Icon name="prev" size={20} />
      </button>
      <button
        type="button"
        className={styles.playButton}
        onClick={togglePlay}
        title={playing ? '暂停 (Space)' : '播放 (Space)'}
      >
        <Icon name={playing ? 'pause' : 'play'} size={26} />
      </button>
      <button type="button" className={styles.iconButton} onClick={() => next()} title="下一首 (Ctrl+→)">
        <Icon name="next" size={20} />
      </button>
      <button
        type="button"
        className={`${styles.iconButton} ${repeat !== 'off' ? styles.on : ''}`}
        onClick={cycleRepeat}
        title={repeat === 'one' ? '单曲循环' : repeat === 'all' ? '列表循环' : '循环关闭'}
        aria-pressed={repeat !== 'off'}
      >
        <Icon name={repeat === 'one' ? 'repeatOne' : 'repeat'} size={16} />
        {repeat === 'one' && <span className={styles.badge}>1</span>}
      </button>
    </>
  )
}

function TransportGroup(): JSX.Element {
  return (
    <div className={`glass glassFull ${styles.group}`}>
      <TransportButtons />
    </div>
  )
}

/** 静音钮 + 滑杆：顶栏胶囊和底栏共用同一套交互 */
function VolumeSlider(): JSX.Element {
  const target = useTarget()
  const volume = target.volume
  const muted = target.muted
  const setVolume = target.setVolume
  const toggleMute = target.toggleMute
  const trackRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)

  const value = muted ? 0 : volume

  const updateFromEvent = useCallback(
    (clientX: number) => {
      const el = trackRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
      setVolume(ratio)
    },
    [setVolume]
  )

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    setDragging(true)
    event.currentTarget.setPointerCapture(event.pointerId)
    updateFromEvent(event.clientX)
  }

  return (
    <>
      <button type="button" className={styles.volumeIcon} onClick={toggleMute} title="静音">
        <Icon name={value > 0.45 ? 'volumeHigh' : 'volumeLow'} size={16} />
      </button>
      <div
        className={styles.slider}
        onPointerDown={onPointerDown}
        onPointerMove={(event) => {
          if (dragging) updateFromEvent(event.clientX)
        }}
        onPointerUp={(event) => {
          setDragging(false)
          event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        role="slider"
        aria-label="音量"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(value * 100)}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight') setVolume(Math.min(1, volume + 0.05))
          if (event.key === 'ArrowLeft') setVolume(Math.max(0, volume - 0.05))
        }}
      >
        <div className={styles.sliderTrack} ref={trackRef}>
          <div className={styles.sliderFill} style={{ width: `${value * 100}%` }} />
          <div className={styles.sliderThumb} style={{ left: `${value * 100}%` }} />
        </div>
      </div>
    </>
  )
}

function VolumeGroup(): JSX.Element {
  const setVolume = useTarget().setVolume
  return (
    <div className={`glass glassFull ${styles.group} ${styles.volume}`}>
      <VolumeSlider />
      <button type="button" className={styles.volumeIcon} onClick={() => setVolume(1)} title="最大音量">
        <Icon name="volumeHigh" size={16} />
      </button>
    </div>
  )
}

function PanelButtons(): JSX.Element {
  const lyricsOpen = useStore((s) => s.lyricsOpen)
  const queueOpen = useStore((s) => s.queueOpen)
  const setLyricsOpen = useStore((s) => s.setLyricsOpen)
  const setQueueOpen = useStore((s) => s.setQueueOpen)

  return (
    <>
      <button
        type="button"
        className={`${styles.roundButton} ${lyricsOpen ? styles.active : ''}`}
        onClick={() => setLyricsOpen(!useStore.getState().lyricsOpen)}
        title="歌词面板 (Ctrl+L)"
        aria-pressed={lyricsOpen}
      >
        <Icon name="lyrics" size={20} />
      </button>
      <button
        type="button"
        className={`${styles.roundButton} ${queueOpen ? styles.active : ''}`}
        onClick={() => setQueueOpen(!queueOpen)}
        title="待播清单"
        aria-pressed={queueOpen}
      >
        <Icon name="queue" size={20} />
      </button>
    </>
  )
}

function PanelGroup(): JSX.Element {
  return (
    <div className={`glass glassFull ${styles.group} ${styles.panelGroup}`}>
      <PanelButtons />
    </div>
  )
}

function NowPlayingPill(): JSX.Element {
  const settings = useStore((s) => s.settings)
  const { song, remoteCover } = useNowPlayingSong()
  const target = useTarget(true)
  const position = target.position
  const duration = target.duration
  const seek = target.seek
  const setFullscreen = useStore((s) => s.setFullscreen)
  const setView = useStore((s) => s.setView)
  const automix = useAutoMix((s) => s.status)
  const automixLevel = useAutoMix((s) => s.level)
  const [hovering, setHovering] = useState(false)
  const [dragging, setDragging] = useState(false)
  const trackRef = useRef<HTMLDivElement>(null)
  const percent = duration > 0 ? Math.min(100, (position / duration) * 100) : 0

  const seekFrom = (clientX: number): void => {
    const el = trackRef.current
    if (!el || duration <= 0) return
    const rect = el.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    seek(ratio * duration)
  }

  return (
    <div
      className={`glass glassFull glassBar ${styles.nowPlaying}`}
      data-bar-style={settings.barStyle}
      onPointerEnter={() => setHovering(true)}
      onPointerLeave={() => setHovering(false)}
      // 整块胶囊都能点开全屏歌词：之前只有 34px 的封面和歌名可点，点空白处「没反应」
      onClick={() => {
        if (song) setFullscreen(true)
      }}
      role="button"
      tabIndex={song ? 0 : -1}
      onKeyDown={(event) => {
        if (song && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault()
          setFullscreen(true)
        }
      }}
      title={song ? '全屏播放' : undefined}
      style={{ cursor: song ? 'pointer' : 'default' }}
    >
      {song ? (
        <>
          {settings.barStyle === 'blur' && song.coverId && (
            <span
              className={styles.coverTint}
              // 封面只作「环境色」：模糊后压到 ~22%，边缘由胶囊自己裁掉，
              // 看上去是玻璃里透出的一点颜色，而不是一张图片。
              style={{
                backgroundImage: `url(${coverUrl(song.coverId, 240)})`,
                opacity: settings.barCover * 0.5
              }}
              aria-hidden="true"
            />
          )}
          <button
            type="button"
            className={styles.coverWrap}
            onClick={(event) => {
              event.stopPropagation()
              setFullscreen(true)
            }}
            title="全屏播放"
          >
            {remoteCover ? (
              <img className={styles.remoteCover} src={remoteCover} alt="" draggable={false} referrerPolicy="no-referrer" />
            ) : (
              <Cover coverId={song.coverId} size={80} display={34} radius={8} alt={song.title} />
            )}
            <span className={styles.coverOverlay}>
              <Icon name="expand" size={16} />
            </span>
          </button>
          <div className={`${styles.meta} noDrag`}>
            <button
              type="button"
              className={styles.titleButton}
              onClick={(event) => {
                event.stopPropagation()
                setFullscreen(true)
              }}
              title="全屏播放"
            >
              <span className={`${styles.title} ellipsis`}>{song.title}</span>
            </button>
            <div className={styles.subtitleRow}>
              <button
                type="button"
                className={styles.link}
                onClick={(event) => {
                  event.stopPropagation()
                  setView({ kind: 'artist', name: song.artists[0] ?? song.albumArtist })
                }}
                title={`查看艺人 ${song.artists[0] ?? song.albumArtist}`}
              >
                {song.artists.join('、')}
              </button>
              <span className={styles.dash}>—</span>
              <button
                type="button"
                className={styles.link}
                onClick={(event) => {
                  event.stopPropagation()
                  setView({ kind: 'album', key: albumKeyOf(song) })
                }}
                title={`查看专辑 ${song.album}`}
              >
                {song.album}
              </button>
            </div>
          </div>
          {automix === 'ready' && automixLevel && (
            <span className={styles.automixChip} title={`AutoMix ${automixLevel} 级已就绪`}>
              <Icon name="sparkles" size={12} />
              {automixLevel}
            </span>
          )}
          <div
            className={styles.progressArea}
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <div
              ref={trackRef}
              className={`${styles.progressTrack} ${dragging ? styles.dragging : ''}`}
              onPointerDown={(event) => {
                event.preventDefault()
                setDragging(true)
                event.currentTarget.setPointerCapture(event.pointerId)
                seekFrom(event.clientX)
              }}
              onPointerMove={(event) => {
                if (dragging) seekFrom(event.clientX)
              }}
              onPointerUp={(event) => {
                setDragging(false)
                event.currentTarget.releasePointerCapture(event.pointerId)
              }}
              role="slider"
              aria-label="播放进度"
              aria-valuemin={0}
              aria-valuemax={Math.round(duration)}
              aria-valuenow={Math.round(position)}
              tabIndex={0}
            >
              <div className={styles.progressFill} style={{ width: `${percent}%` }} />
              <div className={styles.progressHandle} style={{ left: `${percent}%` }} />
            </div>
          </div>
          {hovering && (
            <div className={styles.times}>
              <span>{formatTime(position)}</span>
              <span>{formatRemaining(position, duration)}</span>
            </div>
          )}
        </>
      ) : (
        <div className={styles.emptyNow}>
          <Icon name="music" size={16} />
          <span>未播放</span>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ 传统底栏 */
/* 一整条连续的实色底栏：左侧「正在播放」、中间「控制 + 进度」、右侧「音量 + 面板」。
   不复用顶栏的胶囊 grid，内部没有任何分组。起点在侧栏右侧，
   左下角的「设置」入口不会被遮住。 */

function DockNowPlaying(): JSX.Element {
  const setFullscreen = useStore((s) => s.setFullscreen)
  const setView = useStore((s) => s.setView)
  const { song, remoteCover } = useNowPlayingSong()

  if (!song) {
    return (
      <div className={styles.dockEmpty}>
        <Icon name="music" size={16} />
        <span>未播放</span>
      </div>
    )
  }

  return (
    <>
      <button
        type="button"
        className={styles.dockCoverWrap}
        onClick={() => setFullscreen(true)}
        title="全屏播放"
      >
        {remoteCover ? (
          <img className={styles.remoteCoverLarge} src={remoteCover} alt="" draggable={false} referrerPolicy="no-referrer" />
        ) : (
          <Cover coverId={song.coverId} size={80} display={44} radius={8} alt={song.title} />
        )}
        <span className={styles.coverOverlay}>
          <Icon name="expand" size={16} />
        </span>
      </button>
      <div className={styles.dockMeta}>
        <button
          type="button"
          className={styles.dockTitle}
          onClick={() => setFullscreen(true)}
          title="全屏播放"
        >
          <span className="ellipsis">{song.title}</span>
        </button>
        <div className={styles.dockSub}>
          <button
            type="button"
            className={styles.link}
            onClick={() => setView({ kind: 'artist', name: song.artists[0] ?? song.albumArtist })}
            title={`查看艺人 ${song.artists[0] ?? song.albumArtist}`}
          >
            {song.artists.join('、')}
          </button>
          <span className={styles.dash}>—</span>
          <button
            type="button"
            className={styles.link}
            onClick={() => setView({ kind: 'album', key: albumKeyOf(song) })}
            title={`查看专辑 ${song.album}`}
          >
            {song.album}
          </button>
        </div>
      </div>
    </>
  )
}

function DockTransport(): JSX.Element {
  const target = useTarget(true)
  const position = target.position
  const duration = target.duration
  const seek = target.seek
  const trackRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const percent = duration > 0 ? Math.min(100, (position / duration) * 100) : 0

  const seekFrom = (clientX: number): void => {
    const el = trackRef.current
    if (!el || duration <= 0) return
    const rect = el.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    seek(ratio * duration)
  }

  return (
    <div className={styles.dockCenter}>
      <div className={styles.dockButtons}>
        <TransportButtons />
      </div>
      <div className={styles.dockProgress}>
        <span className={styles.dockTime}>{formatTime(position)}</span>
        <div
          ref={trackRef}
          className={`${styles.dockTrack} ${dragging ? styles.dragging : ''}`}
          onPointerDown={(event) => {
            event.preventDefault()
            setDragging(true)
            event.currentTarget.setPointerCapture(event.pointerId)
            seekFrom(event.clientX)
          }}
          onPointerMove={(event) => {
            if (dragging) seekFrom(event.clientX)
          }}
          onPointerUp={(event) => {
            setDragging(false)
            event.currentTarget.releasePointerCapture(event.pointerId)
          }}
          role="slider"
          aria-label="播放进度"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(position)}
          tabIndex={0}
        >
          <div className={styles.dockFill} style={{ width: `${percent}%` }} />
        </div>
        <span className={styles.dockTime}>{formatRemaining(position, duration)}</span>
      </div>
    </div>
  )
}

export function TopBar({ variant = 'top' }: { variant?: 'top' | 'bottom' }): JSX.Element {
  const settings = useStore((s) => s.settings)
  const viewKind = useStore((s) => s.view.kind)
  // 在「网络音乐」页里，这条控制栏整体切到汽水音乐
  const remote = viewKind === 'netmusic'
  const cssVars = {
    '--bar-blur': `${settings.barBlur}px`,
    '--bar-opacity': String(settings.barOpacity),
    '--bar-cover': String(settings.barCover)
  } as React.CSSProperties

  // 传统底栏：独立的整条底栏，与顶栏完全分家
  if (variant === 'bottom') {
    return (
      <RemoteContext.Provider value={remote}>
        <div className={styles.bottomDock} style={cssVars} data-bar-style={settings.barStyle}>
          {/* 拖拽带让开右缘与下缘 6px，不吃掉系统缩放热区 */}
          <div className={`dragRegion ${styles.dockDragStrip}`} aria-hidden="true" />
          <div className={styles.dockLeft}>
            <DockNowPlaying />
          </div>
          <DockTransport />
          <div className={styles.dockRight}>
            <div className={styles.dockVolume}>
              <VolumeSlider />
            </div>
            <PanelButtons />
          </div>
        </div>
      </RemoteContext.Provider>
    )
  }

  return (
    <RemoteContext.Provider value={remote}>
    <div className={styles.bar} style={cssVars} data-bar-style={settings.barStyle}>
      {/* 拖拽交给背后这条独立的带子：交互元素不在拖拽区里，点击永远不会被合成器吃掉 */}
      <div className={`dragRegion ${styles.dragStrip}`} aria-hidden="true" />
      <div className="noDrag">
        <TransportGroup />
      </div>
      <div className="noDrag">
        <VolumeGroup />
      </div>
      <NowPlayingPill />
      <div style={{ flex: '0 0 auto' }} className="noDrag">
        <PanelGroup />
      </div>
    </div>
    </RemoteContext.Provider>
  )
}
