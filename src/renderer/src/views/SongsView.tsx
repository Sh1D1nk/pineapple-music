import { useMemo, useState, type JSX } from 'react'
import { useStore, useCurrentSongId, useIsPlaying } from '../state/store'
import { TrackTable, type SortKey } from '../components/TrackTable'
import { formatCount, formatDurationLabel } from '../lib/format'
import { Icon } from '../components/Icon'
import styles from '../components/views.module.css'

export function SongsView(): JSX.Element {
  const songs = useStore((s) => s.songs)
  const songIds = useStore((s) => s.songIds)
  const playSongs = useStore((s) => s.playSongs)
  const setContextMenu = useStore((s) => s.setContextMenu)
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'added', dir: 'desc' })

  const list = useMemo(() => {
    const all = songIds.map((id) => songs[id]).filter((s): s is NonNullable<typeof s> => Boolean(s))
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...all].sort((a, b) => {
      switch (sort.key) {
        case 'title':
          return a.title.localeCompare(b.title, 'zh-CN') * dir
        case 'artist':
          return (a.albumArtist || '').localeCompare(b.albumArtist || '', 'zh-CN') * dir
        case 'album':
          return a.album.localeCompare(b.album, 'zh-CN') * dir
        case 'duration':
          return (a.durationSec - b.durationSec) * dir
        case 'year':
          return ((a.year ?? 0) - (b.year ?? 0)) * dir
        default:
          return (a.addedAt - b.addedAt) * dir
      }
    })
  }, [songIds, songs, sort])

  const totalDuration = useMemo(() => list.reduce((sum, s) => sum + s.durationSec, 0), [list])
  const current = useCurrentSongId()
  const playing = useIsPlaying()

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className="pageTitle">歌曲</h1>
          <p className="pageSubtitle">
            {formatCount(list.length)} 首歌曲 · {formatDurationLabel(totalDuration)}
          </p>
        </div>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.primaryButton}
            onClick={() => list.length > 0 && playSongs(list.map((s) => s.id), 0)}
          >
            <Icon name="play" size={14} />
            播放全部
          </button>
        </div>
      </div>

      <TrackTable
        songs={list}
        currentId={current}
        playing={playing}
        sortable
        sort={sort}
        onSort={(key) =>
          setSort((prev) =>
            prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }
          )
        }
        onPlay={(_song, index) => playSongs(list.map((s) => s.id), index)}
        onContextMenu={(event, song) => {
          event.preventDefault()
          setContextMenu({ x: event.clientX, y: event.clientY, songId: song.id })
        }}
      />
    </div>
  )
}
