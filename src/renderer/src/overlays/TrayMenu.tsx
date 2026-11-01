import { useEffect, useRef, useState, type JSX } from 'react'
import { loadHyalite } from '../glass/hyalite'
import { coverUrl } from '../bridge'
import { Icon } from '../components/Icon'
import styles from './overlay.module.css'

interface TrayState {
  playing: boolean
  hasTrack: boolean
  title: string
  artist: string
  volume: number
  coverId?: string | null
}

const EMPTY: TrayState = { playing: false, hasTrack: false, title: '', artist: '', volume: 1, coverId: null }

const VolumeGlyph = (): JSX.Element => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
    <path d="M2.2 6h2.4L8 3.1v9.8L4.6 10H2.2z" fill="currentColor" stroke="none" />
    <path d="M10.6 5.6a3.4 3.4 0 0 1 0 4.8" />
    <path d="M12.4 4a6 6 0 0 1 0 8" opacity="0.6" />
  </svg>
)

const PowerGlyph = (): JSX.Element => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
    <path d="M8 2.6v5.2" />
    <path d="M4.7 4.9a4.8 4.8 0 1 0 6.6 0" />
  </svg>
)

const NoteGlyph = (): JSX.Element => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <path d="M6.2 11.4V4.3l5.6-1.2v7" opacity="0.9" />
    <circle cx="4.6" cy="11.7" r="1.7" />
    <circle cx="10.2" cy="10.4" r="1.7" />
  </svg>
)

/**
 * 托盘菜单（258×296，无边框透明窗口 + 液态玻璃）。
 * 版式按 Apple Music 的菜单来：行式条目、细分隔线、无大色块、无表情图标。
 */
export function TrayMenu({ dark }: { dark: boolean }): JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<TrayState>(EMPTY)
  const [volume, setVolume] = useState(1)

  useEffect(() => {
    document.documentElement.dataset.overlay = '1'
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    let disposed = false
    let detach: (() => void) | null = null
    void loadHyalite().then((api) => {
      const el = cardRef.current
      if (disposed || !api || !el) return
      api.attach(el, {
        bevel: 16,
        thickness: 28,
        dispersion: 1,
        blur: 2,
        slope: 2.4,
        sat: 0.95,
        shade: 0.26,
        rim: 1.4,
        edgeW: 5,
        light: -140,
        materialize: 140
      })
      detach = () => {
        try {
          api.detach(el)
        } catch {
          /* ignore */
        }
        el.style.removeProperty('--hyalite')
        el.style.removeProperty('--hyalite-edge')
      }
    })
    return () => {
      disposed = true
      detach?.()
      delete document.documentElement.dataset.overlay
    }
  }, [dark])

  useEffect(() => {
    const off = window.lm.on('overlay/tray-state', ((next: TrayState) => {
      setState(next)
      setVolume(next.volume)
    }) as never)
    return off
  }, [])

  const command = (value: string | { type: 'volume'; value: number }): void => {
    window.lm.send('overlay/tray-command', value)
  }

  const art = coverUrl(state.coverId ?? null, 80)

  return (
    <div className={styles.shell}>
      <div ref={cardRef} className={`${styles.card} ${styles.menu}`}>
        <div className={styles.menuHead}>
          {art ? (
            <img className={styles.art} src={art} alt="" draggable={false} />
          ) : (
            <div className={styles.artFallback}>
              <NoteGlyph />
            </div>
          )}
          <div className={styles.meta}>
            <div className={styles.menuTitle}>{state.hasTrack ? state.title : '未在播放'}</div>
            <div className={styles.menuSub}>
              {state.hasTrack ? (state.playing ? '正在播放' : '已暂停') + (state.artist ? ' · ' + state.artist : '') : '选择一首歌开始'}
            </div>
          </div>
        </div>

        <button type="button" className={styles.row} onClick={() => command('previous')}>
          <span className={styles.rowIcon}>
            <Icon name="prev" size={13} />
          </span>
          <span className={styles.rowLabel}>上一首</span>
        </button>
        <button type="button" className={styles.row} onClick={() => command('toggle')}>
          <span className={styles.rowIcon}>
            <Icon name={state.playing ? 'pause' : 'play'} size={13} />
          </span>
          <span className={styles.rowLabel}>{state.playing ? '暂停' : '播放'}</span>
        </button>
        <button type="button" className={styles.row} onClick={() => command('next')}>
          <span className={styles.rowIcon}>
            <Icon name="next" size={13} />
          </span>
          <span className={styles.rowLabel}>下一首</span>
        </button>

        <div className={styles.divider} />

        <div className={styles.volumeRow}>
          <span className={styles.volumeIcon}>
            <VolumeGlyph />
          </span>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(volume * 100)}
            className={styles.slider}
            aria-label="音量"
            onChange={(event) => {
              const next = Number(event.target.value) / 100
              setVolume(next)
              command({ type: 'volume', value: next })
            }}
          />
        </div>

        <div className={styles.divider} />

        <button type="button" className={styles.row} onClick={() => command('open-main')}>
          <span className={styles.rowIcon}>
            <Icon name="expand" size={13} />
          </span>
          <span className={styles.rowLabel}>打开 Pineapple Music</span>
        </button>
        <button type="button" className={`${styles.row} ${styles.rowDanger}`} onClick={() => command('quit')}>
          <span className={styles.rowIcon}>
            <PowerGlyph />
          </span>
          <span className={styles.rowLabel}>退出</span>
        </button>
      </div>
    </div>
  )
}
