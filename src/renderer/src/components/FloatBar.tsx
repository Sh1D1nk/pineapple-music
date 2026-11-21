import { useEffect, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent } from 'react'
import { useStore } from '../state/store'
import { Icon } from './Icon'
import { Cover } from './Cover'
import { coverUrl } from '../bridge'
import { formatTime } from '../lib/format'
import { springTo, type SpringHandle } from '../lib/spring'
import styles from './FloatBar.module.css'

/**
 * 悬浮玻璃播放底栏（对照 Kyant0/AndroidLiquidGlass 的 Glass Bottom Bar 配方）。
 *
 * 交互：点胶囊里的封面/标题 → 全屏歌词；圆形按钮 → 歌词面板 / 待播清单。
 * 进度不经过 React：rAF 之外用 200ms 的定时器直接写 CSS 变量与文本，
 * 播放中也不会因为「时间变了」而重渲染整条底栏。
 */
export function FloatBar(): JSX.Element {
  const viewKind = useStore((s) => s.view.kind)
  const netConnected = useStore((s) => s.netStatus.connected)
  const remote = viewKind === 'netmusic' && netConnected
  const net = useStore((s) => s.netMusic)

  const queue = useStore((s) => s.playback.queue)
  const index = useStore((s) => s.playback.index)
  const songs = useStore((s) => s.songs)
  const playing = useStore((s) => (remote ? s.netMusic.playing : s.playback.playing))
  const volume = useStore((s) => (remote ? s.netMusic.volume : s.playback.volume))
  const muted = useStore((s) => (remote ? s.netMusic.muted : s.playback.muted))
  const lyricsOpen = useStore((s) => s.lyricsOpen)
  const queueOpen = useStore((s) => s.queueOpen)

  const setFullscreen = useStore((s) => s.setFullscreen)
  const setView = useStore((s) => s.setView)
  const setLyricsOpen = useStore((s) => s.setLyricsOpen)
  const setQueueOpen = useStore((s) => s.setQueueOpen)

  const send = (cmd: unknown, local: () => void): void => {
    if (remote) void window.lm.invoke('netmusic/command', cmd)
    else local()
  }

  const item = queue[index]
  const localSong = item ? songs[item.songId] : undefined
  const remoteSong =
    remote && net.track
      ? {
          title: net.track.title,
          artists: net.track.artists,
          coverUrl: net.track.coverUrl,
          album: net.track.album,
          artist: net.track.artists
        }
      : null
  const title = remote ? remoteSong?.title : localSong?.title
  const artist = remote ? remoteSong?.artists : localSong?.artists.join('、')
  const cover = remote ? remoteSong?.coverUrl ?? null : localSong?.coverId ? coverUrl(localSong.coverId, 240) : null

  const capsuleRef = useRef<HTMLDivElement>(null)
  const fillRef = useRef<HTMLDivElement>(null)
  const timeRef = useRef<HTMLSpanElement>(null)
  const restRef = useRef<HTMLSpanElement>(null)
  const coverRef = useRef<HTMLButtonElement>(null)
  const springRef = useRef<SpringHandle | null>(null)
  const pressRef = useRef(0)
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{ rect: DOMRect; pointerId: number } | null>(null)
  const [volumeOpen, setVolumeOpen] = useState(false)

  /* ---- 按压弹簧：玻璃整体放大 (宽+16)/宽，内容层不参与 ---- */
  const setPress = (target: number): void => {
    springRef.current?.stop()
    const capsule = capsuleRef.current
    if (!capsule) return
    const width = capsule.offsetWidth || 520
    const height = capsule.offsetHeight || 64
    springRef.current = springTo(pressRef.current, target, (value) => {
      pressRef.current = value
      const sx = 1 + (16 / width) * value
      const sy = 1 + (10 / height) * value
      capsule.style.setProperty('--press-x', String(sx))
      capsule.style.setProperty('--press-y', String(sy))
    })
  }
  useEffect(() => () => springRef.current?.stop(), [])

  /* ---- 进度：直接写 DOM，不进 React ---- */
  useEffect(() => {
    const render = (): void => {
      const state = useStore.getState()
      const isRemote = state.view.kind === 'netmusic' && state.netStatus.connected
      let position = state.playback.position
      let duration = state.playback.duration
      if (isRemote) {
        const netState = state.netMusic
        position = (netState.playing ? netState.basePositionMs + (performance.now() - netState.baseAt) : netState.basePositionMs) / 1000
        duration = netState.durationMs / 1000
      }
      const p = duration > 0 ? Math.max(0, Math.min(1, position / duration)) : 0
      fillRef.current?.style.setProperty('--p', String(p))
      if (timeRef.current) timeRef.current.textContent = formatTime(position)
      if (restRef.current) restRef.current.textContent = duration > 0 ? `-${formatTime(Math.max(0, duration - position))}` : '--:--'
    }
    render()
    const timer = window.setInterval(render, 200)
    const off = useStore.subscribe(render)
    return () => {
      window.clearInterval(timer)
      off()
    }
  }, [])

  const seekFrom = (clientX: number): void => {
    const drag = dragRef.current
    if (!drag) return
    const ratio = Math.max(0, Math.min(1, (clientX - drag.rect.left) / Math.max(1, drag.rect.width)))
    const state = useStore.getState()
    const isRemote = state.view.kind === 'netmusic' && state.netStatus.connected
    const duration = isRemote ? state.netMusic.durationMs / 1000 : state.playback.duration
    const next = ratio * duration
    fillRef.current?.style.setProperty('--p', String(ratio))
    if (isRemote) void window.lm.invoke('netmusic/command', { type: 'seek', value: next * 1000 })
    else state.seek(next)
  }

  const onProgressDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    dragRef.current = { rect, pointerId: event.pointerId }
    setDragging(true)
    event.currentTarget.setPointerCapture(event.pointerId)
    seekFrom(event.clientX)
  }

  const openFullscreen = (): void => {
    if (title || remoteSong) setFullscreen(true)
  }

  return (
    <div className={styles.wrap} data-remote={remote ? '1' : '0'}>
      <div
        ref={capsuleRef}
        className={`glass glassFull ${styles.capsule}`}
        data-dragging={dragging ? 'true' : 'false'}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          setPress(1)
        }}
        onPointerUp={() => setPress(0)}
        onPointerLeave={() => setPress(0)}
        onPointerCancel={() => setPress(0)}
      >
        <button
          type="button"
          ref={coverRef}
          className={styles.cover}
          onClick={openFullscreen}
          title={title ? '全屏播放' : '未播放'}
          disabled={!title && !remoteSong}
        >
          {cover ? (
            <img src={cover} alt="" draggable={false} referrerPolicy="no-referrer" />
          ) : (
            <Cover coverId={localSong?.coverId ?? null} size={80} display={44} radius={10} alt={title ?? ''} />
          )}
        </button>

        <button type="button" className={styles.meta} onClick={openFullscreen} title="全屏播放">
          <span className={`${styles.title} ellipsis`}>{title ?? '未播放'}</span>
          <span className={`${styles.artist} ellipsis`}>
            {artist || (localSong ? localSong.album : '选择音乐')}
          </span>
        </button>

        <div className={styles.transport}>
          <button
            type="button"
            className={styles.iconButton}
            onClick={() => send({ type: 'prev' }, () => useStore.getState().prev())}
            title="上一首"
          >
            <Icon name="prev" size={18} />
          </button>
          <button
            type="button"
            className={styles.playButton}
            onClick={() => send({ type: 'toggle' }, () => useStore.getState().togglePlay())}
            title={playing ? '暂停' : '播放'}
          >
            <Icon name={playing ? 'pause' : 'play'} size={22} />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            onClick={() => send({ type: 'next' }, () => useStore.getState().next())}
            title="下一首"
          >
            <Icon name="next" size={18} />
          </button>
        </div>

        <div
          className={styles.volume}
          data-open={volumeOpen ? '1' : '0'}
          onPointerEnter={() => setVolumeOpen(true)}
          onPointerLeave={() => setVolumeOpen(false)}
        >
          <button
            type="button"
            className={styles.iconButton}
            onClick={() =>
              remote
                ? send({ type: 'volume', value: muted ? 1 : 0 }, () => undefined)
                : useStore.getState().toggleMute()
            }
            title={muted ? '取消静音' : '静音'}
          >
            <Icon name={muted || volume === 0 ? 'volumeLow' : 'volumeHigh'} size={16} />
          </button>
          <div className={styles.volumeSlider}>
            <div
              className={styles.volumeTrack}
              onPointerDown={(event) => {
                event.preventDefault()
                event.stopPropagation()
                const rect = event.currentTarget.getBoundingClientRect()
                const apply = (clientX: number): void => {
                  const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)))
                  if (remote) void window.lm.invoke('netmusic/command', { type: 'volume', value: ratio })
                  else useStore.getState().setVolume(ratio)
                }
                apply(event.clientX)
                const move = (e: PointerEvent): void => apply(e.clientX)
                const up = (): void => {
                  window.removeEventListener('pointermove', move)
                  window.removeEventListener('pointerup', up)
                }
                window.addEventListener('pointermove', move)
                window.addEventListener('pointerup', up)
              }}
            >
              <div className={styles.volumeFill} style={{ width: `${(muted ? 0 : volume) * 100}%` }} />
            </div>
          </div>
        </div>

        <span className={styles.times} aria-hidden="true">
          <span ref={timeRef}>0:00</span>
          <span ref={restRef}>--:--</span>
        </span>

        <div
          className={`${styles.progress} ${dragging ? styles.progressDragging : ''}`}
          onPointerDown={onProgressDown}
          onPointerMove={(event) => {
            if (dragging) seekFrom(event.clientX)
          }}
          onPointerUp={(event) => {
            setDragging(false)
            dragRef.current = null
            try {
              event.currentTarget.releasePointerCapture(event.pointerId)
            } catch {
              /* ignore */
            }
          }}
          role="slider"
          aria-label="播放进度"
          aria-valuemin={0}
          aria-valuemax={100}
          title="拖动调整进度"
        >
          <div ref={fillRef} className={styles.progressFill} />
        </div>
      </div>

      <div className={`glass glassFull ${styles.roundGroup}`}>
        <button
          type="button"
          className={`${styles.round} ${lyricsOpen ? styles.active : ''}`}
          onClick={() => setLyricsOpen(!lyricsOpen)}
          title="歌词面板 (Ctrl+L)"
          aria-pressed={lyricsOpen}
        >
          <Icon name="lyrics" size={20} />
        </button>
        <button
          type="button"
          className={`${styles.round} ${queueOpen ? styles.active : ''}`}
          onClick={() => setQueueOpen(!queueOpen)}
          title="待播清单"
          aria-pressed={queueOpen}
        >
          <Icon name="queue" size={20} />
        </button>
      </div>
    </div>
  )
}
