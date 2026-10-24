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
              ? 'linear-gradient(160deg,#2a2a2e,#131315)'
              : 'linear-gradient(160deg,#3a3a40,#141416)'
          }}
        />
      )}
      {mounted && song && albumArt && quality !== 'off' && (
        <div className={styles.lyricsBg}>
          <BackgroundRender
            album={albumArt ?? undefined}
            playing={playback.playing}
            fps={fps}
            flowSpeed={1.6}
            hasLyric={lines.length > 0}
            renderScale={quality === 'high' ? 0.75 : 0.5}
            staticMode={quality === 'low'}
            style={{ width: '100%', height: '100%' }}
          />
        </div>
      )}
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
