import { useMemo, useRef, useState, type JSX } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { SongMeta } from '@shared/types'
import { Cover } from './Cover'
import { Icon } from './Icon'
import { formatTime } from '../lib/format'
import { useStore } from '../state/store'
import styles from './views.module.css'

export type SortKey = 'title' | 'artist' | 'album' | 'duration' | 'year' | 'added' | 'track'

interface Props {
  songs: SongMeta[]
  currentId: string | null
  playing: boolean
  variant?: 'library' | 'album'
  sortable?: boolean
  sort?: { key: SortKey; dir: 'asc' | 'desc' }
  onSort?: (key: SortKey) => void
  onPlay: (song: SongMeta, index: number) => void
  onContextMenu: (event: React.MouseEvent, song: SongMeta) => void
  selectedId?: string | null
  showDiscHeaders?: boolean
}

export function TrackTable({
  songs,
  currentId,
  playing,
  variant = 'library',
  sortable = false,
  sort,
  onSort,
  onPlay,
  onContextMenu,
  selectedId,
  showDiscHeaders = false
}: Props): JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  // 收藏标记直接读 store：TrackTable 被五个视图复用，加一层 prop 只会让每个调用点都要接线
  const favoriteSongs = useStore((s) => s.favorites.songs)
  const favoriteSet = useMemo(() => new Set(favoriteSongs), [favoriteSongs])

  const items = useMemo(() => {
    if (!showDiscHeaders) return songs.map((song) => ({ kind: 'song' as const, song }))
    const out: ({ kind: 'song'; song: SongMeta } | { kind: 'disc'; label: string })[] = []
    let disc = -1
    for (const song of songs) {
      const current = song.discNo ?? 1
      if (current !== disc) {
        disc = current
        out.push({ kind: 'disc', label: `碟片 ${current}` })
      }
      out.push({ kind: 'song', song })
    }
    return out
  }, [songs, showDiscHeaders])

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => document.getElementById('contentScroll'),
    estimateSize: (index) => (items[index]?.kind === 'disc' ? 36 : 52),
    overscan: 10
  })

  const columns = variant === 'album' ? '24px 1fr 220px 70px' : '1fr 220px 220px 70px'

  const header = (key: SortKey, label: string, className?: string): JSX.Element => {
    const active = sort?.key === key
    return (
      <button
        type="button"
        className={`${styles.headCell} ${className ?? ''} ${active ? styles.headActive : ''}`}
        onClick={() => sortable && onSort?.(key)}
        disabled={!sortable}
      >
        <span>{label}</span>
        {active && <Icon name={sort!.dir === 'asc' ? 'sortAsc' : 'sortDesc'} size={12} />}
      </button>
    )
  }

  return (
    <div className={styles.tableWrap} ref={scrollRef}>
      <div className={styles.tableHead} style={{ gridTemplateColumns: columns }}>
        {variant === 'album' ? (
          <span className={styles.trackIndex}>#</span>
        ) : null}
        {header('title', '标题')}
        {variant === 'album' ? <span className={styles.headCell}>艺人</span> : header('artist', '艺人')}
        {variant === 'album' ? null : header('album', '专辑')}
        {header('duration', '时长', styles.headRight)}
      </div>
      <div className={styles.rows} style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const item = items[virtualRow.index]
          if (!item) return null
          if (item.kind === 'disc') {
            return (
              <div
                key={`disc-${virtualRow.index}`}
                className={styles.discHeader}
                style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${virtualRow.start}px)` }}
              >
                {item.label}
              </div>
            )
          }
          const song = item.song
          const isCurrent = song.id === currentId
          return (
            <div
              key={song.id}
              data-song-row={song.id}
              className={`${styles.row} ${virtualRow.index % 2 === 1 ? styles.rowZebra : ''} ${
                isCurrent ? styles.rowSelected : ''
              } ${isCurrent ? styles.rowPlaying : ''} ${
                selectedId === song.id ? styles.rowSelected : ''
              }`}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                transform: `translateY(${virtualRow.start}px)`,
                gridTemplateColumns: columns
              }}
              onDoubleClick={() => onPlay(song, virtualRow.index)}
              onContextMenu={(event) => onContextMenu(event, song)}
              onPointerEnter={() => setHovered(song.id)}
              onPointerLeave={() => setHovered((prev) => (prev === song.id ? null : prev))}
            >
              {variant === 'album' && (
                <span className={styles.trackIndex}>
                  {hovered === song.id || isCurrent ? null : (song.trackNo ?? '')}
                </span>
              )}
              <div className={styles.titleCell}>
                <div className={styles.thumbWrap}>
                  <Cover coverId={song.coverId} size={80} display={40} radius={4} alt={song.title} />
                  {isCurrent && playing ? (
                    <span className={styles.eq}>
                      <span />
                      <span />
                      <span />
                    </span>
                  ) : (
                    <button
                      type="button"
                      className={styles.thumbPlay}
                      onClick={(event) => {
                        event.stopPropagation()
                        onPlay(song, virtualRow.index)
                      }}
                      title="播放"
                    >
                      <Icon name={isCurrent && playing ? 'pause' : 'play'} size={16} />
                    </button>
                  )}
                </div>
                <div className={styles.titleText}>
                  <div className={styles.songTitleRow}>
                    <span className={`${styles.songTitle} ${isCurrent ? styles.songTitleActive : ''} ellipsis`}>
                      {song.title}
                    </span>
                    {favoriteSet.has(song.id) && (
                      <Icon name="starFilled" size={11} className={styles.favMark} aria-label="已收藏" />
                    )}
                  </div>
                  <div className={`${styles.songArtistInline} ellipsis`}>{song.artists.join('、')}</div>
                </div>
              </div>
              {variant === 'album' ? (
                <span className={styles.cell}>
                  {song.artists.join('、') !== song.albumArtist ? song.artists.join('、') : ''}
                </span>
              ) : (
                <span className={styles.cell}>{song.artists.join('、')}</span>
              )}
              {variant === 'library' && <span className={styles.cell}>{song.album}</span>}
              <span className={styles.duration}>{formatTime(song.durationSec)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
