import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import type { LibraryFolder, SongMeta } from '@shared/types'
import { indexDbFile, indexFile } from '../paths'

export interface SongRepository {
  readonly kind: 'sqlite' | 'json'
  all(): SongMeta[]
  get(id: string): SongMeta | undefined
  upsert(song: SongMeta): void
  remove(id: string): void
  folders(): LibraryFolder[]
  setFolders(folders: LibraryFolder[]): void
  getFlag(key: string): string | null
  setFlag(key: string, value: string): void
  flush(): void
  close(): void
}

function atomicWrite(file: string, data: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, file)
}

/* ------------------------------------------------------------------ JSON fallback */

class JsonRepository implements SongRepository {
  readonly kind = 'json' as const
  private songs = new Map<string, SongMeta>()
  private folderList: LibraryFolder[] = []
  private flags = new Map<string, string>()
  private timer: NodeJS.Timeout | null = null
  private dirty = false

  constructor(private readonly file: string) {
    this.load()
  }

  private load(): void {
    if (!existsSync(this.file)) return
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as {
        songs?: SongMeta[]
        folders?: LibraryFolder[]
        flags?: Record<string, string>
      }
      for (const song of raw.songs ?? []) this.songs.set(song.id, song)
      this.folderList = raw.folders ?? []
      this.flags = new Map(Object.entries(raw.flags ?? {}))
    } catch {
      // A corrupt index must never block startup: start empty and rescan.
      this.songs.clear()
    }
  }

  all(): SongMeta[] {
    return [...this.songs.values()]
  }
  get(id: string): SongMeta | undefined {
    return this.songs.get(id)
  }
  upsert(song: SongMeta): void {
    this.songs.set(song.id, song)
    this.schedule()
  }
  remove(id: string): void {
    if (this.songs.delete(id)) this.schedule()
  }
  folders(): LibraryFolder[] {
    return this.folderList
  }
  setFolders(folders: LibraryFolder[]): void {
    this.folderList = folders
    this.schedule()
  }
  getFlag(key: string): string | null {
    return this.flags.get(key) ?? null
  }
  setFlag(key: string, value: string): void {
    this.flags.set(key, value)
    this.schedule()
  }
  private schedule(): void {
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, 800)
  }
  flush(): void {
    if (!this.dirty) return
    this.dirty = false
    atomicWrite(
      this.file,
      JSON.stringify({
        version: 1,
        songs: [...this.songs.values()],
        folders: this.folderList,
        flags: Object.fromEntries(this.flags)
      })
    )
  }
  close(): void {
    if (this.timer) clearTimeout(this.timer)
    this.flush()
  }
}

/* ------------------------------------------------------------------ SQLite */

interface Statement {
  run(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
}
interface Database {
  exec(sql: string): void
  prepare(sql: string): Statement
  close(): void
}

class SqliteRepository implements SongRepository {
  readonly kind = 'sqlite' as const
  private readonly db: Database

  constructor(
    private readonly file: string,
    DatabaseCtor: new (path: string) => Database
  ) {
    this.db = new DatabaseCtor(file)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS songs (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS songs_path ON songs(path);
      CREATE INDEX IF NOT EXISTS songs_mtime ON songs(mtime);
      CREATE TABLE IF NOT EXISTS folders (path TEXT PRIMARY KEY, added_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `)
  }

  all(): SongMeta[] {
    return (this.db.prepare('SELECT json FROM songs').all() as { json: string }[]).map(
      (r) => JSON.parse(r.json) as SongMeta
    )
  }
  get(id: string): SongMeta | undefined {
    const row = this.db.prepare('SELECT json FROM songs WHERE id = ?').get(id) as
      | { json: string }
      | undefined
    return row ? (JSON.parse(row.json) as SongMeta) : undefined
  }
  upsert(song: SongMeta): void {
    this.db
      .prepare(
        `INSERT INTO songs (id, path, mtime, size, json) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET path=excluded.path, mtime=excluded.mtime,
           size=excluded.size, json=excluded.json`
      )
      .run(song.id, song.path, Math.round(song.mtimeMs), song.fileSize, JSON.stringify(song))
  }
  remove(id: string): void {
    this.db.prepare('DELETE FROM songs WHERE id = ?').run(id)
  }
  folders(): LibraryFolder[] {
    // Alias in SQL so the caller gets camelCase without a per-row mapping pass.
    return this.db
      .prepare('SELECT path, added_at AS addedAt FROM folders ORDER BY added_at')
      .all() as LibraryFolder[]
  }
  setFolders(folders: LibraryFolder[]): void {
    this.db.exec('DELETE FROM folders')
    const stmt = this.db.prepare('INSERT INTO folders (path, added_at) VALUES (?, ?)')
    for (const f of folders) stmt.run(f.path, f.addedAt ?? Date.now())
  }
  getFlag(key: string): string | null {
    const row = this.db.prepare('SELECT v FROM kv WHERE k = ?').get(key) as { v: string } | undefined
    return row?.v ?? null
  }
  setFlag(key: string, value: string): void {
    this.db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(
      key,
      value
    )
  }
  flush(): void {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      /* not fatal */
    }
  }
  close(): void {
    try {
      this.db.close()
    } catch {
      /* not fatal */
    }
  }
}

export function openRepository(): SongRepository {
  try {
    // Required lazily so a missing/unbuilt native module degrades instead of crashing startup.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('better-sqlite3') as { default?: new (p: string) => Database } & (new (
      p: string
    ) => Database)
    const Ctor = (mod.default ?? mod) as new (p: string) => Database
    const repo = new SqliteRepository(indexDbFile(), Ctor)
    // Touch a row so a broken binding fails here rather than mid-scan.
    repo.all()
    console.info('[library] using SQLite index')
    return repo
  } catch (err) {
    console.warn('[library] better-sqlite3 unavailable, falling back to JSON index:', String(err))
    return new JsonRepository(indexFile())
  }
}
