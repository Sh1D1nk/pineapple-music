import { useMemo, useState, type JSX } from 'react'
import { useStore } from '../state/store'
import { albumsOf, albumsSorted, songsOfAlbum, type AlbumGroup } from '../lib/group'
import { Cover } from '../components/Cover'
import { Icon } from '../components/Icon'
import { VirtualGrid } from '../components/VirtualGrid'
import { formatCount } from '../lib/format'
import { MORPH_COVER, getMorphAlbum, markMorph, setMorphAlbum, withViewTransition } from '../lib/transition'
import { coverUrl } from '../bridge'
import styles from '../components/views.module.css'
import { PERF_LEGACY } from '../perf/flags'

interface Props {
  title: string
  mode: 'recent' | 'albums'
}

/** 悬停 50ms 后预取 640 封面并解码：点开时大图已经在解码缓存里。 */
let prefetchTimer = 0
function prefetchCover(coverId: string | null | undefined): void {
  if (!coverId) return
  window.clearTimeout(prefetchTimer)
  prefetchTimer = window.setTimeout(() => {
    const url = coverUrl(coverId, 640)
    if (!url) return
    const img = new Image()
    img.src = url
    void img.decode?.().catch(() => undefined)
  }, 50)
}

function AlbumCard({ album, index, priority }: { album: AlbumGroup; index: number; priority: boolean }): JSX.Element {
  const songs = useStore((s) => s.songs)
  const setView = useStore((s) => s.setView)
  const playSongs = useStore((s) => s.playSongs)
  const setContextMenu = useStore((s) => s.setContextMenu)
  return (
    <div
      data-album-card={album.key}
      className={styles.card}
      role="button"
      tabIndex={0}
      onPointerEnter={() => prefetchCover(album.coverId)}
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
        <Cover coverId={album.coverId} size={240} radius={8} alt={album.name} priority={priority || index < 8} />
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
  )
}

export function AlbumsView({ title, mode }: Props): JSX.Element {
  const songs = useStore((s) => s.songs)
  const songIds = useStore((s) => s.songIds)
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

      {PERF_LEGACY ? (
        <div className={styles.grid}>
          {list.map((album, index) => (
            <AlbumCard key={album.key} album={album} index={index} priority={index < 8} />
          ))}
        </div>
      ) : (
        <VirtualGrid
          items={list}
          renderItem={(album, index) => <AlbumCard album={album} index={index} priority={index < 12} />}
        />
      )}
    </div>
  )
}
