import { useEffect, useMemo, useState, type JSX } from 'react'
import { BackgroundRender } from '@applemusic-like-lyrics/react'
import { useStore } from '../state/store'
import { coverUrl } from '../bridge'
import { Cover } from './Cover'
import { LyricsView, withDisplayOptions } from './LyricsView'
import { engine } from '../audio/engine'
import styles from './overlays.module.css'

export function LyricsPanel(): JSX.Element {
  const open = useStore((s) => s.lyricsOpen)
  const lyrics = useStore((s) => s.lyrics)
  const settings = useStore((s) => s.settings)
  const playback = useStore((s) => s.playback)
  const songs = useStore((s) => s.songs)
  const seek = useStore((s) => s.seek)

  // Keep the tree mounted through the slide-out, then unmount: AMLL's background renderer keeps
  // drawing at 60 fps and would otherwise burn GPU while the panel is off screen.
  const [mounted, setMounted] = useState(open)
  useEffect(() => {
    if (open) {
      setMounted(true)
      return undefined
    }
    const timer = window.setTimeout(() => setMounted(false), 360)
    return () => window.clearTimeout(timer)
  }, [open])

  const song = songs[playback.queue[playback.index]?.songId ?? '']
  const albumArt = coverUrl(song?.coverId ?? null, 640)

  const lines = useMemo(() => {
    if (!lyrics || lyrics.kind !== 'synced') return []
    return withDisplayOptions(lyrics.lines, settings.showTranslation, settings.showRoman)
  }, [lyrics, settings.showTranslation, settings.showRoman])

  const quality = settings.backgroundQuality
  const fps = quality === 'high' ? 60 : quality === 'medium' ? 30 : 24
  // 封面只能用「被压暗的氛围底」的身份存在：亮度/饱和度走用户设置，再叠一层渐变压暗。
  // 这两条与全屏页的 fsBg + fsTint 同一套数值，面板此前两者皆无，于是整块面板看着就是一张封面。
  const bgFilter = `saturate(${settings.bgSaturate}) brightness(${settings.bgBrightness})`
  const showFlowBg = settings.bgEnabled && settings.bgType === 'flow' && quality !== 'off'

  return (
    <div
      className={`${styles.panel} ${styles.lyricsPanel} ${open ? styles.panelOpen : ''}`}
      aria-hidden={!open}
      style={{ pointerEvents: open ? 'auto' : 'none' }}
    >
      {mounted && (
        <div
          className={styles.lyricsBg}
          style={{
            background: albumArt
              ? 'linear-gradient(160deg,#1e1e22,#0e0e10)'
              : 'linear-gradient(160deg,#26262a,#0d0d0f)'
          }}
        />
      )}
      {mounted && song && albumArt && showFlowBg && (
        <div className={styles.lyricsBg} style={{ '--lyrics-bg-filter': bgFilter } as React.CSSProperties}>
          <BackgroundRender
            album={albumArt ?? undefined}
            playing={playback.playing}
            fps={fps}
            flowSpeed={settings.bgFlowSpeed}
            hasLyric={lines.length > 0}
            renderScale={quality === 'high' ? 0.75 : 0.5}
            staticMode={quality === 'low'}
            style={{ width: '100%', height: '100%' }}
          />
        </div>
      )}
      {mounted && song && albumArt && settings.bgEnabled && settings.bgType === 'blur' && (
        <div
          className={`${styles.lyricsBg} ${styles.lyricsBgBlur}`}
          style={{
            backgroundImage: `url(${albumArt})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            filter: `blur(${Math.round(settings.bgBlur / 2)}px) ${bgFilter}`
          }}
        />
      )}
      {mounted && <div className={styles.lyricsTint} aria-hidden="true" />}
      {mounted && (
      <div className={styles.lyricsContent}>
        <div className={styles.lyricsHeader}>
          <Cover coverId={song?.coverId ?? null} size={80} display={40} radius={10} alt="" />
          <div className={styles.lyricsHeaderText}>
            <div className={`${styles.lyricsHeaderTitle} ellipsis`}>{song?.title ?? '未在播放'}</div>
            <div className={`${styles.lyricsHeaderArtist} ellipsis`}>{song?.artists.join('、') ?? ''}</div>
          </div>
        </div>

        <div className={styles.lyricsBody}>
          {lyrics && lyrics.kind === 'synced' && lines.length > 0 ? (
            <LyricsView
              lines={lines}
              playing={playback.playing}
              offsetMs={settings.lyricOffsetMs}
              fontSize={28 * settings.lyricFontScale}
              weight={settings.lyricWeight}
              highlight={settings.lyricHighlight}
              blur={settings.lyricBlur}
              scale={settings.lyricScale}
              wordFade={settings.wordFade}
              hidePassed={settings.hidePassed}
              fontFamily={
                settings.lyricFont === 'pingfang'
                  ? '"PingFang SC","Microsoft YaHei",system-ui,sans-serif'
                  : 'system-ui,"Segoe UI",sans-serif'
              }
              alignPosition={0.5}
              onSeek={(seconds) => seek(seconds)}
              color="#ffffff"
            />
          ) : lyrics && lyrics.kind === 'plain' && lyrics.plain ? (
            <div
              style={{
                height: '100%',
                overflowY: 'auto',
                color: 'rgba(255,255,255,.86)',
                fontSize: 15,
                lineHeight: 2,
                whiteSpace: 'pre-wrap',
                padding: '0 8px'
              }}
            >
              {lyrics.plain}
            </div>
          ) : (
            <div className={styles.lyricsEmpty}>
              <div style={{ fontSize: 15, fontWeight: 600, color: '#fff' }}>暂无歌词</div>
              <div>把同名 .lrc 文件放在歌曲旁边即可自动加载</div>
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  )
}

export function currentRateLabel(): string | null {
  const rate = engine.currentRate()
  if (Math.abs(rate - 1) < 0.002) return null
  return `${rate > 1 ? '+' : ''}${((rate - 1) * 100).toFixed(1)}%`
}
