import { useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from 'react'
import { BackgroundRender, type BackgroundRenderRef } from '@applemusic-like-lyrics/react'
import { useStore, useCurrentSongId } from '../state/store'
import { bridge, coverUrl } from '../bridge'
import { Cover } from './Cover'
import { Icon } from './Icon'
import { LyricsView, withDisplayOptions } from './LyricsView'
import { useAutoMix } from '../audio/automix'
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
  const setCoverFlowOpen = useStore((s) => s.setCoverFlowOpen)
  const setQueueOpen = useStore((s) => s.setQueueOpen)
  const setLyricsMenu = useStore((s) => s.setLyricsMenu)
  const setLyricsQualityLevel = useStore((s) => s.setLyricsQualityLevel)
  const qualityLevel = useStore((s) => s.lyricsQualityLevel)
  const toggleMute = useStore((s) => s.toggleMute)
  const pushToast = useStore((s) => s.pushToast)
  const shuffle = useStore((s) => s.playback.shuffle)
  const repeat = useStore((s) => s.playback.repeat)

  const [mounted, setMounted] = useState(open)
  /** 上一首/下一首/播放的按压动画（对齐插件的 saPushL/R/C） */
  const [push, setPush] = useState<'l' | 'r' | 'c' | null>(null)
  const [fpsValue, setFps] = useState(0)
  /** 自适应档位的锁存状态：level + 连续低/高帧计数 + 上次变更时间 */
  const aqRef = useRef({ level: 0, bad: 0, good: 0, stepAt: 0 })
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

  /** 流体背景实例：切歌时要直接改它的流速，做出「搅动水面」再慢慢平静的效果 */
  const bgRef = useRef<BackgroundRenderRef>(null)
  /** 切歌墨滴扩散：旧封面垫底，新背景从随机一点铺满整屏后撤掉旧层 */
  const [ripple, setRipple] = useState<{ x: number; y: number; prevArt: string } | null>(null)
  const prevArtRef = useRef<string | null>(albumArt)
  /** 「接下来播放」自动隐藏（随机推荐场景） */
  const fsRandomHint = useStore((s) => s.fsRandomHint)
  const [upNextHidden, setUpNextHidden] = useState(false)
  const upNextTimer = useRef<number | null>(null)

  // 过渡提示只在「真的在过渡」时说正在过渡；就绪时只做模式提示，其它状态一条都不显示。
  // （此前是只要 AutoMix 开着就常驻一行「自动过渡」，bridge 卡住时还会永远停在过渡态。）
  const automixStatus = useAutoMix((s) => s.status)
  const automixBridging = useAutoMix((s) => s.bridging)
  const automixHint = automixBridging
    ? { text: '正在过渡', hot: true }
    : automixStatus === 'ready'
      ? { text: '自动过渡', hot: false }
      : null

  // 歌词归属校验：store.lyrics 是异步加载的，切歌瞬间它还是上一首的载荷。
  // 不校验 songId 就会出现「标题是 B、歌词滚的是 A」的错位 —— 等新歌词到位再显示。
  const currentSongId = useCurrentSongId()
  const lyricsForCurrent =
    lyrics && currentSongId && lyrics.songId === currentSongId ? lyrics : null

  // 「接下来播放」：队列下一首 + 它的歌词信息（首行预览与行数）。
  // 随机推荐会打开全屏页，这张卡片就是「下一首歌词信息」的展示位。
  const nextItem = playback.queue[playback.index + 1]
  const nextSong = nextItem ? songs[nextItem.songId] : undefined
  const [nextInfo, setNextInfo] = useState<{ preview: string | null; lines: number } | null>(null)

  const lines = useMemo(() => {
    if (!lyricsForCurrent || lyricsForCurrent.kind !== 'synced') return []
    return withDisplayOptions(lyricsForCurrent.lines, settings.showTranslation, settings.showRoman)
  }, [lyricsForCurrent, settings.showTranslation, settings.showRoman])

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
  // 同时驱动「自适应降质」：插件是 4 档阶梯，连续两次低帧降一档、连续八次高帧升一档，
  // 两次变更之间至少隔 10 秒，45–57fps 是死区 —— 不做这套锁存就会在两档之间来回抖。
  useEffect(() => {
    if (!settings.adaptiveQuality && qualityLevel !== 0) {
      aqRef.current = { ...aqRef.current, level: 0, bad: 0, good: 0 }
      setLyricsQualityLevel(0)
    }
  }, [settings.adaptiveQuality, qualityLevel, setLyricsQualityLevel])

  useEffect(() => {
    if (!settings.showFps && !settings.adaptiveQuality) return undefined
    let raf = 0
    let last = performance.now()
    let fpsAcc = 0
    let fpsFrames = 0
    let aqAcc = 0
    let aqFrames = 0
    const step = (level: number, now: number): void => {
      aqRef.current = { level, bad: 0, good: 0, stepAt: now }
      setLyricsQualityLevel(level)
      pushToast(level ? `已自动降低特效（档位 ${level} / 3）` : '已恢复完整特效')
    }
    const loop = (now: number): void => {
      const dt = now - last
      last = now
      fpsAcc += dt
      fpsFrames += 1
      aqAcc += dt
      aqFrames += 1
      if (fpsAcc >= 500) {
        if (settings.showFps) setFps(Math.round((fpsFrames * 1000) / fpsAcc))
        fpsAcc = 0
        fpsFrames = 0
      }
      // 窗口不可见时的 rAF 会被节流，样本必须丢弃，否则「最小化」会被误判成慢机器
      if (document.hidden) {
        aqAcc = 0
        aqFrames = 0
      } else if (settings.adaptiveQuality && aqAcc >= 1000) {
        const fps = (aqFrames * 1000) / aqAcc
        aqAcc = 0
        aqFrames = 0
        const aq = aqRef.current
        if (now - aq.stepAt >= 10000) {
          if (fps < 45) {
            aq.bad += 1
            aq.good = 0
            if (aq.bad >= 2 && aq.level < 3) step(aq.level + 1, now)
          } else if (fps > 57) {
            aq.good += 1
            aq.bad = 0
            if (aq.good >= 8 && aq.level > 0) step(aq.level - 1, now)
          } else {
            aq.bad = 0
            aq.good = 0
          }
        }
      }
      raf = window.requestAnimationFrame(loop)
    }
    raf = window.requestAnimationFrame(loop)
    return () => window.cancelAnimationFrame(raf)
  }, [settings.showFps, settings.adaptiveQuality, setLyricsQualityLevel, pushToast])

  // 关闭条只在挂载时绑定一次。
  // 之前是写在 ref 回调里（内联箭头每次渲染都是新函数 → React 每次渲染都重新挂载 ref），
  // 而播放进度每 100ms 就会触发一次渲染，监听器于是以每秒几十个的速度堆积。
  useEffect(() => {
    if (!mounted) return
    bindClose(closeRef.current)
    // bindClose 只用 el 自身，不依赖任何 props/state
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted])

  // 下一首歌词预览：只取首行文本，主进程有缓存，代价可以忽略。
  useEffect(() => {
    setNextInfo(null)
    if (!open || !nextSong) return undefined
    let alive = true
    void bridge.lyrics(nextSong.id).then((payload) => {
      if (!alive || !payload) return
      const preview =
        payload.kind === 'synced'
          ? (payload.lines.find((l) => l.words.some((w) => w.word.trim()))?.words
              .map((w) => w.word)
              .join('')
              .trim() ?? null)
          : (payload.plain?.split(/\r?\n/).find((l) => l.trim())?.trim() ?? null)
      setNextInfo({ preview, lines: payload.lines.length })
    })
    return () => {
      alive = false
    }
  }, [open, nextSong?.id])

  // 切歌过渡：新背景像墨滴一样从随机一点晕开，同时瞬间加快流体流速（像用手搅动水面），
  // 之后 ease-out 回落到用户设定的速度。
  useEffect(() => {
    const prev = prevArtRef.current
    prevArtRef.current = albumArt
    if (!open || !albumArt || !prev || prev === albumArt) return undefined
    setRipple({ x: 12 + Math.random() * 76, y: 16 + Math.random() * 68, prevArt: prev })
    const base = settings.bgFlowSpeed || 2
    const setFlow = (speed: number): void => {
      const renderer = bgRef.current?.bgRender as { setFlowSpeed?: (value: number) => void } | undefined
      renderer?.setFlowSpeed?.(speed)
    }
    const started = performance.now()
    let raf = 0
    const stir = (): void => {
      const t = Math.min(1, (performance.now() - started) / 1900)
      // 起始约 2.4 倍速，二次缓出回到原速：先急搅，再让水面慢慢平静
      setFlow(base * (1 + 1.4 * (1 - t) * (1 - t)))
      if (t < 1) raf = window.requestAnimationFrame(stir)
      else setFlow(base)
    }
    stir()
    const timer = window.setTimeout(() => setRipple(null), 1500)
    return () => {
      window.cancelAnimationFrame(raf)
      window.clearTimeout(timer)
      setFlow(base)
    }
  }, [albumArt, open, settings.bgFlowSpeed])

  // 「接下来播放」：随机推荐进来时只亮 10 秒就收起，把舞台还给歌词；
  // 鼠标移入立刻召回，移出后重新开始倒计时。
  const armUpNextHide = (): void => {
    if (upNextTimer.current !== null) window.clearTimeout(upNextTimer.current)
    upNextTimer.current = null
    if (!fsRandomHint) return
    upNextTimer.current = window.setTimeout(() => setUpNextHidden(true), 10000)
  }
  useEffect(() => {
    setUpNextHidden(false)
    armUpNextHide()
    return () => {
      if (upNextTimer.current !== null) window.clearTimeout(upNextTimer.current)
      upNextTimer.current = null
    }
    // armUpNextHide 只依赖 fsRandomHint，随本 effect 一起重建即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fsRandomHint, nextSong?.id, open])

  const seekFrom = (clientX: number): void => {
    const el = trackRef.current
    if (!el || duration <= 0) return
    const rect = el.getBoundingClientRect()
    seek(Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * duration)
  }

  // 与插件 aqFactors() 同一张阶梯：档位只乘在用户设定值上，不会把「静态」解冻，
  // 也不会突破性能模式自己设的天花板。
  const aq =
    qualityLevel >= 3
      ? { fps: 0.35, scale: 0.6, lyricLite: true }
      : qualityLevel === 2
        ? { fps: 0.35, scale: 0.6, lyricLite: false }
        : qualityLevel === 1
          ? { fps: 0.6, scale: 0.8, lyricLite: false }
          : { fps: 1, scale: 1, lyricLite: false }
  const bgPerf = settings.bgPerf
  const baseFps = settings.bgFps > 0 ? settings.bgFps : 30
  const effectiveFps = Math.max(8, Math.round((bgPerf ? Math.min(baseFps, 24) : baseFps) * aq.fps))
  const effectiveScale = Math.max(
    0.2,
    Math.min(1, (bgPerf ? Math.min(settings.bgRenderScale, 0.35) : settings.bgRenderScale) * aq.scale)
  )
  // 性能模式与最低档都关掉逐行的模糊/缩放遮罩：这是集成显卡上最后一块可省的开销
  const lyricLite = bgPerf || aq.lyricLite

  // 切歌扩散：把「墨滴落点」以 CSS 变量传给 mask 动画
  const rippleClass = ripple ? ` ${styles.fsRipple}` : ''
  const rippleStyle = ripple
    ? ({ '--ripple-x': `${ripple.x}%`, '--ripple-y': `${ripple.y}%` } as CSSProperties)
    : undefined

  return (
    <div
      className={`${styles.fullscreen} ${open ? styles.fullscreenOpen : ''} ${hasLyrics ? '' : styles.fsNoLyric}`}
      aria-hidden={!open}
      // 关闭态整页不可聚焦：否则 Tab 或残留焦点会把「停在视口外」的按钮滚进视野，
      // 连带把整个浮动层（含顶栏）顶出屏幕。
      inert={!open}
      onContextMenu={(event) => {
        // 整页右键菜单；命中歌词行时由行处理器先 stopPropagation
        if (!open) return
        event.preventDefault()
        setLyricsMenu({ x: event.clientX, y: event.clientY, kind: 'page' })
      }}
    >
      {/* 上一首的背景垫底：墨滴扩散期间它被新画面一点点吃掉，动画结束就卸载 */}
      {ripple && (
        <div
          className={styles.fsBgPrev}
          style={{
            backgroundImage: `url(${ripple.prevArt})`,
            filter: `blur(${Math.max(24, settings.bgBlur)}px) saturate(${settings.bgSaturate}) brightness(${settings.bgBrightness})`
          }}
        />
      )}
      {mounted && song && albumArt && settings.bgEnabled && settings.bgType === 'flow' ? (
        <div
          className={`${styles.fsBg}${rippleClass}`}
          style={{ ...rippleStyle, filter: `saturate(${settings.bgSaturate}) brightness(${settings.bgBrightness})` }}
        >
          <BackgroundRender
            ref={bgRef}
            album={albumArt}
            playing={playback.playing}
            fps={effectiveFps}
            flowSpeed={settings.bgFlowSpeed}
            hasLyric={hasLyrics}
            renderScale={effectiveScale}
            staticMode={settings.bgPerf || settings.bgFps === 0}
            style={{ width: '100%', height: '100%' }}
          />
        </div>
      ) : mounted && song && albumArt && settings.bgEnabled && settings.bgType === 'blur' ? (
        <div
          className={`${styles.fsBg}${rippleClass}`}
          style={{
            ...rippleStyle,
            backgroundImage: `url(${albumArt})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            filter: `blur(${settings.bgBlur}px) saturate(${settings.bgSaturate}) brightness(${settings.bgBrightness})`
          }}
        />
      ) : (
        <div
          className={`${styles.fsBg}${rippleClass}`}
          style={{ ...rippleStyle, background: 'linear-gradient(150deg,#3a3a3f,#111113)' }}
        />
      )}
      <div className={styles.fsTint} />
      <div className={styles.fsVignette} />

      {mounted && (
        <div className={styles.fsStage}>
          {/* 接下来播放：右栏顶部悬浮卡片。放 fsStage 直接子级而不是 fsLyric 里，
              因为 fsLyric 的上下 mask 渐隐会把卡片一起隐掉。 */}
          {nextSong && (
            <div className={styles.fsUpNextZone}>
              <button
                type="button"
                className={`${styles.fsUpNext} ${upNextHidden ? styles.fsUpNextHidden : ''}`}
                onClick={() => useStore.getState().jumpToQueueIndex(playback.index + 1)}
                onMouseEnter={() => {
                  setUpNextHidden(false)
                  if (upNextTimer.current !== null) window.clearTimeout(upNextTimer.current)
                  upNextTimer.current = null
                }}
                onMouseLeave={armUpNextHide}
                title="跳到下一首"
              >
              <Cover coverId={nextSong.coverId} size={80} display={34} radius={8} alt={nextSong.title} />
              <span className={styles.fsUpNextText}>
                <span className={styles.fsUpNextLabel}>接下来播放</span>
                <span className={`${styles.fsUpNextTitle} ellipsis`}>{nextSong.title}</span>
                <span className={`${styles.fsUpNextMeta} ellipsis`}>
                  {nextSong.artists.join('、')}
                  {nextInfo?.preview
                    ? ` · ${nextInfo.preview}`
                    : nextInfo && nextInfo.lines > 0
                      ? ' · 歌词已就绪'
                      : ''}
                </span>
              </span>
                <Icon name="next" size={14} className={styles.fsUpNextIcon} />
              </button>
            </div>
          )}
          <div className={styles.fsLeft}>
            <button
              type="button"
              className={styles.fsClose}
              ref={closeRef}
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
                  onClick={(event) => {
                    event.stopPropagation()
                    const rect = event.currentTarget.getBoundingClientRect()
                    setLyricsMenu({
                      x: Math.max(8, rect.right - 240),
                      y: rect.bottom + 6,
                      kind: 'page'
                    })
                  }}
                  title="更多"
                >
                  <Icon name="more" size={18} />
                </button>
              </div>

              {/* AutoMix 状态提示：只有「真在过渡」和「已就绪」两种状态才出现 */}
              {settings.automix.enabled && automixHint && (
                <div className={styles.fsAutomixHint} aria-hidden="true">
                  <span
                    className={`${styles.fsAutomixHintText} ${automixHint.hot ? styles.fsAutomixHintHot : ''}`}
                  >
                    {automixHint.text}
                  </span>
                </div>
              )}

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
                <button
                  type="button"
                  className={styles.fsVicon}
                  onClick={toggleMute}
                  title={playback.muted || playback.volume <= 0.001 ? '取消静音' : '静音'}
                >
                  <Icon
                    name={playback.muted || playback.volume <= 0.001 ? 'volumeOff' : 'volumeLow'}
                    size={16}
                  />
                </button>
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

          <div
            className={styles.fsLyric}
            onContextMenu={(event) => {
              // 行菜单：命中 AMLL 的行包裹层才截获，否则让它冒泡到整页菜单
              const target = event.target as HTMLElement | null
              const wrapper = target?.closest('[class*="lyricLineWrapper"]')
              if (!wrapper) return
              const text = (wrapper.textContent ?? '').trim()
              // 间奏/空行没有可复制的文本：不拦截，交给整页菜单
              if (!text) return
              event.preventDefault()
              event.stopPropagation()
              const flat = (value: string): string => value.replace(/\s+/g, '')
              const found = lines.find((line) => {
                const main = flat(line.words.map((word) => word.word).join(''))
                return main.length > 0 && flat(text).startsWith(main)
              })
              const sub = found
                ? [found.translatedLyric, found.romanLyric].filter(Boolean).join(' / ')
                : ''
              setLyricsMenu({ x: event.clientX, y: event.clientY, kind: 'line', text, sub })
            }}
          >
            <LyricsView
              lines={lines}
              playing={playback.playing}
              offsetMs={settings.lyricOffsetMs}
              fontSize={lyricFontSize}
              weight={settings.lyricWeight}
              highlight={settings.lyricHighlight}
              blur={lyricLite ? false : settings.lyricBlur}
              scale={lyricLite ? false : settings.lyricScale}
              wordFade={settings.wordFade}
              hidePassed={settings.hidePassed}
              clickSeek={settings.lyricClickSeek}
              fontFamily={
                settings.lyricFont === 'pingfang'
                  ? '"SA PingFang","PingFang SC","PingFang SC Regular","Microsoft YaHei",system-ui,sans-serif'
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
