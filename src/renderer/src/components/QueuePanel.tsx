import { useState, type JSX } from 'react'
import { useStore } from '../state/store'
import { Cover } from './Cover'
import { Icon } from './Icon'
import { formatTime } from '../lib/format'
import { useAutoMix } from '../audio/automix'
import styles from './overlays.module.css'

export function QueuePanel(): JSX.Element {
  const open = useStore((s) => s.queueOpen)
  const queue = useStore((s) => s.playback.queue)
  const index = useStore((s) => s.playback.index)
  const history = useStore((s) => s.playback.history)
  const songs = useStore((s) => s.songs)
  const removeFromQueue = useStore((s) => s.removeFromQueue)
  const moveInQueue = useStore((s) => s.moveInQueue)
  const clearQueue = useStore((s) => s.clearQueue)
  const jumpToQueueIndex = useStore((s) => s.jumpToQueueIndex)
  const automixNext = useAutoMix((s) => s.nextSongId)
  const automixStatus = useAutoMix((s) => s.status)

  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)

  const current = queue[index]
  const upcoming = queue.slice(index + 1)

  return (
    <div
      className={`glass glassLite ${styles.panel} ${open ? styles.panelOpen : ''}`}
      aria-hidden={!open}
      inert={!open}
      style={{ pointerEvents: open ? 'auto' : 'none' }}
    >
      <div className={styles.panelHeader}>
        <div className={styles.panelTitle}>待播清单</div>
        <button type="button" className={styles.textButton} onClick={clearQueue}>
          清除
        </button>
      </div>

      <div className={styles.queueBody}>
        {!current && <div className={styles.queueEmpty}>待播清单是空的</div>}

        {current && (
          <>
            <div className={styles.queueGroupTitle}>正在播放</div>
            <div
              className={`${styles.queueRow} ${styles.queueRowCurrent}`}
              onDoubleClick={() => jumpToQueueIndex(index)}
            >
              <Cover
                coverId={songs[current.songId]?.coverId ?? null}
                size={80}
                display={36}
                radius={4}
                alt=""
              />
              <div className={styles.queueMeta}>
                <div className={`${styles.queueTitle} ellipsis`}>{songs[current.songId]?.title ?? '—'}</div>
                <div className={`${styles.queueArtist} ellipsis`}>
                  {songs[current.songId]?.artists.join('、') ?? ''}
                </div>
              </div>
              <span className={styles.queueDuration}>
                {formatTime(songs[current.songId]?.durationSec ?? 0)}
              </span>
            </div>
          </>
        )}

        <div className={styles.queueGroupTitle}>接下来</div>
        {upcoming.length === 0 && <div className={styles.queueEmpty}>没有下一首</div>}
        {upcoming.map((item, order) => {
          const song = songs[item.songId]
          const absolute = index + 1 + order
          const isAutomixNext = automixNext === item.songId && order === 0
          return (
            <div
              key={item.key}
              className={`${styles.queueRow} ${dragIndex === absolute ? styles.queueRowDragging : ''}`}
              draggable
              onDragStart={() => setDragIndex(absolute)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => {
                if (dragIndex !== null) moveInQueue(dragIndex, absolute)
                setDragIndex(null)
              }}
              onDragEnd={() => setDragIndex(null)}
              onDoubleClick={() => jumpToQueueIndex(absolute)}
            >
              <Cover coverId={song?.coverId ?? null} size={80} display={36} radius={4} alt="" />
              <div className={styles.queueMeta}>
                <div className={`${styles.queueTitle} ellipsis`}>{song?.title ?? '—'}</div>
                <div className={`${styles.queueArtist} ellipsis`}>{song?.artists.join('、') ?? ''}</div>
              </div>
              {isAutomixNext && automixStatus === 'ready' && (
                <span className={styles.queueDuration} title="AutoMix 就绪">
                  <Icon name="sparkles" size={13} />
                </span>
              )}
              {isAutomixNext && automixStatus === 'rendering' && (
                <span className={styles.queueDuration} title="分轨准备中">
                  <Icon name="waveform" size={13} />
                </span>
              )}
              <span className={styles.queueDuration}>{formatTime(song?.durationSec ?? 0)}</span>
              <button
                type="button"
                className={styles.queueRemove}
                onClick={() => removeFromQueue(item.key)}
                title="从待播清单移除"
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          )
        })}

        {history.length > 0 && (
          <>
            <button type="button" className={styles.historyToggle} onClick={() => setHistoryOpen(!historyOpen)}>
              <Icon name={historyOpen ? 'chevronDown' : 'chevronRight'} size={13} />
              历史记录（{history.length}）
            </button>
            {historyOpen &&
              history
                .slice()
                .reverse()
                .map((songId, i) => {
                  const song = songs[songId]
                  if (!song) return null
                  return (
                    <div key={`${songId}-${i}`} className={styles.queueRow} onDoubleClick={() => jumpToQueueIndex(queue.findIndex((q) => q.songId === songId))}>
                      <Cover coverId={song.coverId} size={80} display={36} radius={4} alt="" />
                      <div className={styles.queueMeta}>
                        <div className={`${styles.queueTitle} ellipsis`}>{song.title}</div>
                        <div className={`${styles.queueArtist} ellipsis`}>{song.artists.join('、')}</div>
                      </div>
                      <span className={styles.queueDuration}>{formatTime(song.durationSec)}</span>
                    </div>
                  )
                })}
          </>
        )}
      </div>
    </div>
  )
}
