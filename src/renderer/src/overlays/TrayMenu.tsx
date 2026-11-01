import { useEffect, useRef, useState, type JSX } from 'react'
import { loadHyalite } from '../glass/hyalite'
import { Icon } from '../components/Icon'
import styles from './overlay.module.css'

interface TrayState {
  playing: boolean
  hasTrack: boolean
  title: string
  artist: string
  volume: number
}

const EMPTY: TrayState = { playing: false, hasTrack: false, title: '', artist: '', volume: 1 }

/**
 * 托盘菜单（无边框透明窗口 + 液态玻璃）。
 * 左键/右键托盘图标都由主进程打开这同一个窗口；命令经 IPC 回主进程再转发给主窗口。
 */
export function TrayMenu({ dark }: { dark: boolean }): JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<TrayState>(EMPTY)
  const [volume, setVolume] = useState(1)

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    let disposed = false
    let detach: (() => void) | null = null
    void loadHyalite().then((api) => {
      const el = cardRef.current
      if (disposed || !api || !el) return
      api.attach(el, {
        bevel: 18,
        thickness: 30,
        dispersion: 1.2,
        blur: 2,
        slope: 2.4,
        sat: 0.95,
        shade: 0.28,
        rim: 1.5,
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

  return (
    <div className={styles.shell}>
      <div ref={cardRef} className={styles.card}>
        <div className={styles.menuHead}>
          <div className={styles.artFallback}>♫</div>
          <div className={styles.meta}>
            <div className={styles.menuTitle}>{state.hasTrack ? state.title : '没有在播放的歌曲'}</div>
            <div className={styles.menuSub}>
              {state.hasTrack ? `${state.playing ? '正在播放' : '已暂停'}${state.artist ? ' · ' + state.artist : ''}` : '播放一首试试'}
            </div>
          </div>
        </div>

        <div className={styles.transport}>
          <button type="button" className={styles.transportBtn} onClick={() => command('previous')} title="上一首">
            <Icon name="prev" size={17} />
          </button>
          <button
            type="button"
            className={`${styles.transportBtn} ${styles.transportMain}`}
            onClick={() => command('toggle')}
            title={state.playing ? '暂停' : '播放'}
          >
            <Icon name={state.playing ? 'pause' : 'play'} size={19} />
          </button>
          <button type="button" className={styles.transportBtn} onClick={() => command('next')} title="下一首">
            <Icon name="next" size={17} />
          </button>
        </div>

        <div className={styles.volumeRow}>
          <span className={styles.volumeIcon} aria-hidden="true">
            🔊
          </span>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(volume * 100)}
            className={styles.slider}
            onChange={(event) => {
              const next = Number(event.target.value) / 100
              setVolume(next)
              command({ type: 'volume', value: next })
            }}
          />
        </div>

        <div className={styles.menuFoot}>
          <button type="button" className={styles.footItem} onClick={() => command('open-main')}>
            <span>打开 Pineapple Music</span>
            <Icon name="external" size={13} />
          </button>
          <button type="button" className={styles.footItem} data-danger="true" onClick={() => command('quit')}>
            <span>退出</span>
          </button>
        </div>
      </div>
    </div>
  )
}
