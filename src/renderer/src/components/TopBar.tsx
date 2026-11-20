import { createContext, useCallback, useContext, useRef, useState, type JSX } from 'react'
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

function useTarget(): {
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
  const playback = useStore((s) => s.playback)
  const isRemote = remoteFlag && connected
  const send = (cmd: unknown): void => {
    void window.lm.invoke('netmusic/command', cmd)
  }
  const live = net.playing ? net.basePositionMs + (performance.now() - net.baseAt) : net.basePositionMs
  return {
    isRemote,
    playing: isRemote ? net.playing : playback.playing,
    position: isRemote ? live / 1000 : playback.position,
    duration: isRemote ? net.durationMs / 1000 : playback.duration,
    volume: isRemote ? net.volume : playback.volume,
    muted: isRemote ? net.muted : playback.muted,
    hasTrack: isRemote ? Boolean(net.track) : playback.queue.length > 0,
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

function TransportGroup(): JSX.Element {
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
    <div className={`glass glassFull ${styles.group}`}>
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
    </div>
  )
}

function VolumeGroup(): JSX.Element {
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
    <div className={`glass glassFull ${styles.group} ${styles.volume}`}>
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
      <button type="button" className={styles.volumeIcon} onClick={() => setVolume(1)} title="最大音量">
        <Icon name="volumeHigh" size={16} />
      </button>
    </div>
  )
}

function NowPlayingPill(): JSX.Element {
  const settings = useStore((s) => s.settings)
  const queue = useStore((s) => s.playback.queue)
  const index = useStore((s) => s.playback.index)
  const songs = useStore((s) => s.songs)
  const target = useTarget()
  const net = useStore((s) => s.netMusic)
  const position = target.position
  const duration = target.duration
  const seek = target.seek
  const setFullscreen = useStore((s) => s.setFullscreen)
  const setView = useStore((s) => s.setView)
  const automix = useAutoMix((s) => s.status)
  const automixLevel = useAutoMix((s) => s.level)

  const item = queue[index]
  const localSong = item ? songs[item.songId] : undefined
  // 远端模式：把汽水的曲目包装成同一形状，复用封面/标题/歌手的渲染
  const remoteSong = target.isRemote && net.track
    ? ({
        id: net.track.id,
        title: net.track.title,
        artists: net.track.artists ? net.track.artists.split(' / ') : [],
        coverId: null,
        albumKey: '',
        durationSec: net.durationMs / 1000
      } as unknown as (typeof localSong))
    : undefined
  const song = target.isRemote ? remoteSong : localSong
  const remoteCover = target.isRemote ? net.track?.coverUrl ?? null : null
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
      title={song ? '打开全屏歌词' : undefined}
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
            title="打开全屏正在播放"
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
              title="打开全屏正在播放"
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
          <span>未在播放</span>
        </div>
      )}
    </div>
  )
}

function PanelGroup(): JSX.Element {
  const lyricsOpen = useStore((s) => s.lyricsOpen)
  const queueOpen = useStore((s) => s.queueOpen)
  const setLyricsOpen = useStore((s) => s.setLyricsOpen)
  const setQueueOpen = useStore((s) => s.setQueueOpen)

  return (
    <div className={`glass glassFull ${styles.group} ${styles.panelGroup}`}>
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
    </div>
  )
}

export function TopBar({ variant = 'top' }: { variant?: 'top' | 'bottom' }): JSX.Element {
  const settings = useStore((s) => s.settings)
  const viewKind = useStore((s) => s.view.kind)
  // 在「网络音乐」页里，这条控制栏整体切到汽水音乐
  const remote = viewKind === 'netmusic'
  return (
    <RemoteContext.Provider value={remote}>
    <div
      className={`${styles.bar} ${variant === 'bottom' ? styles.barBottom : ''}`}
      style={
        {
          '--bar-blur': `${settings.barBlur}px`,
          '--bar-opacity': String(settings.barOpacity),
          '--bar-cover': String(settings.barCover)
        } as React.CSSProperties
      }
      data-bar-style={settings.barStyle}
    >
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
