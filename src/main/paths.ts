import { app } from 'electron'
import { join } from 'node:path'
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'

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
 *
 * 判定用「数据文件」而不是「目录是否为空」：Electron 在启动时就会在 userData 里
 * 建 Cache / GPU 缓存，readdir 永远非空，用目录判空会让迁移永远不执行。
 * 只搬数据项，不搬浏览器缓存；迁移成功写 migrate.done，之后不再重复。
 */
const MIGRATED_MARK = 'migrate.done'
const DATA_ITEMS = [
  'library.db',
  'library.db-wal',
  'library.db-shm',
  'library.json',
  'settings.json',
  'favorites.json',
  'tasks.json',
  'queue.json',
  'covers',
  'lyrics-cache',
  'stems',
  'analysis',
  'models'
]

function migrateLegacyData(target: string): void {
  try {
    if (existsSync(join(target, MIGRATED_MARK))) return
    const appData = app.getPath('appData')
    for (const legacyName of ['Pineapple Music', 'Noctis']) {
      const legacy = join(appData, legacyName)
      if (legacy === target) continue
      if (!existsSync(join(legacy, 'library.db')) && !existsSync(join(legacy, 'library.json'))) continue
      // 新目录已经有数据库（上一次启动创建的空库）→ 用旧库覆盖，别的数据只在缺失时补
      for (const item of DATA_ITEMS) {
        const from = join(legacy, item)
        if (!existsSync(from)) continue
        const to = join(target, item)
        try {
          if (item.startsWith('library.db') || item.endsWith('.json')) {
            cpSync(from, to, { force: true })
          } else if (!existsSync(to)) {
            cpSync(from, to, { recursive: true })
          }
        } catch (err) {
          console.error('[migrate] item failed', item, err)
        }
      }
      writeFileSync(join(target, MIGRATED_MARK), JSON.stringify({ from: legacy, at: Date.now() }))
      console.log('[migrate] copied data from', legacy)
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
