import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

/**
 * All mutable state lives under %APPDATA%/Pineapple Music. The cache layout is intentionally flat and
 * content addressed so that deleting it is always safe.
 */
function ensure(dir: string): string {
  mkdirSync(dir, { recursive: true })
  return dir
}

export const userDataDir = (): string => app.getPath('userData')
export const coversDir = (): string => ensure(join(userDataDir(), 'covers'))
export const lyricsCacheDir = (): string => ensure(join(userDataDir(), 'lyrics-cache'))
export const stemsDir = (): string => ensure(join(userDataDir(), 'stems'))
export const analysisDir = (): string => ensure(join(userDataDir(), 'analysis'))
export const modelsDir = (): string => ensure(join(userDataDir(), 'models'))
export const indexFile = (): string => join(userDataDir(), 'library.json')
export const indexDbFile = (): string => join(userDataDir(), 'library.db')
export const settingsFile = (): string => join(userDataDir(), 'settings.json')
export const queueStateFile = (): string => join(userDataDir(), 'tasks.json')
export const windowStateFile = (): string => join(userDataDir(), 'window.json')
