import { useEffect, useMemo, useRef, type JSX } from 'react'
import { LyricPlayer } from '@applemusic-like-lyrics/react'
import type { LyricLine } from '@applemusic-like-lyrics/lyric'
import { Icon } from '../components/Icon'
import { useStore } from '../state/store'
import viewStyles from '../components/views.module.css'
import styles from './NetMusicView.module.css'

/**
 * 「网络音乐」页：把汽水音乐通过插件送来的封面/歌词/进度画出来，
 * 控制指令回给插件执行（PM 本身不解码、不播放汽水音频）。
 */
export function NetMusicView(): JSX.Element {
  const net = useStore((s) => s.netMusic)
  const netStatus = useStore((s) => s.netStatus)
  const connected = netStatus.connected
  const playerRef = useRef<{ lyricPlayer?: { setCurrentTime: (ms: number, jump?: boolean) => void } } | null>(null)
  const lastRef = useRef(-1)

  const lines = useMemo(() => (net.lyrics ?? []) as unknown as LyricLine[], [net.lyrics])

  // 本地插值：心跳 1.5s 一次，歌词靠 rAF 自己推进（和本地歌词页同一套）
  useEffect(() => {
    let raf = 0
    const loop = (): void => {
      const st = useStore.getState().netMusic
      const live = st.playing ? st.basePositionMs + (performance.now() - st.baseAt) : st.basePositionMs
      const ms = Math.max(0, Math.min(st.durationMs || live, live))
      const player = playerRef.current?.lyricPlayer
      if (player) {
        const jump = lastRef.current < 0 || Math.abs(ms - lastRef.current) > 900
        player.setCurrentTime(Math.round(ms), jump)
        lastRef.current = ms
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  const send = (value: unknown): void => {
    void window.lm.invoke('netmusic/command', value)
  }

  const total = net.durationMs || 0
  const live = net.playing ? net.basePositionMs + (performance.now() - net.baseAt) : net.basePositionMs

  return (
    <div className={viewStyles.page}>
      <div className={styles.head}>
        <div className={styles.title}>网络音乐</div>
        <div className={styles.sub}>
          {connected
            ? `已连接汽水音乐${netStatus.pluginVersion ? ' · 插件 ' + netStatus.pluginVersion : ''}`
            : '等待汽水音乐插件连接（在插件设置里点「在 Pinnet 里播放」）'}
        </div>
      </div>

      <div className={styles.stage}>
        <div className={styles.left}>
          <div className={styles.coverWrap}>
            {net.track?.coverUrl ? (
              <img className={styles.cover} src={net.track.coverUrl} alt="" draggable={false} />
            ) : (
              <div className={styles.coverEmpty}>
                <Icon name="music" size={34} />
              </div>
            )}
          </div>
          <div className={styles.metaTitle}>{net.track?.title ?? '没有在播放的歌曲'}</div>
          <div className={styles.metaSub}>{net.track?.artists ?? (connected ? '在汽水音乐里播放一首' : '未连接')}</div>
        </div>

        <div className={styles.right}>
          {net.lyrics.length > 0 ? (
            <LyricPlayer
              ref={playerRef as never}
              lyricLines={lines}
              playing={net.playing && connected}
              alignAnchor="center"
              alignPosition={0.42}
              enableSpring
              enableBlur
              enableScale
              style={{ '--amll-lp-font-size': '26px', '--amll-lp-color': 'var(--text-primary)' } as never}
            />
          ) : (
            <div className={styles.noLyric}>{connected ? '这首歌没有歌词' : '连上汽水音乐后，歌词会显示在这里'}</div>
          )}
        </div>
      </div>

      <div className={styles.controls}>
        <button type="button" className={styles.ctrlBtn} onClick={() => send({ type: 'prev' })} title="上一首">
          <Icon name="prev" size={16} />
        </button>
        <button
          type="button"
          className={`${styles.ctrlBtn} ${styles.ctrlMain}`}
          onClick={() => send({ type: 'toggle' })}
          title={net.playing ? '暂停' : '播放'}
        >
          <Icon name={net.playing ? 'pause' : 'play'} size={18} />
        </button>
        <button type="button" className={styles.ctrlBtn} onClick={() => send({ type: 'next' })} title="下一首">
          <Icon name="next" size={16} />
        </button>

        <div className={styles.progress}>
          <span className={styles.time}>{fmt(live)}</span>
          <input
            type="range"
            min={0}
            max={Math.max(1, total)}
            value={Math.round(live)}
            className={styles.slider}
            onChange={(event) => send({ type: 'seek', value: Number(event.target.value) })}
            aria-label="进度"
          />
          <span className={styles.time}>{fmt(total)}</span>
        </div>

        <div className={styles.volume}>
          <Icon name="waveform" size={14} />
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round((net.volume ?? 1) * 100)}
            className={styles.slider}
            onChange={(event) => send({ type: 'volume', value: Number(event.target.value) / 100 })}
            aria-label="音量"
          />
        </div>
      </div>

      {!connected && (
        <div className={styles.hint}>
          打开汽水音乐 → 插件设置（右下角按钮）→ 点「在 Pinnet 里播放」。端口 {17891}，token 见设置页。
        </div>
      )}
    </div>
  )
}

const fmt = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
