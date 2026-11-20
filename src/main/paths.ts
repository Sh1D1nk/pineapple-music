import { app } from 'electron'
import { join } from 'node:path'
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs'

/**
 * All mutable state lives under %APPDATA%/Pineapple Music. The cache layout is intentionally flat and
 * content addressed so that deleting it is always safe.
 */
function ensure(dir: string): string {
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 改名迁移：Pineapple Music → Pinnet。
 * 新目录为空且旧目录存在时，整棵拷过去（曲库/设置/封面/歌词缓存/分轨结果都在里面）。
 * 只拷一次：新目录一旦有内容就不再动，避免覆盖用户升级后的数据。
 */
function migrateLegacyData(target: string): void {
  try {
    if (existsSync(target) && readdirSync(target).length > 0) return
    const appData = app.getPath('appData')
    for (const legacyName of ['Pineapple Music', 'Noctis']) {
      const legacy = join(appData, legacyName)
      if (!existsSync(legacy) || legacy === target) continue
      cpSync(legacy, target, { recursive: true, force: false, errorOnExist: false })
      console.log('[migrate] copied', legacy, '->', target)
      return
    }
  } catch (err) {
    console.error('[migrate] failed', err)
  }
}

export const userDataDir = (): string => {
  const dir = app.getPath('userData')
  migrateLegacyData(dir)
  return dir
}
export const coversDir = (): string => ensure(join(userDataDir(), 'covers'))
export const lyricsCacheDir = (): string => ensure(join(userDataDir(), 'lyrics-cache'))
export const stemsDir = (): string => ensure(join(userDataDir(), 'stems'))
export const analysisDir = (): string => ensure(join(userDataDir(), 'analysis'))
export const modelsDir = (): string => ensure(join(userDataDir(), 'models'))
export const indexFile = (): string => join(userDataDir(), 'library.json')
export const indexDbFile = (): string => join(userDataDir(), 'library.db')
export const settingsFile = (): string => join(userDataDir(), 'settings.json')
export const favoritesFile = (): string => join(userDataDir(), 'favorites.json')
export const queueStateFile = (): string => join(userDataDir(), 'tasks.json')
export const windowStateFile = (): string => join(userDataDir(), 'window.json')
