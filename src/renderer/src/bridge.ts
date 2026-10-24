import type {
  AnalysisProgress,
  AnalysisResult,
  AppSettings,
  LibraryFolder,
  LyricsPayload,
  ScanProgress,
  SongInfoExtra,
  SongMeta
} from '@shared/types'

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  window.lm.invoke<T>(channel, ...args)

export interface Snapshot {
  songs: SongMeta[]
  folders: LibraryFolder[]
  progress: ScanProgress
  indexKind: string
}

export interface Segment {
  left: Float32Array
  right: Float32Array
  sampleRate: number
}

export const bridge = {
  snapshot: () => invoke<Snapshot>('library/snapshot'),
  pickFolder: () => invoke<string[] | null>('library/pickFolder'),
  pickFiles: () => invoke<string[] | null>('library/pickFiles'),
  addFolder: (dir: string) => invoke<LibraryFolder[]>('library/addFolder', dir),
  removeFolder: (dir: string) => invoke<LibraryFolder[]>('library/removeFolder', dir),
  rescan: () => invoke<boolean>('library/rescan'),
  importPaths: (paths: string[]) => invoke<boolean>('library/importPaths', paths),
  lyrics: (songId: string) => invoke<LyricsPayload | null>('lyrics/get', songId),
  segment: (songId: string, start: number, duration: number) =>
    invoke<Segment>('media/segment', { songId, start, duration }),
  songInfo: (songId: string) => invoke<SongInfoExtra | null>('song/info', songId),
  analysisProgress: () => invoke<AnalysisProgress>('analysis/progress'),
  pauseAnalysis: () => invoke<boolean>('analysis/pause'),
  resumeAnalysis: () => invoke<boolean>('analysis/resume'),
  retryAnalysis: () => invoke<boolean>('analysis/retry'),
  orderAnalysis: (ids: string[]) => invoke<boolean>('analysis/order', ids),
  analyzeNow: (songId: string) => invoke<AnalysisResult | null>('analysis/now', songId),
  settings: () => invoke<AppSettings>('settings/get'),
  saveSettings: (patch: Partial<AppSettings>) => invoke<AppSettings>('settings/set', patch),
  showInFolder: (path: string) => invoke<void>('app/showInFolder', path),
  openPath: (path: string) => invoke<void>('app/openPath', path),
  openUserData: () => invoke<void>('app/openUserData'),
  setFullScreen: (value: boolean) => invoke<void>('window/setFullScreen', value),
  gpu: () => invoke<{ accelerated: boolean; renderer: string }>('app/gpu'),
  stems: {
    status: () =>
      invoke<{
        runtime: string
        ready: boolean
        reason: string | null
        models: number
        progress: {
          active: boolean
          stage: string
          title: string
          percent: number
          queued: number
          error: string | null
          lastSeconds: number | null
        }
      }>('stems/status'),
    enqueue: (ids: string[]) => invoke<void>('stems/enqueue', ids),
    pause: () => invoke<void>('stems/pause'),
    resume: () => invoke<void>('stems/resume'),
    cancel: () => invoke<void>('stems/cancel')
  },
  models: {
    status: () =>
      invoke<{ dir: string; files: { name: string; size: number }[]; installed: boolean; url: string }>(
        'models/status'
      ),
    openPage: () => invoke<void>('models/openPage'),
    reveal: () => invoke<void>('models/reveal'),
    import: () => invoke<{ ok: boolean; name?: string; reason?: string }>('models/import')
  },
  on: (channel: string, listener: (payload: never) => void) => window.lm.on(channel, listener)
}

export const coverUrl = (id: string | null, size: 80 | 240 | 640): string | null =>
  id ? `amcover://c/${id}/${size}` : null

export const songUrl = (id: string): string => `amsong://song/${id}`
