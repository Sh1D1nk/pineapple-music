import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { promises as fs, watch, type FSWatcher } from 'node:fs'
import { extname, join, sep } from 'node:path'
import type { LibraryBatch, LibraryFolder, ScanProgress, SongMeta } from '@shared/types'
import { readTags } from './tags'
import { findSidecarCover, readCoverFile, storeCover } from './covers'
import type { SongRepository } from './repository'
import { lyricsCacheDir } from '../paths'

const AUDIO_EXT = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wav', '.ape', '.wv'])
const LYRIC_EXT = new Set(['.lrc', '.ttml', '.lys', '.yrc', '.qrc'])

export const songIdFor = (path: string): string =>
  createHash('sha1').update(path.toLowerCase()).digest('hex').slice(0, 16)

async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const index = cursor++
      const item = items[index]
      if (item === undefined) return
      await worker(item)
    }
  })
  await Promise.all(runners)
}

export class LibraryService extends EventEmitter {
  private songs = new Map<string, SongMeta>()
  private folderList: LibraryFolder[] = []
  private watchers = new Map<string, FSWatcher>()
  private pendingAdded: SongMeta[] = []
  private pendingUpdated: SongMeta[] = []
  private pendingRemoved: string[] = []
  private flushTimer: NodeJS.Timeout | null = null
  private progress: ScanProgress = {
    active: false,
    stage: 'idle',
    processed: 0,
    total: 0,
    currentTitle: '',
    folder: null
  }
  private rescanTimer: NodeJS.Timeout | null = null
  private scanning = false
  private queueAgain = false

  constructor(private readonly repo: SongRepository) {
    super()
  }

  async init(): Promise<void> {
    this.folderList = this.repo.folders()
    for (const song of this.repo.all()) this.songs.set(song.id, song)
    for (const folder of this.folderList) this.watchFolder(folder.path)
    // Anything indexed but gone from disk is dropped before the first paint.
    const missing: string[] = []
    for (const song of this.songs.values()) {
      try {
        await fs.access(song.path)
      } catch {
        missing.push(song.id)
      }
    }
    for (const id of missing) {
      this.songs.delete(id)
      this.repo.remove(id)
    }
    if (missing.length > 0) this.scheduleFlush(true)
  }

  snapshot(): SongMeta[] {
    return [...this.songs.values()]
  }

  folders(): LibraryFolder[] {
    return this.folderList
  }

  get(id: string): SongMeta | undefined {
    return this.songs.get(id)
  }

  byPath(path: string): SongMeta | undefined {
    const id = songIdFor(path)
    return this.songs.get(id)
  }

  getProgress(): ScanProgress {
    return this.progress
  }

  async addFolder(dir: string): Promise<void> {
    const resolved = dir.replace(/[\\/]+$/, '')
    if (this.folderList.some((f) => f.path.toLowerCase() === resolved.toLowerCase())) {
      await this.rescanFolder(resolved)
      return
    }
    this.folderList = [...this.folderList, { path: resolved, addedAt: Date.now() }]
    this.repo.setFolders(this.folderList)
    this.watchFolder(resolved)
    await this.rescanFolder(resolved)
  }

  async removeFolder(dir: string): Promise<void> {
    this.folderList = this.folderList.filter((f) => f.path !== dir)
    this.repo.setFolders(this.folderList)
    this.watchers.get(dir)?.close()
    this.watchers.delete(dir)
    const prefix = dir.toLowerCase() + sep
    for (const [id, song] of [...this.songs]) {
      if (song.path.toLowerCase().startsWith(prefix) || song.path.toLowerCase() === dir.toLowerCase()) {
        this.songs.delete(id)
        this.repo.remove(id)
        this.pendingRemoved.push(id)
      }
    }
    this.scheduleFlush(true)
  }

  async rescanAll(): Promise<void> {
    for (const folder of this.folderList) await this.rescanFolder(folder.path)
  }

  /** Files or folders dropped onto the window. */
  async importPaths(paths: string[]): Promise<void> {
    for (const p of paths) {
      let stat
      try {
        stat = await fs.stat(p)
      } catch {
        continue
      }
      if (stat.isDirectory()) await this.addFolder(p)
      else if (AUDIO_EXT.has(extname(p).toLowerCase())) await this.scanFiles([p])
    }
  }

  private watchFolder(dir: string): void {
    if (this.watchers.has(dir)) return
    try {
      const watcher = watch(dir, { recursive: true }, (_event, filename) => {
        if (!filename) return this.scheduleRescan(dir)
        const ext = extname(String(filename)).toLowerCase()
        if (AUDIO_EXT.has(ext)) this.scheduleRescan(dir)
        else if (LYRIC_EXT.has(ext)) this.emit('lyricFileChanged', join(dir, String(filename)))
      })
      watcher.on('error', () => {
        watcher.close()
        this.watchers.delete(dir)
      })
      this.watchers.set(dir, watcher)
    } catch {
      /* watcher unavailable for this path */
    }
  }

  private scheduleRescan(dir: string): void {
    if (this.rescanTimer) clearTimeout(this.rescanTimer)
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = null
      void this.rescanFolder(dir)
    }, 1200)
  }

  async rescanFolder(dir: string): Promise<void> {
    if (this.scanning) {
      this.queueAgain = true
      return
    }
    this.scanning = true
    try {
      const files = await this.walk(dir)
      this.progress = {
        active: true,
        stage: 'scanning',
        processed: 0,
        total: files.length,
        currentTitle: '',
        folder: dir
      }
      this.emit('progress', this.progress)
      await this.scanFiles(files)
    } finally {
      this.scanning = false
      this.progress = { ...this.progress, active: false, stage: 'done' }
      this.emit('progress', this.progress)
      this.scheduleFlush(true)
      if (this.queueAgain) {
        this.queueAgain = false
        setTimeout(() => void this.rescanFolder(dir), 500)
      }
    }
  }

  private async walk(root: string): Promise<string[]> {
    const out: string[] = []
    const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }]
    while (stack.length > 0) {
      const { dir, depth } = stack.pop()!
      if (depth > 12) continue
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) stack.push({ dir: full, depth: depth + 1 })
        else if (entry.isFile() && AUDIO_EXT.has(extname(entry.name).toLowerCase())) out.push(full)
      }
    }
    return out
  }

  async scanFiles(files: string[]): Promise<void> {
    let processed = 0
    await pool(files, 4, async (file) => {
      try {
        await this.indexFile(file)
      } catch (err) {
        console.warn('[scan] failed', file, String(err))
      } finally {
        processed++
        if (processed % 10 === 0 || processed === files.length) {
          this.progress = { ...this.progress, processed, total: files.length, stage: 'tags' }
          this.emit('progress', this.progress)
        }
      }
    })
    this.progress = {
      ...this.progress,
      processed: files.length,
      total: files.length,
      active: false,
      stage: 'done'
    }
    this.emit('progress', this.progress)
    this.scheduleFlush(true)
  }

  private async indexFile(file: string): Promise<void> {
    const stat = await fs.stat(file)
    const id = songIdFor(file)
    const existing = this.songs.get(id)
    if (existing && existing.mtimeMs === stat.mtimeMs && existing.fileSize === stat.size) {
      // Unchanged: keep analysis, but make sure the renderer knows about it.
      if (!existing.analysis) this.pendingUpdated.push(existing)
      return
    }

    const tags = await readTags(file)
    let coverId: string | null = null
    let coverSizes: number[] = []
    if (tags.covers.length > 0) {
      const stored = storeCover(tags.covers[0]!.data)
      coverId = stored.id
      coverSizes = stored.sizes
    } else {
      const sidecar = findSidecarCover(file)
      if (sidecar) {
        const data = readCoverFile(sidecar)
        if (data) {
          const stored = storeCover(data)
          coverId = stored.id
          coverSizes = stored.sizes
        }
      }
    }

    if (tags.lyrics) {
      await fs.mkdir(lyricsCacheDir(), { recursive: true })
      await fs.writeFile(join(lyricsCacheDir(), `${id}.json`), JSON.stringify(tags.lyrics), 'utf8')
    }

    const song: SongMeta = {
      id,
      path: file,
      dir: file.slice(0, Math.max(0, file.lastIndexOf(sep))),
      title: tags.title ?? file.split(/[\\/]/).pop() ?? file,
      artists: tags.artists.length > 0 ? tags.artists : ['未知艺人'],
      albumArtist: tags.albumArtist ?? tags.artists[0] ?? '未知艺人',
      album: tags.album ?? '未知专辑',
      trackNo: tags.trackNo,
      trackTotal: tags.trackTotal,
      discNo: tags.discNo,
      discTotal: tags.discTotal,
      year: tags.year,
      genre: tags.genre,
      bpmTag: tags.bpm,
      durationSec: tags.durationSec,
      bitrate: tags.bitrate,
      sampleRate: tags.sampleRate,
      bitDepth: tags.bitDepth,
      channels: tags.channels,
      codec: tags.codec,
      container: tags.container,
      fileSize: stat.size,
      mtimeMs: stat.mtimeMs,
      replayGainTrackGain: tags.replayGainTrackGain,
      replayGainTrackPeak: tags.replayGainTrackPeak,
      replayGainAlbumGain: tags.replayGainAlbumGain,
      credits: tags.credits,
      coverId,
      coverSizes,
      hasEmbeddedLyrics: tags.hasEmbeddedLyrics,
      addedAt: existing?.addedAt ?? Date.now(),
      analysis: existing?.analysis ?? null,
      stem: existing?.stem ?? null
    }

    this.songs.set(id, song)
    this.repo.upsert(song)
    if (existing) this.pendingUpdated.push(song)
    else this.pendingAdded.push(song)
    this.progress = { ...this.progress, currentTitle: song.title }
    this.scheduleFlush(false)
  }

  /** Called by the analysis service so the renderer sees fresh analysis. */
  patchSong(id: string, patch: Partial<SongMeta>): void {
    const song = this.songs.get(id)
    if (!song) return
    const next = { ...song, ...patch }
    this.songs.set(id, next)
    this.repo.upsert(next)
    this.pendingUpdated.push(next)
    this.scheduleFlush(true)
  }

  private scheduleFlush(immediate: boolean): void {
    if (this.flushTimer) return
    const delay = immediate ? 0 : 140
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flush()
    }, delay)
  }

  private flush(): void {
    if (
      this.pendingAdded.length === 0 &&
      this.pendingUpdated.length === 0 &&
      this.pendingRemoved.length === 0
    ) {
      return
    }
    const batch: LibraryBatch = {
      added: this.pendingAdded,
      updated: this.pendingUpdated,
      removed: this.pendingRemoved,
      progress: this.progress
    }
    this.pendingAdded = []
    this.pendingUpdated = []
    this.pendingRemoved = []
    this.emit('batch', batch)
  }

  dispose(): void {
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
    if (this.flushTimer) clearTimeout(this.flushTimer)
    if (this.rescanTimer) clearTimeout(this.rescanTimer)
  }
}
