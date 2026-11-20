import { useEffect, useMemo, useRef, type JSX } from 'react'
import { LyricPlayer } from '@applemusic-like-lyrics/react'
import type { LyricLine } from '@applemusic-like-lyrics/lyric'
import { Icon } from '../components/Icon'
import { useStore } from '../state/store'
import styles from './NetMusicView.module.css'

/**
 * 「网络音乐」= 汽水音乐的歌词界面。
 * 版式对齐 PM 自己的全屏歌词页：封面模糊当背景、歌词铺满、底部一条控制栏。
 * Pinnet 不解码、不播放汽水音频，所有控制都转发给插件执行。
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
  const cover = net.track?.coverUrl ?? null

  return (
    <div className={styles.stage}>
      {cover && (
        <img
          className={styles.bg}
          src={cover}
          alt=""
          aria-hidden="true"
          draggable={false}
          referrerPolicy="no-referrer"
        />
      )}
      <div className={styles.veil} aria-hidden="true" />

      <div className={styles.content}>
        <div className={styles.head}>
          <div className={styles.meta}>
            <div className={styles.title}>{net.track?.title ?? '没有在播放的歌曲'}</div>
            <div className={styles.sub}>
              {net.track?.artists ?? (connected ? '在汽水音乐里播放一首' : '等待汽水音乐插件连接')}
              {connected ? '' : ' · 未连接'}
            </div>
          </div>
          {!connected && <div className={styles.badge}>未连接</div>}
        </div>

        <div className={styles.lyrics}>
          {lines.length > 0 ? (
            <div className={styles.lyricWrap}>
              <LyricPlayer
                ref={playerRef as never}
                lyricLines={lines}
                playing={net.playing && connected}
                alignAnchor="center"
                alignPosition={0.5}
                enableSpring
                enableBlur
                enableScale
                style={{ '--amll-lp-font-size': '34px', '--amll-lp-color': '#fff' } as never}
              />
            </div>
          ) : (
            <div className={styles.empty}>
              {connected ? (net.track ? '这首歌没有歌词' : '在汽水音乐里播放一首歌') : '连上汽水音乐后，歌词会显示在这里'}
            </div>
          )}
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
      </div>
    </div>
  )
}

const fmt = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
