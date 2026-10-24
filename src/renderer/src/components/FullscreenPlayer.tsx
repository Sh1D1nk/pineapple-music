import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { BackgroundRender } from '@applemusic-like-lyrics/react'
import { useStore } from '../state/store'
import { coverUrl } from '../bridge'
import { Cover } from './Cover'
import { Icon } from './Icon'
import { LyricsView, withDisplayOptions } from './LyricsView'
import { formatRemaining, formatTime } from '../lib/format'
import styles from './overlays.module.css'

/**
 * 全屏正在播放。
 *
 * 版式对齐参考实现（汽水 AMLL 插件的歌词页）：
 *   sa-stage = flex，左栏 50%（关闭条 / 封面 / 曲名 / 进度 / 控制 / 音量），右栏 50%（AMLL 歌词）。
 *   封面 min(52vh,37vw)、圆角 3%、暂停 scale(.84) / 播放 scale(1.03)，弹性曲线 (.34,1.56,.64,1)。
 *   歌词字号 max(max(5vh,2.5vw),12px) × 用户倍数，上下用 mask 渐隐而不是压一层黑色遮罩。
 */
export function FullscreenPlayer(): JSX.Element {
  const open = useStore((s) => s.fullscreen)
  const setFullscreen = useStore((s) => s.setFullscreen)
  const playback = useStore((s) => s.playback)
  const songs = useStore((s) => s.songs)
  const lyrics = useStore((s) => s.lyrics)
  const settings = useStore((s) => s.settings)
  const seek = useStore((s) => s.seek)
  const togglePlay = useStore((s) => s.togglePlay)
  const next = useStore((s) => s.next)
  const prev = useStore((s) => s.prev)
  const setVolume = useStore((s) => s.setVolume)
  const toggleShuffle = useStore((s) => s.toggleShuffle)
  const cycleRepeat = useStore((s) => s.cycleRepeat)
  const setInfoSongId = useStore((s) => s.setInfoSongId)
  const setCoverFlowOpen = useStore((s) => s.setCoverFlowOpen)
  const setLyricsOpen = useStore((s) => s.setLyricsOpen)
  const setQueueOpen = useStore((s) => s.setQueueOpen)
  const shuffle = useStore((s) => s.playback.shuffle)
  const repeat = useStore((s) => s.playback.repeat)

  const [mounted, setMounted] = useState(open)
  /** 上一首/下一首/播放的按压动画（对齐插件的 saPushL/R/C） */
  const [push, setPush] = useState<'l' | 'r' | 'c' | null>(null)
  const [fpsValue, setFps] = useState(0)
  /** 自适应画质对渲染精度的缩放系数（1 = 用户设定值，0.2 = 最低） */
  const [adaptiveScale, setAdaptiveScale] = useState(1)
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (open) {
      setMounted(true)
      return undefined
    }
    const timer = window.setTimeout(() => setMounted(false), 460)
    return () => window.clearTimeout(timer)
  }, [open])

  const song = songs[playback.queue[playback.index]?.songId ?? '']
  const albumArt = coverUrl(song?.coverId ?? null, 640)
  const trackRef = useRef<HTMLDivElement>(null)

  const lines = useMemo(() => {
    if (!lyrics || lyrics.kind !== 'synced') return []
    return withDisplayOptions(lyrics.lines, settings.showTranslation, settings.showRoman)
  }, [lyrics, settings.showTranslation, settings.showRoman])

  const hasLyrics = lines.length > 0
  const position = playback.position
  const duration = playback.duration || song?.durationSec || 0
  const percent = duration > 0 ? Math.min(100, (position / duration) * 100) : 0
  // 与插件 applyFontScale() 同一条公式：max(max(5vh, 2.5vw), 12px) × 倍数
  const lyricFontSize = Math.round(
    Math.max(Math.max(window.innerHeight * 0.05, window.innerWidth * 0.025), 12) *
      settings.lyricFontScale
  )

  // Q 弹缩放：按下时重放一次关键帧
  const pulse = (dir: 'l' | 'r' | 'c'): void => {
    if (!settings.btnAnim) return
    setPush(null)
    window.requestAnimationFrame(() => setPush(dir))
    window.setTimeout(() => setPush(null), 460)
  }

  // 关闭条跟随鼠标：位移超过阈值就松手回弹（插件的 FOLLOW / LIMIT）
  const bindClose = (el: HTMLButtonElement | null): void => {
    if (!el) return
    const FOLLOW = 0.24
    const LIMIT = 52
    let origin: { x: number; y: number } | null = null
    let expanded = false
    let released = false
    const collapse = (): void => {
      expanded = false
      el.removeAttribute('data-expanded')
      el.style.transform = ''
    }
    const onMove = (event: PointerEvent): void => {
      if (!expanded || !origin) return
      const dx = event.clientX - origin.x
      const dy = event.clientY - origin.y
      if (Math.hypot(dx, dy) > LIMIT) {
        released = true
        collapse()
        return
      }
      el.style.transform = `translate(${(dx * FOLLOW).toFixed(1)}px,${(dy * FOLLOW).toFixed(1)}px)`
    }
    el.addEventListener('pointerenter', (event) => {
      if (released) return
      const rect = el.getBoundingClientRect()
      origin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      expanded = true
      el.setAttribute('data-expanded', '1')
      onMove(event)
    })
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerleave', () => {
      released = false
      origin = null
      collapse()
    })
  }

  // 实时帧率（插件右上角的 FPS 指示）。
  // 同时作为「自适应画质」的输入：低帧时自动下调背景渲染精度，回升后缓慢恢复。
  useEffect(() => {
    if (!settings.showFps && !settings.adaptiveQuality) return undefined
    let raf = 0
    let last = performance.now()
    let frames = 0
    let acc = 0
    const loop = (now: number): void => {
      acc += now - last
      last = now
      frames += 1
      if (acc >= 500) {
        const value = Math.round((frames * 1000) / acc)
        setFps(value)
        if (settings.adaptiveQuality) {
          setAdaptiveScale((prev) => {
            // 连续低帧就降精度；帧率恢复后缓慢回升，避免来回抖动
            if (value < 24) return Math.max(0.2, prev - 0.1)
            if (value > 50) return Math.min(1, prev + 0.05)
            return prev
          })
        }
        acc = 0
        frames = 0
      }
      raf = window.requestAnimationFrame(loop)
    }
    raf = window.requestAnimationFrame(loop)
    return () => window.cancelAnimationFrame(raf)
  }, [settings.showFps, settings.adaptiveQuality])

  const seekFrom = (clientX: number): void => {
    const el = trackRef.current
    if (!el || duration <= 0) return
    const rect = el.getBoundingClientRect()
    seek(Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * duration)
  }

  return (
    <div
      className={`${styles.fullscreen} ${open ? styles.fullscreenOpen : ''} ${hasLyrics ? '' : styles.fsNoLyric}`}
      aria-hidden={!open}
    >
      {mounted && song && albumArt && settings.bgEnabled && settings.bgType === 'flow' ? (
        <div
          className={styles.fsBg}
          style={{ filter: `saturate(${settings.bgSaturate}) brightness(${settings.bgBrightness})` }}
        >
          <BackgroundRender
            album={albumArt}
            playing={playback.playing}
            fps={
              settings.bgPerf ? 15 : Math.max(10, Math.round(settings.bgFps * adaptiveScale))
            }
            flowSpeed={settings.bgFlowSpeed}
            hasLyric={hasLyrics}
            renderScale={Math.max(0.2, settings.bgRenderScale * adaptiveScale)}
            staticMode={settings.bgPerf || settings.bgFps === 0}
            style={{ width: '100%', height: '100%' }}
          />
        </div>
      ) : mounted && song && albumArt && settings.bgEnabled && settings.bgType === 'blur' ? (
        <div
          className={styles.fsBg}
          style={{
            backgroundImage: `url(${albumArt})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            filter: `blur(${settings.bgBlur}px) saturate(${settings.bgSaturate}) brightness(${settings.bgBrightness})`
          }}
        />
      ) : (
        <div className={styles.fsBg} style={{ background: 'linear-gradient(150deg,#3a3a3f,#111113)' }} />
      )}
      <div className={styles.fsTint} />
      <div className={styles.fsVignette} />

      {/* 全屏页右上角：切回右侧停靠的歌词面板（两者互斥，面板在更低的层里，必须先退出全屏） */}
      <div className={styles.fsCorner}>
        <button
          type="button"
          className={styles.fsCornerButton}
          onClick={() => setLyricsOpen(true)}
          title="歌词面板 (Ctrl+L)"
        >
          <Icon name="lyrics" size={18} />
        </button>
      </div>

      {mounted && (
        <div className={styles.fsStage}>
          <div className={styles.fsLeft}>
            <button
              type="button"
              className={styles.fsClose}
              ref={(el) => {
                closeRef.current = el
                bindClose(el)
              }}
              onClick={() => setFullscreen(false)}
              title="关闭 (Esc)"
            >
              <span className={styles.fsChip}>
                <span className={styles.fsX}>
                  <Icon name="close" size={22} />
                </span>
              </span>
            </button>

            <div
              key={song?.id ?? 'none'}
              className={`${styles.fsCover} ${playback.playing ? styles.fsCoverPlaying : ''} ${
                settings.mediaAnim ? styles.fsCoverEnter : ''
              }`}
              onClick={togglePlay}
              style={settings.coverHideCursor ? { cursor: 'none' } : undefined}
            >
              <Cover coverId={song?.coverId ?? null} size={640} radius={0} alt={song?.title ?? ''} />
            </div>

            <div className={styles.fsInfo}>
              <div className={styles.fsMeta}>
                <div className={styles.fsMetaText}>
                  <div className={`${styles.fsName} ellipsis`}>{song?.title ?? '未在播放'}</div>
                  <div className={`${styles.fsArtistLine} ellipsis`}>{song?.artists.join('、') ?? ''}</div>
                  {settings.showAlbum && (
                    <div className={`${styles.fsAlbumLine} ellipsis`}>{song?.album ?? ''}</div>
                  )}
                </div>
                <button
                  type="button"
                  className={styles.fsMore}
                  onClick={() => song && setInfoSongId(song.id)}
                  title="歌曲信息"
                >
                  <Icon name="more" size={18} />
                </button>
              </div>

              <div
                ref={trackRef}
                className={styles.fsProgress}
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId)
                  seekFrom(event.clientX)
                }}
                onPointerMove={(event) => {
                  if (event.buttons === 1) seekFrom(event.clientX)
                }}
                role="slider"
                aria-label="播放进度"
                aria-valuemin={0}
                aria-valuemax={Math.round(duration)}
                aria-valuenow={Math.round(position)}
                tabIndex={0}
              >
                <div className={styles.fsProgressInner}>
                  <div className={styles.fsProgressFill} style={{ width: `${percent}%` }} />
                </div>
              </div>
              <div className={styles.fsTimes}>
                <span>{formatTime(position)}</span>
                <span>{formatRemaining(position, duration)}</span>
              </div>

              <div className={styles.fsControls}>
                <button
                  type="button"
                  className={`${styles.fsMode} ${shuffle ? styles.fsModeOn : ''}`}
                  onClick={toggleShuffle}
                  title="随机播放"
                >
                  <Icon name="shuffle" size={20} />
                </button>
                <button
                  type="button"
                  className={`${styles.fsPrev} ${push === 'l' ? styles.fsPushL : ''}`}
                  onClick={() => {
                    pulse('l')
                    prev()
                  }}
                  title="上一首"
                >
                  <Icon name="prev" size={26} />
                </button>
                <button
                  type="button"
                  className={`${styles.fsPlay} ${push === 'c' ? styles.fsPushC : ''}`}
                  onClick={() => {
                    pulse('c')
                    togglePlay()
                  }}
                  title="播放 / 暂停"
                >
                  <Icon name={playback.playing ? 'pause' : 'play'} size={34} />
                </button>
                <button
                  type="button"
                  className={`${styles.fsNext} ${push === 'r' ? styles.fsPushR : ''}`}
                  onClick={() => {
                    pulse('r')
                    next()
                  }}
                  title="下一首"
                >
                  <Icon name="next" size={26} />
                </button>
                <button
                  type="button"
                  className={`${styles.fsMode} ${repeat !== 'off' ? styles.fsModeOn : ''}`}
                  onClick={cycleRepeat}
                  title={repeat === 'one' ? '单曲循环' : repeat === 'all' ? '列表循环' : '循环关闭'}
                >
                  <Icon name={repeat === 'one' ? 'repeatOne' : 'repeat'} size={20} />
                </button>
              </div>

              <div className={styles.fsVolume}>
                <Icon name="volumeLow" size={16} className={styles.fsVicon} />
                <div
                  className={styles.fsVolumeTrack}
                  onPointerDown={(event) => {
                    event.currentTarget.setPointerCapture(event.pointerId)
                    const rect = event.currentTarget.getBoundingClientRect()
                    setVolume(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)))
                  }}
                  onPointerMove={(event) => {
                    if (event.buttons !== 1) return
                    const rect = event.currentTarget.getBoundingClientRect()
                    setVolume(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)))
                  }}
                  role="slider"
                  aria-label="音量"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(playback.volume * 100)}
                  tabIndex={0}
                >
                  <div className={styles.fsVolumeFill} style={{ width: `${playback.volume * 100}%` }} />
                </div>
                <Icon name="volumeHigh" size={16} className={styles.fsVicon} />
              </div>
            </div>
          </div>

          <div className={styles.fsLyric}>
            <LyricsView
              lines={lines}
              playing={playback.playing}
              offsetMs={settings.lyricOffsetMs}
              fontSize={lyricFontSize}
              weight={settings.lyricWeight}
              highlight={settings.lyricHighlight}
              blur={settings.lyricBlur}
              scale={settings.lyricScale}
              wordFade={settings.wordFade}
              hidePassed={settings.hidePassed}
              clickSeek={settings.lyricClickSeek}
              fontFamily={
                settings.lyricFont === 'pingfang'
                  ? '"PingFang SC","Microsoft YaHei",system-ui,sans-serif'
                  : 'system-ui,"Segoe UI",sans-serif'
              }
              alignAnchor="center"
              alignPosition={0.5}
              onSeek={(seconds) => seek(seconds)}
              color="rgba(255,255,255,.96)"
            />
            {!hasLyrics && (
              <div className={styles.fsEmpty}>
                <div>暂无歌词</div>
                <div className={styles.fsEmptyHint}>把同名 .lrc 放在歌曲旁边即可自动加载</div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
