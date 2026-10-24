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
  alignAnchor?: 'top' | 'bottom' | 'center'
  alignPosition?: number
  onSeek: (seconds: number) => void
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
  alignAnchor = 'center',
  alignPosition = 0.42,
  onSeek,
  className,
  color,
  bottomPadding
}: Props): JSX.Element {
  const ref = useRef<{ lyricPlayer?: { setCurrentTime(time: number, isSeek?: boolean): void } } | null>(null)
  const offsetRef = useRef(offsetMs)
  offsetRef.current = offsetMs

  const frozen = useMemo(() => lines, [lines])

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
      enableSpring
      enableBlur
      enableScale
      wordFadeWidth={0.6}
      style={
        {
          '--amll-lp-font-size': `${fontSize}px`,
          '--amll-lp-color': color ?? 'var(--text-primary)',
          // 高光亮度由 AMLL 的渐变 mask 读取；字重直接继承到每一行
          '--amll-word-bright': String(highlight),
          fontWeight: weight,
          width: '100%',
          height: '100%',
          paddingBottom: bottomPadding ? `${bottomPadding}px` : undefined
        } as React.CSSProperties
      }
      onLyricLineClick={(event) => {
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
