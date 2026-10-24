import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AnalysisProgress,
  AnalysisResult,
  AppSettings,
  LibraryBatch,
  LibraryFolder,
  LyricsPayload,
  ScanProgress,
  SongInfoExtra,
  SongMeta
} from '@shared/types'

export interface SegmentResponse {
  left: Float32Array
  right: Float32Array
  sampleRate: number
}

const INVOKE_CHANNELS = [
  'library/snapshot',
  'library/pickFolder',
  'library/pickFiles',
  'library/addFolder',
  'library/removeFolder',
  'library/rescan',
  'library/importPaths',
  'lyrics/get',
  'media/segment',
  'song/info',
  'analysis/progress',
  'analysis/pause',
  'analysis/resume',
  'analysis/retry',
  'analysis/order',
  'analysis/now',
  'settings/get',
  'settings/set',
  'app/showInFolder',
  'app/openPath',
  'app/openUserData',
  'app/version',
  'app/gpu',
  'stems/status',
  'stems/enqueue',
  'stems/pause',
  'stems/resume',
  'stems/cancel',
  'models/status',
  'models/openPage',
  'models/reveal',
  'models/import',
  'favorites/get',
  'favorites/toggle',
  'app/openExternal',
  'window/setFullScreen',
  'window/isFullScreen',
  'window/toggleMaximize',
  'window/state'
] as const

type InvokeChannel = (typeof INVOKE_CHANNELS)[number]

const api = {
  invoke<T>(channel: InvokeChannel, ...args: unknown[]): Promise<T> {
    if (!INVOKE_CHANNELS.includes(channel)) {
      return Promise.reject(new Error(`blocked channel: ${channel}`))
    }
    return ipcRenderer.invoke(channel, ...args) as Promise<T>
  },
  on(channel: string, listener: (payload: any) => void): () => void {
    const handler = (_event: unknown, payload: any): void => listener(payload)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  }
}

contextBridge.exposeInMainWorld('lm', api)

// File drops are resolved here: the renderer never sees a File with a usable path in Electron 32+,
// but preload can still ask webUtils. Capture phase so the drop always reaches us.
window.addEventListener(
  'drop',
  (event: DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    const files = event.dataTransfer?.files
    if (!files || files.length === 0) return
    const paths: string[] = []
    for (const file of Array.from(files)) {
      try {
        const path = webUtils.getPathForFile(file)
        if (path) paths.push(path)
      } catch {
        /* ignore entries without a path */
      }
    }
    if (paths.length > 0) ipcRenderer.send('files/dropped', paths)
  },
  true
)

window.addEventListener('dragover', (event) => {
  event.preventDefault()
})
