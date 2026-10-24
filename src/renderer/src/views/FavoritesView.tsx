import { useMemo, type JSX } from 'react'
import { useStore } from '../state/store'
import { buildAlbums, songsOfAlbum } from '../lib/group'
import { TrackTable } from '../components/TrackTable'
import { Cover } from '../components/Cover'
import { Icon } from '../components/Icon'
import { formatCount } from '../lib/format'
import { MORPH_COVER, getMorphAlbum, markMorph, setMorphAlbum, withViewTransition } from '../lib/transition'
import styles from '../components/views.module.css'

/**
 * 收藏页：歌曲与专辑两段。
 * 收藏本身只存 id / album key（见 main/favorites.ts），这里负责把它翻译成可播放的实体，
 * 因此曲库被移除的条目会自动从列表里消失，不需要额外的清理逻辑。
 */
export function FavoritesView(): JSX.Element {
  const songs = useStore((s) => s.songs)
  const songIds = useStore((s) => s.songIds)
  const favorites = useStore((s) => s.favorites)
  const playback = useStore((s) => s.playback)
  const playSongs = useStore((s) => s.playSongs)
  const setView = useStore((s) => s.setView)
  const setContextMenu = useStore((s) => s.setContextMenu)
  const toggleFavoriteAlbum = useStore((s) => s.toggleFavoriteAlbum)

  const allSongs = useMemo(
    () => songIds.map((id) => songs[id]).filter((s): s is NonNullable<typeof s> => Boolean(s)),
    [songIds, songs]
  )
  const albums = useMemo(() => buildAlbums(allSongs), [allSongs])

  const favoriteSongs = useMemo(
    () => favorites.songs.map((id) => songs[id]).filter((s): s is NonNullable<typeof s> => Boolean(s)),
    [favorites.songs, songs]
  )
  const favoriteAlbums = useMemo(
    () => favorites.albums.map((key) => albums.get(key)).filter((a): a is NonNullable<typeof a> => Boolean(a)),
    [favorites.albums, albums]
  )

  const current = playback.queue[playback.index]?.songId ?? null
  const empty = favoriteSongs.length === 0 && favoriteAlbums.length === 0

  if (empty) {
    return (
      <div className={styles.page}>
        <h1 className="pageTitle" style={{ marginBottom: 8 }}>
          收藏
        </h1>
        <div className={styles.empty}>
          <div className={styles.emptyArt}>
            <Icon name="star" size={40} />
          </div>
          <div className={styles.emptyTitle}>还没有收藏</div>
          <div className={styles.emptyText}>
            在任意歌曲上点右键选择「收藏」，或在专辑卡片上点星标；收藏会存进本地，重开应用依然在。
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className="pageTitle">收藏</h1>
          <p className="pageSubtitle">
            {formatCount(favoriteSongs.length)} 首歌曲 · {formatCount(favoriteAlbums.length)} 张专辑
          </p>
        </div>
      </div>

      {favoriteAlbums.length > 0 && (
        <>
          <div className={styles.searchSectionTitle}>专辑</div>
          <div className={styles.grid} style={{ marginBottom: 30 }}>
            {favoriteAlbums.map((album) => (
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
                  <Cover coverId={album.coverId} size={640} radius={8} alt={album.name} />
                  <button
                    type="button"
                    className={styles.cardPlay}
                    title="播放"
                    onClick={(event) => {
                      event.stopPropagation()
                      playSongs(
                        songsOfAlbum(songs, album).map((t) => t.id),
                        0
                      )
                    }}
                  >
                    <Icon name="play" size={16} />
                  </button>
                  <button
                    type="button"
                    className={styles.cardStar}
                    title="取消收藏专辑"
                    aria-pressed
                    onClick={(event) => {
                      event.stopPropagation()
                      void toggleFavoriteAlbum(album.key)
                    }}
                  >
                    <Icon name="starFilled" size={14} />
                  </button>
                </div>
                <div className={`${styles.cardTitle} ellipsis`}>{album.name}</div>
                <div className={`${styles.cardSubtitle} ellipsis`}>{album.artist}</div>
              </div>
            ))}
          </div>
        </>
      )}

      <div className={styles.searchSectionTitle}>歌曲</div>
      {favoriteSongs.length > 0 ? (
        <TrackTable
          songs={favoriteSongs}
          currentId={current}
          playing={playback.playing}
          onPlay={(_song, index) => playSongs(favoriteSongs.map((s) => s.id), index)}
          onContextMenu={(event, song) => {
            event.preventDefault()
            setContextMenu({ x: event.clientX, y: event.clientY, songId: song.id })
          }}
        />
      ) : (
        <div className={styles.favEmptyNote}>还没有收藏的歌曲，右键任意歌曲即可加入。</div>
      )}
    </div>
  )
}
