import { useMemo, useState, type JSX } from 'react'
import { useStore } from '../state/store'
import { albumsOf, albumsSorted, songsOfAlbum } from '../lib/group'
import { Cover } from '../components/Cover'
import { Icon } from '../components/Icon'
import { formatCount } from '../lib/format'
import { MORPH_COVER, getMorphAlbum, markMorph, setMorphAlbum, withViewTransition } from '../lib/transition'
import styles from '../components/views.module.css'

interface Props {
  title: string
  mode: 'recent' | 'albums'
}

export function AlbumsView({ title, mode }: Props): JSX.Element {
  const songs = useStore((s) => s.songs)
  const songIds = useStore((s) => s.songIds)
  const setView = useStore((s) => s.setView)
  const playSongs = useStore((s) => s.playSongs)
  const setContextMenu = useStore((s) => s.setContextMenu)
  const [sortMode, setSortMode] = useState<'recent' | 'title' | 'artist'>(mode === 'recent' ? 'recent' : 'title')

  // 分组结果跨挂载缓存（键是 songs 引用）：翻页重建视图时不用重算整个曲库
  const albums = useMemo(() => albumsOf(songs, songIds), [songs, songIds])
  const list = useMemo(() => albumsSorted(albums, sortMode), [albums, sortMode])

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className="pageTitle">{title}</h1>
          <p className="pageSubtitle">{formatCount(list.length)} 张专辑</p>
        </div>
        <div className={styles.headerActions}>
          {(['recent', 'title', 'artist'] as const).map((entry) => (
            <button
              key={entry}
              type="button"
              className={sortMode === entry ? styles.primaryButton : styles.secondaryButton}
              onClick={() => setSortMode(entry)}
            >
              {entry === 'recent' ? '最近添加' : entry === 'title' ? '按标题' : '按艺人'}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.grid}>
        {list.map((album, albumIndex) => (
          <div
            key={album.key}
            data-album-card={album.key}
            className={styles.card}
            role="button"
            tabIndex={0}
            onClick={(event) => {
              markMorph(event.currentTarget.querySelector('[data-card-art]'))
              setMorphAlbum(album.key)
              withViewTransition(() => setView({ kind: 'album', key: album.key }))
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') setView({ kind: 'album', key: album.key })
            }}
          >
            <div
              className={styles.cardArt}
              data-card-art
              style={album.key === getMorphAlbum() ? { viewTransitionName: MORPH_COVER } : undefined}
            >
              <Cover coverId={album.coverId} size={240} radius={8} alt={album.name} priority={albumIndex < 8} />
              <button
                type="button"
                className={styles.cardPlay}
                title="播放"
                onClick={(event) => {
                  event.stopPropagation()
                  const tracks = songsOfAlbum(songs, album)
                  playSongs(tracks.map((t) => t.id), 0)
                }}
              >
                <Icon name="play" size={16} />
              </button>
              <button
                type="button"
                className={styles.cardMore}
                title="更多"
                onClick={(event) => {
                  event.stopPropagation()
                  const first = songsOfAlbum(songs, album)[0]
                  if (first) setContextMenu({ x: event.clientX, y: event.clientY, songId: first.id, albumKey: album.key })
                }}
              >
                <Icon name="more" size={16} />
              </button>
            </div>
            <div className={`${styles.cardTitle} ellipsis`}>{album.name}</div>
            <div className={`${styles.cardSubtitle} ellipsis`}>{album.artist}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
