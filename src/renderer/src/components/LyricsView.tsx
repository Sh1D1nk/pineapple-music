import { useEffect, useMemo, useRef, type JSX } from 'react'
import { LyricPlayer } from '@applemusic-like-lyrics/react'
import type { LyricLine } from '@applemusic-like-lyrics/lyric'
import { engine } from '../audio/engine'

interface Props {
  lines: LyricLine[]
  playing: boolean
  offsetMs: number
  fontSize: number
  weight?: number
  highlight?: number
  blur?: boolean
  scale?: boolean
  wordFade?: number
  hidePassed?: boolean
  fontFamily?: string
  alignAnchor?: 'top' | 'bottom' | 'center'
  alignPosition?: number
  onSeek: (seconds: number) => void
  clickSeek?: boolean
  className?: string
  color?: string
  bottomPadding?: number
}

/**
 * AMLL's player takes the plain time as a prop, which would re-render the whole subtree at 60 fps.
 * Driving `setCurrentTime` through the ref instead keeps React out of the frame loop entirely.
 */
export function LyricsView({
  lines,
  playing,
  offsetMs,
  fontSize,
  weight = 600,
  highlight = 1,
  blur = true,
  scale = true,
  wordFade = 0.6,
  hidePassed = false,
  fontFamily,
  alignAnchor = 'center',
  alignPosition = 0.42,
  onSeek,
  clickSeek = true,
  className,
  color,
  bottomPadding
}: Props): JSX.Element {
  const ref = useRef<{ lyricPlayer?: { setCurrentTime(time: number, isSeek?: boolean): void } } | null>(null)
  const offsetRef = useRef(offsetMs)
  offsetRef.current = offsetMs

  const frozen = useMemo(() => lines, [lines])

  // AMLL 的「隐藏已播放歌词」是播放器实例上的开关，props 变化时同步一次
  useEffect(() => {
    const player = ref.current?.lyricPlayer as unknown as {
      setHidePassedLines?: (value: boolean) => void
    }
    player?.setHidePassedLines?.(hidePassed)
  }, [hidePassed])

  useEffect(() => {
    let raf = 0
    let last = -1
    const loop = (): void => {
      const player = ref.current?.lyricPlayer
      if (player) {
        const seconds = engine.snapshot().position
        const time = Math.max(0, Math.round((seconds + offsetRef.current / 1000) * 1000))
        const jump = last < 0 || Math.abs(time - last) > 900
        player.setCurrentTime(time, jump)
        last = time
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <LyricPlayer
      ref={ref as never}
      className={className}
      lyricLines={frozen}
      playing={playing}
      alignAnchor={alignAnchor}
      alignPosition={alignPosition}
      enableSpring={!hidePassed ? true : true}
      enableBlur={blur}
      enableScale={scale}
      wordFadeWidth={wordFade}
      style={
        {
          '--amll-lp-font-size': `${fontSize}px`,
          '--amll-lp-color': color ?? 'var(--text-primary)',
          // 高光亮度由 AMLL 的渐变 mask 读取；字重直接继承到每一行
          '--amll-word-bright': String(highlight),
          fontWeight: weight,
          fontFamily: fontFamily,
          width: '100%',
          height: '100%',
          paddingBottom: bottomPadding ? `${bottomPadding}px` : undefined
        } as React.CSSProperties
      }
      onLyricLineClick={(event) => {
        if (!clickSeek) return
        const line = frozen[event.lineIndex]
        if (line) onSeek(line.startTime / 1000)
      }}
    />
  )
}

export function withDisplayOptions(
  lines: { translatedLyric: string; romanLyric: string }[],
  showTranslation: boolean,
  showRoman: boolean
): LyricLine[] {
  return lines.map((line) => ({
    ...line,
    translatedLyric: showTranslation ? line.translatedLyric : '',
    romanLyric: showRoman ? line.romanLyric : ''
  })) as LyricLine[]
}
