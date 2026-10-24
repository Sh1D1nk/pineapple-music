import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { FavoritesState } from '@shared/types'

/**
 * 收藏的持久化。
 *
 * 刻意不塞进 settings.json：设置是「一个对象 deepMerge 默认值」，收藏是「只会增删的集合」，
 * 混在一起会让每次改设置都重写一遍整份收藏，也让默认值合并逻辑有机会吞掉数组。
 * 这里只认字符串 id 集合，读到脏数据就退回空集合，绝不因为收藏文件坏了而让应用起不来。
 */
export const EMPTY_FAVORITES: FavoritesState = { songs: [], albums: [] }

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0 || seen.has(entry)) continue
    seen.add(entry)
    out.push(entry)
  }
  return out
}

export function normalizeFavorites(raw: unknown): FavoritesState {
  if (!raw || typeof raw !== 'object') return { songs: [], albums: [] }
  const record = raw as Record<string, unknown>
  return { songs: stringList(record.songs), albums: stringList(record.albums) }
}

/** 切换一个 id：存在则移除，不存在则追加（幂等，不产生重复项）。 */
export function toggleIn(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((entry) => entry !== id) : [...list, id]
}

export function toggleFavorite(state: FavoritesState, kind: 'song' | 'album', id: string): FavoritesState {
  return kind === 'song'
    ? { songs: toggleIn(state.songs, id), albums: state.albums }
    : { songs: state.songs, albums: toggleIn(state.albums, id) }
}

export function readFavorites(file: string): FavoritesState {
  try {
    if (!existsSync(file)) return { songs: [], albums: [] }
    return normalizeFavorites(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return { songs: [], albums: [] }
  }
}

export function writeFavorites(file: string, state: FavoritesState): FavoritesState {
  const normalized = normalizeFavorites(state)
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(normalized, null, 2), 'utf8')
  } catch {
    /* 写不进去也不该让收藏按钮炸掉；界面仍按内存里的结果更新 */
  }
  return normalized
}
