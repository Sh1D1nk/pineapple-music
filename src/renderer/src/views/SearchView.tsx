import { useMemo, type JSX } from 'react'
import { useStore, useCurrentSongId, useIsPlaying } from '../state/store'
import { buildAlbums, buildArtists } from '../lib/group'
import { matches, matchesText } from '../lib/search'
import { Cover } from '../components/Cover'
import { formatTime } from '../lib/format'
import { markMorph, withViewTransition } from '../lib/transition'
import { Icon } from '../components/Icon'
import styles from '../components/views.module.css'

export function SearchView(): JSX.Element {
  const query = useStore((s) => s.search)
  const songs = useStore((s) => s.songs)
  const songIds = useStore((s) => s.songIds)
  const setView = useStore((s) => s.setView)
  const playSongs = useStore((s) => s.playSongs)
  const setContextMenu = useStore((s) => s.setContextMenu)

  const { artists, albums, tracks } = useMemo(() => {
    const all = songIds.map((id) => songs[id]).filter((s): s is NonNullable<typeof s> => Boolean(s))
    const matchingSongs = all.filter((song) => matches(song, query))
    const artistNames = new Set<string>()
    for (const song of matchingSongs) for (const artist of song.artists) artistNames.add(artist)
    const artistGroups = [...buildArtists(all).values()].filter(
      (artist) => artistNames.has(artist.name) || matchesText(artist.name, query)
    )
    const albumGroups = [...buildAlbums(all).values()].filter(
      (album) => matchesText(album.name, query) || matchesText(album.artist, query)
    )
    return { artists: artistGroups.slice(0, 6), albums: albumGroups.slice(0, 12), tracks: matchingSongs.slice(0, 40) }
  }, [query, songIds, songs])

  const empty = artists.length === 0 && albums.length === 0 && tracks.length === 0
  const current = useCurrentSongId()

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className="pageTitle">搜索</h1>
          <p className="pageSubtitle">“{query}” 的结果</p>
        </div>
      </div>

      {empty && <div className={styles.noResults}>没有找到与“{query}”相关的内容</div>}

      {artists.length > 0 && (
        <section className={styles.searchSection}>
          <div className={styles.searchSectionTitle}>艺人</div>
          {artists.map((artist) => (
            <button
              key={artist.key}
              type="button"
              className={styles.resultRow}
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
                <div className={styles.artistMeta}>艺人</div>
              </div>
            </button>
          ))}
        </section>
      )}

      {albums.length > 0 && (
        <section className={styles.searchSection}>
          <div className={styles.searchSectionTitle}>专辑</div>
          <div className={styles.grid}>
            {albums.map((album) => (
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
                  <Cover coverId={album.coverId} size={240} radius={8} alt={album.name} />
                </div>
                <div className={`${styles.cardTitle} ellipsis`}>{album.name}</div>
                <div className={`${styles.cardSubtitle} ellipsis`}>{album.artist}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {tracks.length > 0 && (
        <section className={styles.searchSection}>
          <div className={styles.searchSectionTitle}>歌曲</div>
          {tracks.map((song) => (
            <div
              key={song.id}
              data-song-row={song.id}
              className={styles.resultRow}
              onDoubleClick={() => playSongs(tracks.map((t) => t.id), tracks.indexOf(song))}
              onContextMenu={(event) => {
                event.preventDefault()
                setContextMenu({ x: event.clientX, y: event.clientY, songId: song.id })
              }}
            >
              <Cover coverId={song.coverId} size={80} display={40} radius={4} alt={song.title} />
              <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                <div className={`${song.id === current ? styles.songTitleActive : styles.songTitle} ellipsis`}>
                  {song.title}
                </div>
                <div className={`${styles.artistMeta} ellipsis`}>{song.artists.join('、')}</div>
              </div>
              <div className={styles.cell} style={{ width: 220 }}>
                {song.album}
              </div>
              <div className={styles.duration} style={{ width: 60 }}>
                {formatTime(song.durationSec)}
              </div>
            </div>
          ))}
        </section>
      )}

      {!empty && (
        <div style={{ marginTop: 12 }}>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => playSongs(tracks.map((t) => t.id), 0)}
          >
            <Icon name="play" size={14} />
            播放全部搜索结果
          </button>
        </div>
      )}
    </div>
  )
}
