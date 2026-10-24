import type { SongMeta } from '@shared/types'

export interface AlbumGroup {
  key: string
  name: string
  artist: string
  year: number | null
  genre: string | null
  coverId: string | null
  songIds: string[]
  duration: number
  trackCount: number
  discCount: number
  addedAt: number
}

export interface ArtistGroup {
  key: string
  name: string
  songIds: string[]
  albumKeys: string[]
  coverId: string | null
  addedAt: number
}

export const albumKeyOf = (song: SongMeta): string => `${song.albumArtist}\u0001${song.album}`

export function buildAlbums(songs: SongMeta[]): Map<string, AlbumGroup> {
  const albums = new Map<string, AlbumGroup>()
  for (const song of songs) {
    const key = albumKeyOf(song)
    const existing = albums.get(key)
    if (existing) {
      existing.songIds.push(song.id)
      existing.duration += song.durationSec
      existing.addedAt = Math.max(existing.addedAt, song.addedAt)
      existing.discCount = Math.max(existing.discCount, song.discNo ?? 1)
      if (!existing.coverId && song.coverId) existing.coverId = song.coverId
    } else {
      albums.set(key, {
        key,
        name: song.album,
        artist: song.albumArtist,
        year: song.year,
        genre: song.genre,
        coverId: song.coverId,
        songIds: [song.id],
        duration: song.durationSec,
        trackCount: 1,
        discCount: song.discNo ?? 1,
        addedAt: song.addedAt
      })
    }
  }
  for (const album of albums.values()) album.trackCount = album.songIds.length
  return albums
}

export function buildArtists(songs: SongMeta[]): Map<string, ArtistGroup> {
  const artists = new Map<string, ArtistGroup>()
  const add = (name: string, song: SongMeta): void => {
    if (!name) return
    let group = artists.get(name)
    if (!group) {
      group = { key: name, name, songIds: [], albumKeys: [], coverId: null, addedAt: 0 }
      artists.set(name, group)
    }
    if (!group.songIds.includes(song.id)) group.songIds.push(song.id)
    const albumKey = albumKeyOf(song)
    if (!group.albumKeys.includes(albumKey)) group.albumKeys.push(albumKey)
    if (!group.coverId && song.coverId) group.coverId = song.coverId
    group.addedAt = Math.max(group.addedAt, song.addedAt)
  }
  for (const song of songs) {
    for (const artist of song.artists) add(artist, song)
  }
  return artists
}

export function songsOfAlbum(songs: Record<string, SongMeta>, album: AlbumGroup): SongMeta[] {
  return album.songIds
    .map((id) => songs[id])
    .filter((s): s is SongMeta => Boolean(s))
    .sort(
      (a, b) =>
        (a.discNo ?? 1) - (b.discNo ?? 1) ||
        (a.trackNo ?? 0) - (b.trackNo ?? 0) ||
        a.title.localeCompare(b.title, 'zh-CN')
    )
}

export function albumsSorted(albums: Map<string, AlbumGroup>, sort: 'recent' | 'title' | 'artist'): AlbumGroup[] {
  const list = [...albums.values()]
  if (sort === 'recent') list.sort((a, b) => b.addedAt - a.addedAt)
  else if (sort === 'title') list.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  else list.sort((a, b) => a.artist.localeCompare(b.artist, 'zh-CN') || a.name.localeCompare(b.name, 'zh-CN'))
  return list
}

export function artistsSorted(artists: Map<string, ArtistGroup>): ArtistGroup[] {
  return [...artists.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
}

export function distinctGenres(songs: SongMeta[]): string[] {
  const set = new Set<string>()
  for (const s of songs) if (s.genre) set.add(s.genre)
  return [...set].sort((a, b) => a.localeCompare(b, 'zh-CN'))
}
