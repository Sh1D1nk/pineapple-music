import { useMemo, type JSX } from 'react'
import { useStore, useCurrentSongId, useIsPlaying } from '../state/store'
import { albumsOf, artistsOf, albumsSorted, songsOfAlbum } from '../lib/group'
import { Cover } from '../components/Cover'
import { Icon } from '../components/Icon'
import { TrackTable } from '../components/TrackTable'
import { formatCount } from '../lib/format'
import { markMorph, withViewTransition } from '../lib/transition'
import styles from '../components/views.module.css'

export function ArtistsView(): JSX.Element {
  const songs = useStore((s) => s.songs)
  const songIds = useStore((s) => s.songIds)
  const setView = useStore((s) => s.setView)

  const list = useMemo(
    () => [...artistsOf(songs, songIds).values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
    [songIds, songs]
  )

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className="pageTitle">艺人</h1>
          <p className="pageSubtitle">{formatCount(list.length)} 位艺人</p>
        </div>
      </div>
      <div className={styles.artistList}>
        {list.map((artist) => (
          <button
            key={artist.key}
            type="button"
            className={styles.artistRow}
            onClick={() => setView({ kind: 'artist', name: artist.name })}
          >
            <div className={styles.avatar}>
              {artist.coverId ? (
                <Cover coverId={artist.coverId} size={80} radius={999} alt={artist.name} />
              ) : (
                <div className={styles.avatarLetter}>{artist.name.slice(0, 1)}</div>
              )}
            </div>
            <div style={{ textAlign: 'left' }}>
              <div className={styles.artistName}>{artist.name}</div>
              <div className={styles.artistMeta}>
                {artist.albumKeys.length} 张专辑 · {artist.songIds.length} 首歌曲
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

interface DetailProps {
  name: string
}

export function ArtistDetail({ name }: DetailProps): JSX.Element {
  const songs = useStore((s) => s.songs)
  const songIds = useStore((s) => s.songIds)
  const playSongs = useStore((s) => s.playSongs)
  const setView = useStore((s) => s.setView)
  const setContextMenu = useStore((s) => s.setContextMenu)

  const { albums, tracks } = useMemo(() => {
    const artist = artistsOf(songs, songIds).get(name)
    const albumMap = albumsOf(songs, songIds)
    const albumList = artist
      ? artist.albumKeys.map((key) => albumMap.get(key)).filter((a): a is NonNullable<typeof a> => Boolean(a))
      : []
    const own = artist ? artist.songIds.map((id) => songs[id]).filter((s): s is NonNullable<typeof s> => Boolean(s)) : []
    own.sort((a, b) => (b.analysis?.lufs ?? -99) - (a.analysis?.lufs ?? -99))
    return { albums: albumsSorted(albumMap, 'recent').filter((a) => albumList.some((x) => x.key === a.key)), tracks: own }
  }, [songIds, songs, name])

  const top = tracks.slice(0, 10)
  const current = useCurrentSongId()
  const playing = useIsPlaying()

  return (
    <div className={styles.page}>
      <h1 className={styles.artistHeroTitle}>{name}</h1>

      {albums.length > 0 && (
        <>
          <div className={styles.searchSectionTitle}>专辑</div>
          <div className={styles.grid} style={{ marginBottom: 32 }}>
            {albums.map((album, albumIndex) => (
              <div
                key={album.key}
                className={styles.card}
                role="button"
                tabIndex={0}
                onClick={(event) => {
                  markMorph(event.currentTarget.querySelector('[data-card-art]'))
                  withViewTransition(() => setView({ kind: 'album', key: album.key }))
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') setView({ kind: 'album', key: album.key })
                }}
              >
                <div className={styles.cardArt} data-card-art>
                  <Cover coverId={album.coverId} size={240} radius={8} alt={album.name} priority={albumIndex < 8} />
                  <button
                    type="button"
                    className={styles.cardPlay}
                    title="播放"
                    onClick={(event) => {
                      event.stopPropagation()
                      playSongs(songsOfAlbum(songs, album).map((t) => t.id), 0)
                    }}
                  >
                    <Icon name="play" size={16} />
                  </button>
                </div>
                <div className={`${styles.cardTitle} ellipsis`}>{album.name}</div>
                <div className={`${styles.cardSubtitle} ellipsis`}>
                  {album.year ?? ''} {album.genre ? `· ${album.genre}` : ''}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <div className={styles.searchSectionTitle}>歌曲</div>
      <TrackTable
        songs={top}
        currentId={current}
        playing={playing}
        onPlay={(_song, index) => playSongs(tracks.map((t) => t.id), index)}
        onContextMenu={(event, song) => {
          event.preventDefault()
          setContextMenu({ x: event.clientX, y: event.clientY, songId: song.id })
        }}
      />
    </div>
  )
}
