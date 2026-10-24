import { pinyin } from 'pinyin-pro'
import type { SongMeta } from '@shared/types'

const cache = new Map<string, string>()

/** Latin text lowercased, plus the pinyin initials of any CJK run, so "qingtian" and "qt" both hit. */
export function searchKey(text: string): string {
  const cached = cache.get(text)
  if (cached !== undefined) return cached
  let key = text.toLowerCase()
  if (/[㐀-鿿]/.test(text)) {
    try {
      // pattern:'first' 是「每个音节的首字母」，不是完整拼音；完整拼音要用 'pinyin'。
      const full = pinyin(text, { pattern: 'pinyin', toneType: 'none', type: 'array' })
        .join('')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
      const initials = pinyin(text, { pattern: 'initial', toneType: 'none', type: 'array' })
        .join('')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
      key += ` ${initials} ${full}`
    } catch {
      /* pinyin is a convenience, never a hard dependency */
    }
  }
  if (cache.size > 20000) cache.clear()
  cache.set(text, key)
  return key
}

export function matches(song: SongMeta, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const haystack = [
    searchKey(song.title),
    searchKey(song.album),
    searchKey(song.albumArtist),
    ...song.artists.map(searchKey)
  ]
  return q.split(/\s+/).every((part) => haystack.some((h) => h.includes(part)))
}

export function matchesText(text: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return searchKey(text).includes(q)
}
