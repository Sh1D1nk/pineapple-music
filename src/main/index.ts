import { app, BrowserWindow, globalShortcut, ipcMain, nativeTheme, screen, shell } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LibraryService } from './library/scanner'
import { openRepository } from './library/repository'
import { LyricsService } from './lyrics/lyricsService'
import { AnalysisService } from './media/analysisService'
import { StemService } from './media/stemService'
import { SettingsService } from './settings'
import { registerIpc, wireEvents, applyOverlay } from './ipc'
import { registerProtocols, registerSchemes } from './protocols'
import { windowStateFile } from './paths'

interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

const DEFAULT_STATE: WindowState = { width: 1280, height: 800, maximized: false }

function loadWindowState(): WindowState {
  const file = windowStateFile()
  if (!existsSync(file)) return DEFAULT_STATE
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as WindowState
    if (!raw.width || !raw.height) return DEFAULT_STATE
    // Clamp onto a visible display so a monitor change cannot strand the window.
    const displays = screen.getAllDisplays()
    const visible = displays.some((d) => {
      const b = d.bounds
      return (
        raw.x !== undefined &&
        raw.y !== undefined &&
        raw.x + 200 > b.x &&
        raw.y + 100 > b.y &&
        raw.x < b.x + b.width - 100 &&
        raw.y < b.y + b.height - 100
      )
    })
    return visible ? raw : { ...raw, x: undefined, y: undefined }
  } catch {
    return DEFAULT_STATE
  }
}

let mainWindow: BrowserWindow | null = null
let settingsService: SettingsService | null = null
let libraryService: LibraryService | null = null
let analysisService: AnalysisService | null = null
let stemService: StemService | null = null

registerSchemes()

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

function saveWindowState(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const bounds = win.getNormalBounds()
  const state: WindowState = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    maximized: win.isMaximized()
  }
  try {
    writeFileSync(windowStateFile(), JSON.stringify(state))
  } catch {
    /* ignore */
  }
}

function createWindow(): BrowserWindow {
  const state = loadWindowState()
  const dark = nativeTheme.shouldUseDarkColors
  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: dark ? '#1f1f21' : '#ffffff',
    transparent: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: dark ? '#f5f5f7' : '#1d1d1f',
      height: 48
    },
    title: 'Pineapple Music',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      webSecurity: true,
      spellcheck: false
    }
  })

  if (state.maximized) win.maximize()

  win.once('ready-to-show', () => {
    win.show()
  })

  win.on('close', () => saveWindowState(win))
  win.on('closed', () => {
    mainWindow = null
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

app.whenReady().then(async () => {
  app.setName('Pineapple Music')
  app.setAppUserModelId('com.pineapple.music')

  settingsService = new SettingsService()
  const repo = openRepository()
  libraryService = new LibraryService(repo)
  const lyricsService = new LyricsService()
  analysisService = new AnalysisService(libraryService)
  stemService = new StemService({
    songs: () => libraryService!.snapshot(),
    patchSong: (id, patch) => libraryService!.patchSong(id, patch),
    cacheLimitGB: () => settingsService!.get().automix.cacheLimitGB,
    onProgress: (progress) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('stems/progress', progress)
    }
  })

  await libraryService.init()

  mainWindow = createWindow()
  registerProtocols(libraryService)
  registerIpc({
    library: libraryService,
    lyrics: lyricsService,
    analysis: analysisService,
    stems: stemService,
    settings: settingsService,
    getWindow: () => mainWindow
  })
  wireEvents({
    library: libraryService,
    lyrics: lyricsService,
    analysis: analysisService,
    stems: stemService,
    settings: settingsService,
    getWindow: () => mainWindow
  })

  applyOverlay(mainWindow, settingsService.get())
  nativeTheme.on('updated', () => {
    if (mainWindow && settingsService) applyOverlay(mainWindow, settingsService.get())
  })

  analysisService.start()
  // Stage 1 analysis for everything already indexed, newest imports first.
  const pending = libraryService
    .snapshot()
    .filter((s) => !s.analysis)
    .sort((a, b) => b.addedAt - a.addedAt)
    .map((s) => s.id)
  if (pending.length > 0) analysisService.enqueueMany(pending, 3000)

  registerMediaKeys()

  ipcMain.on('files/dropped', (_e, paths: string[]) => {
    if (Array.isArray(paths) && paths.length > 0) void libraryService?.importPaths(paths)
  })

  ipcMain.handle('window/state', () => ({
    maximized: mainWindow?.isMaximized() ?? false,
    fullScreen: mainWindow?.isFullScreen() ?? false
  }))

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
})

function registerMediaKeys(): void {
  const send = (action: string): void => {
    mainWindow?.webContents.send('media/key', action)
  }
  const bindings: [string, string][] = [
    ['MediaPlayPause', 'toggle'],
    ['MediaNextTrack', 'next'],
    ['MediaPreviousTrack', 'previous'],
    ['MediaStop', 'stop']
  ]
  for (const [accelerator, action] of bindings) {
    try {
      globalShortcut.register(accelerator, () => send(action))
    } catch {
      /* the OS may refuse; the in-app shortcuts still work */
    }
  }
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', () => {
  globalShortcut.unregisterAll()
  analysisService?.dispose()
  libraryService?.dispose()
})
