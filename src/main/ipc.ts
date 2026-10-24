import { ipcMain, dialog, shell, BrowserWindow, app } from 'electron'
import { join } from 'node:path'
import { copyFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import type {
  AnalysisProgress,
  AppSettings,
  LibraryBatch,
  LibraryFolder,
  LyricsPayload,
  ScanProgress,
  SongInfoExtra,
  SongMeta
} from '@shared/types'
import type { LibraryService } from './library/scanner'
import type { LyricsService } from './lyrics/lyricsService'
import type { AnalysisService } from './media/analysisService'
import type { StemService } from './media/stemService'
import { decodeClip, type PcmClip } from './media/ffmpeg'
import type { SettingsService } from './settings'
import { modelsDir, userDataDir } from './paths'

interface Deps {
  library: LibraryService
  lyrics: LyricsService
  analysis: AnalysisService
  stems: StemService
  settings: SettingsService
  getWindow: () => BrowserWindow | null
}

/** 模型清单页：列出社区常用的 Demucs / MDX-Net ONNX 两轨模型，具体许可以模型页为准。 */
const MODEL_HUB_URL = 'https://huggingface.co/models?search=demucs%20onnx'

const segmentCache = new Map<string, PcmClip>()
const SEGMENT_CACHE_LIMIT = 6

function cacheSegment(key: string, clip: PcmClip): void {
  segmentCache.set(key, clip)
  while (segmentCache.size > SEGMENT_CACHE_LIMIT) {
    const oldest = segmentCache.keys().next().value
    if (oldest === undefined) break
    segmentCache.delete(oldest)
  }
}

export function registerIpc(deps: Deps): void {
  const { library, lyrics, analysis, stems, settings, getWindow } = deps

  ipcMain.handle('library/snapshot', () => ({
    songs: library.snapshot(),
    folders: library.folders(),
    progress: library.getProgress(),
    indexKind: 'sqlite'
  }))

  const broadcastFolders = (): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send('library/folders', library.folders())
  }

  ipcMain.handle('library/pickFolder', async () => {
    const win = getWindow()
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      title: '选择音乐文件夹',
      properties: ['openDirectory', 'multiSelections', 'dontAddToRecent']
    })
    if (result.canceled) return null
    for (const dir of result.filePaths) await library.addFolder(dir)
    broadcastFolders()
    return result.filePaths
  })

  ipcMain.handle('library/pickFiles', async () => {
    const win = getWindow()
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      title: '选择音乐文件',
      properties: ['openFile', 'multiSelections', 'dontAddToRecent'],
      filters: [{ name: '音频文件', extensions: ['mp3', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wav'] }]
    })
    if (result.canceled) return null
    await library.importPaths(result.filePaths)
    return result.filePaths
  })

  ipcMain.handle('library/addFolder', async (_e, dir: string) => {
    await library.addFolder(dir)
    broadcastFolders()
    return library.folders() as LibraryFolder[]
  })

  ipcMain.handle('library/removeFolder', async (_e, dir: string) => {
    await library.removeFolder(dir)
    broadcastFolders()
    return library.folders()
  })

  ipcMain.handle('library/rescan', async () => {
    void library.rescanAll()
    return true
  })

  ipcMain.handle('library/importPaths', async (_e, paths: string[]) => {
    await library.importPaths(paths)
    return true
  })

  ipcMain.handle('lyrics/get', async (_e, songId: string): Promise<LyricsPayload | null> => {
    const song = library.get(songId)
    if (!song) return null
    return lyrics.get(song, settings.get().lyricsPriority)
  })

  ipcMain.handle(
    'media/segment',
    async (_e, req: { songId: string; start: number; duration: number }) => {
      const song = library.get(req.songId)
      if (!song) throw new Error('song not found')
      const key = `${req.songId}:${req.start.toFixed(2)}:${req.duration.toFixed(2)}`
      const cached = segmentCache.get(key)
      if (cached) {
        segmentCache.delete(key)
        segmentCache.set(key, cached)
        return { left: cached.channels[0], right: cached.channels[1], sampleRate: cached.sampleRate }
      }
      const clip = await decodeClip(song.path, {
        start: req.start,
        duration: req.duration,
        channels: 2,
        sampleRate: 44100
      })
      cacheSegment(key, clip)
      return { left: clip.channels[0], right: clip.channels[1], sampleRate: clip.sampleRate }
    }
  )

  ipcMain.handle('song/info', (_e, songId: string): SongInfoExtra | null => {
    const song = library.get(songId)
    if (!song) return null
    return {
      path: song.path,
      dir: song.dir,
      format: song.container.toUpperCase(),
      codec: song.codec,
      bitrate: song.bitrate,
      sampleRate: song.sampleRate,
      bitDepth: song.bitDepth,
      channels: song.channels,
      fileSize: song.fileSize,
      replayGainTrackGain: song.replayGainTrackGain,
      replayGainTrackPeak: song.replayGainTrackPeak,
      analysis: song.analysis,
      stem: song.stem,
      lyricsSource: song.hasEmbeddedLyrics ? '内嵌' : '无'
    }
  })

  ipcMain.handle('analysis/progress', (): AnalysisProgress => analysis.getProgress())

  ipcMain.handle('analysis/pause', () => {
    analysis.pause()
    return true
  })
  ipcMain.handle('analysis/resume', () => {
    analysis.resume()
    return true
  })
  ipcMain.handle('analysis/retry', () => {
    analysis.retryFailures()
    return true
  })
  ipcMain.handle('analysis/order', (_e, ids: string[]) => {
    analysis.setOrder(ids)
    return true
  })
  ipcMain.handle('analysis/now', async (_e, songId: string) => {
    const song = library.get(songId)
    if (!song) return null
    const result = await analysis.analyzeNow(song)
    return result
  })

  ipcMain.handle('settings/get', (): AppSettings => settings.get())
  ipcMain.handle('settings/set', (_e, patch: Partial<AppSettings>) => {
    const next = settings.patch(patch)
    const win = getWindow()
    if (win) applyOverlay(win, next)
    return next
  })

  /* ---- 分轨：模型状态 + 任务控制 ---- */
  ipcMain.handle('stems/status', async () => ({ ...(await stems.status()), progress: stems.snapshot() }))
  ipcMain.handle('stems/enqueue', (_e, ids: string[]) => {
    stems.enqueue(ids)
  })
  ipcMain.handle('stems/pause', () => {
    stems.pause()
  })
  ipcMain.handle('stems/resume', () => {
    stems.resume()
  })
  ipcMain.handle('stems/cancel', () => {
    stems.cancel()
  })

  /* ---- 分轨模型：只负责「放哪、从哪下、怎么导入」，推理仍由 StemService 决定是否可用 ---- */
  ipcMain.handle('models/status', () => {
    const dir = modelsDir()
    let files: { name: string; size: number }[] = []
    try {
      files = readdirSync(dir)
        .filter((name) => name.toLowerCase().endsWith('.onnx'))
        .map((name) => ({ name, size: statSync(join(dir, name)).size }))
    } catch {
      files = []
    }
    return { dir, files, installed: files.length > 0, url: MODEL_HUB_URL }
  })

  ipcMain.handle('models/openPage', () => {
    void shell.openExternal(MODEL_HUB_URL)
  })

  ipcMain.handle('models/reveal', () => {
    void shell.openPath(modelsDir())
  })

  ipcMain.handle('models/import', async () => {
    const win = getWindow()
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      title: '选择分轨模型（.onnx）',
      properties: ['openFile', 'dontAddToRecent'],
      filters: [{ name: 'ONNX 模型', extensions: ['onnx'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return { ok: false, reason: 'canceled' }
    const source = result.filePaths[0]!
    const target = join(modelsDir(), source.split(/[\/]/).pop()!)
    copyFileSync(source, target)
    return { ok: true, name: target.split(/[\/]/).pop() }
  })

  ipcMain.handle('app/showInFolder', (_e, path: string) => {
    if (existsSync(path)) shell.showItemInFolder(path)
  })
  ipcMain.handle('app/openPath', (_e, path: string) => {
    if (existsSync(path)) void shell.openPath(path)
  })
  ipcMain.handle('app/openUserData', () => {
    void shell.openPath(userDataDir())
  })
  ipcMain.handle('app/version', () => app.getVersion())
  ipcMain.handle('app/gpu', () => {
    const status = app.getGPUFeatureStatus() as unknown as Record<string, string>
    const compositing = status['gpu_compositing'] ?? ''
    return {
      accelerated: compositing.includes('enabled') && !compositing.includes('software'),
      renderer: compositing
    }
  })

  ipcMain.handle('window/setFullScreen', (_e, value: boolean) => {
    getWindow()?.setFullScreen(value)
  })
  ipcMain.handle('window/isFullScreen', () => getWindow()?.isFullScreen() ?? false)
  ipcMain.handle('window/toggleMaximize', () => {
    const win = getWindow()
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })
}

export function applyOverlay(win: BrowserWindow, settings: AppSettings): void {
  const dark =
    settings.theme === 'dark' ||
    (settings.theme === 'system' && nativeThemeDark())
  try {
    win.setTitleBarOverlay({
      color: '#00000000',
      symbolColor: dark ? '#f5f5f7' : '#1d1d1f',
      height: 48
    })
  } catch {
    /* overlay unsupported on this platform */
  }
}

function nativeThemeDark(): boolean {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { nativeTheme } = require('electron') as typeof import('electron')
  return nativeTheme.shouldUseDarkColors
}

export interface LibraryEvents {
  onBatch: (batch: LibraryBatch) => void
  onProgress: (progress: ScanProgress) => void
  onAnalysis: (progress: AnalysisProgress) => void
  onLyricsChanged: (songIds: string[]) => void
}

export function wireEvents(deps: Deps): void {
  const { library, lyrics, analysis, getWindow } = deps
  const send = (channel: string, payload: unknown): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }

  library.on('batch', (batch: LibraryBatch) => {
    send('library/batch', batch)
    // Fresh or changed songs go straight into the analysis queue.
    const changed = [...batch.added, ...batch.updated.filter((s) => !s.analysis)].map((s: SongMeta) => s.id)
    if (changed.length > 0) analysis.enqueueMany(changed, 2000)
  })
  library.on('progress', (progress: ScanProgress) => send('library/progress', progress))
  library.on('lyricFileChanged', (path: string) => {
    lyrics.invalidateByPath(path)
    send('lyrics/invalidated', path)
  })
  analysis.on('progress', (progress: AnalysisProgress) => send('analysis/progress', progress))
}
