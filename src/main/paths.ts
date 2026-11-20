import { app } from 'electron'
import { join } from 'node:path'
import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'

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

function sizeOf(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

function migrateLegacyData(target: string): void {
  if (process.env.PINNET_NO_MIGRATE === '1') return
  try {
    const appData = app.getPath('appData')
    const marked = existsSync(join(target, MIGRATED_MARK))
    for (const legacyName of ['Pineapple Music', 'Noctis']) {
      const legacy = join(appData, legacyName)
      if (legacy === target) continue
      const legacyDb = join(legacy, 'library.db')
      const legacyJson = join(legacy, 'library.json')
      if (!existsSync(legacyDb) && !existsSync(legacyJson)) continue
      // 上一次迁移可能把「空库」当成成功（目标库当时还被占用），只写标记不写数据。
      // 所以有标记也要核对体积：旧库明显更大而新库几乎没有内容时，重做一次。
      const targetSize = sizeOf(join(target, 'library.db')) + sizeOf(join(target, 'library.json'))
      const sourceSize = sizeOf(legacyDb) + sizeOf(legacyJson)
      // 封面目录也可能被上一次迁移留下一个空目录，单独核对一次数量
      const countFiles = (dir: string): number => {
        try {
          return readdirSync(dir, { recursive: true } as never).length
        } catch {
          return 0
        }
      }
      const legacyCovers = countFiles(join(legacy, 'covers'))
      const targetCovers = countFiles(join(target, 'covers'))
      const coversMissing = legacyCovers > 10 && targetCovers < legacyCovers * 0.5
      const needsCopy = !marked || coversMissing || (sourceSize > 1_000_000 && sourceSize > targetSize * 3)
      if (!needsCopy) return
      // 新目录已经有数据库（上一次启动创建的空库）→ 用旧库覆盖，别的数据只在缺失时补
      for (const item of DATA_ITEMS) {
        const from = join(legacy, item)
        if (!existsSync(from)) continue
        const to = join(target, item)
        try {
          if (item.startsWith('library.db') || item.endsWith('.json')) {
            cpSync(from, to, { force: true })
          } else if (!existsSync(to) || coversMissing || !marked) {
            // 目录合并复制：目标已存在也补齐（covers 是内容寻址的，覆盖无害）
            cpSync(from, to, { recursive: true, force: true })
          } else if (!existsSync(to)) {
            cpSync(from, to, { recursive: true })
          }
        } catch (err) {
          console.error('[migrate] item failed', item, err)
        }
      }
      // 只有真的把库搬过来才落标记，否则下次启动还能重试
      const copied = sizeOf(join(target, 'library.db')) + sizeOf(join(target, 'library.json'))
      if (sourceSize > 1_000_000 && copied < sourceSize * 0.5) {
        console.error('[migrate] library copy did not land, will retry next launch')
        return
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
