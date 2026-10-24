// 收藏持久化：读脏数据不能崩、切换必须幂等、写盘后能原样读回。
// 这些是「重启应用收藏还在」这条验收标准的机械保证。

import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  normalizeFavorites,
  readFavorites,
  toggleFavorite,
  toggleIn,
  writeFavorites
} from '../src/main/favorites'

describe('favorites: 数据规整', () => {
  it('falls back to empty collections for junk', () => {
    expect(normalizeFavorites(null)).toEqual({ songs: [], albums: [] })
    expect(normalizeFavorites('nope')).toEqual({ songs: [], albums: [] })
    expect(normalizeFavorites({ songs: 'x', albums: 3 })).toEqual({ songs: [], albums: [] })
  })

  it('drops duplicates, blanks and non-strings', () => {
    expect(normalizeFavorites({ songs: ['a', 'a', '', 7, null, 'b'], albums: ['k', 'k'] })).toEqual({
      songs: ['a', 'b'],
      albums: ['k']
    })
  })
})

describe('favorites: 切换语义', () => {
  it('adds then removes the same id', () => {
    expect(toggleIn([], 's1')).toEqual(['s1'])
    expect(toggleIn(['s1'], 's1')).toEqual([])
  })

  it('keeps the two collections independent', () => {
    const state = toggleFavorite({ songs: [], albums: [] }, 'song', 's1')
    expect(state.songs).toEqual(['s1'])
    expect(state.albums).toEqual([])

    const withAlbum = toggleFavorite(state, 'album', 'album-key')
    expect(withAlbum.songs).toEqual(['s1'])
    expect(withAlbum.albums).toEqual(['album-key'])

    const removed = toggleFavorite(withAlbum, 'song', 's1')
    expect(removed.songs).toEqual([])
    expect(removed.albums).toEqual(['album-key'])
  })
})

describe('favorites: 读写', () => {
  it('round-trips through favorites.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pineapple-fav-'))
    const file = join(dir, 'favorites.json')
    try {
      expect(readFavorites(file)).toEqual({ songs: [], albums: [] })
      writeFavorites(file, { songs: ['a', 'b'], albums: ['alb'] })
      expect(readFavorites(file)).toEqual({ songs: ['a', 'b'], albums: ['alb'] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('survives a corrupted file instead of throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pineapple-fav-'))
    const file = join(dir, 'favorites.json')
    try {
      writeFileSync(file, '{ not json', 'utf8')
      expect(readFavorites(file)).toEqual({ songs: [], albums: [] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
