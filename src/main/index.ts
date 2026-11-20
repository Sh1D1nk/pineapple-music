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
import { TrayController } from './tray'
import { NetMusicBridge } from './netMusic'
import { askCloseBehavior, resolveCloseDecision, type CloseDecision } from './closeDialog'

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
let trayController: TrayController | null = null
let netMusic: NetMusicBridge | null = null
/** 真正要退出时为 true：close 拦截放行，避免「后台播放」把自己锁在里面 */
let quitting = false
let closeDialogOpen = false

const rendererTarget = (): { url?: string; file?: string } => ({
  url: process.env['ELECTRON_RENDERER_URL'],
  file: join(__dirname, '../renderer/index.html')
})

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/** 关闭到后台：只隐藏窗口，播放继续，托盘图标留在系统隐藏图标区 */
function hideToTray(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.hide()
  trayController?.start()
}

// 必须在读取任何 app.getPath('userData') 之前改名，否则会落到旧目录
app.setName('Pinnet')
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
    title: 'Pinnet',
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

  win.on('close', (event) => {
    saveWindowState(win)
    if (quitting) return
    if (closeDialogOpen) {
      event.preventDefault()
      return
    }
    const behavior = settingsService?.get().closeBehavior ?? 'ask'
    if (behavior === 'background') {
      event.preventDefault()
      hideToTray()
      return
    }
    if (behavior === 'quit') {
      // 记忆为「直接关闭」：放行这次 close，window-all-closed 会退出应用
      quitting = true
      return
    }
    event.preventDefault()
    closeDialogOpen = true
    void askCloseBehavior(win, rendererTarget(), nativeTheme.shouldUseDarkColors).then((decision) => {
      closeDialogOpen = false
      if (decision.action === 'cancel') return
      if (decision.remember) settingsService?.patch({ closeBehavior: decision.action })
      if (decision.action === 'background') hideToTray()
      else {
        quitting = true
        app.quit()
      }
    })
  })
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
  app.setAppUserModelId('com.pinnet.player')

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

  trayController = new TrayController({
    renderer: rendererTarget(),
    onCommand: (command) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('media/key', command)
    },
    onVolume: (value) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('media/volume', value)
    },
    onOpenMain: showMainWindow,
    onQuit: () => {
      quitting = true
      app.quit()
    }
  })
  trayController.start()

  netMusic = new NetMusicBridge({
    token: () => settingsService?.get().netMusicToken || 'pinnet',
    onSnapshot: (snapshot) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('netmusic/state', { snapshot })
    },
    onHeartbeat: (heartbeat) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('netmusic/heartbeat', heartbeat)
    },
    onStatus: (status) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('netmusic/status', status)
    }
  })
  netMusic.start()

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

  ipcMain.handle('netmusic/status', () => {
    const latest = netMusic?.latest()
    return { status: latest?.status ?? { listening: false, connected: false, pluginVersion: null, token: 'pinnet', port: 17891, lastError: null }, snapshot: latest?.snapshot ?? null }
  })
  ipcMain.handle('netmusic/command', (_e, command) => Boolean(netMusic?.command(command)))
  ipcMain.on('overlay/close-decision', (_e, decision: CloseDecision) => resolveCloseDecision(decision))
  ipcMain.on('overlay/tray-command', (_e, command: string | { type: 'volume'; value: number }) =>
    trayController?.handleCommand(command)
  )
  ipcMain.on('overlay/tray-height', (_e, height: number) => {
    if (Number.isFinite(height)) trayController?.setMenuHeight(height)
  })
  ipcMain.on('media/state', (_e, state: { playing: boolean; hasTrack: boolean; title: string; artist: string; volume: number; coverId?: string | null }) => {
    trayController?.updateState(state)
  })

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

/**
 * pinnet://play?token=xxx —— 汽水音乐插件的「在 Pinnet 里播放」按钮。
 * 单实例环境下第二次启动会把 URL 放到 argv，这里解析后打开网络音乐页。
 */
function handleProtocolUrl(raw: string | undefined): void {
  if (!raw || !raw.startsWith('pinnet://')) return
  showMainWindow()
  if (!mainWindow) return
  try {
    const url = new URL(raw)
    if (url.hostname === 'play' || url.pathname === '/play') {
      mainWindow.webContents.send('navigate', { kind: 'netmusic' })
      const token = url.searchParams.get('token')
      if (token && settingsService && token !== settingsService.get().netMusicToken) {
        settingsService.patch({ netMusicToken: token })
      }
    }
  } catch {
    /* ignore malformed URLs */
  }
}

/* 开发模式下必须显式带上 app 目录：打包后 exe 自身就是 app，直接 "%1" 即可；
   开发时注册成 `electron.exe "%1"` 会让 Windows 把 pinnet:// URL 当成 app 路径，
   弹 "Error launching app"。 */
if (app.isPackaged) {
  app.setAsDefaultProtocolClient('pinnet')
} else {
  app.setAsDefaultProtocolClient('pinnet', process.execPath, [app.getAppPath()])
}
app.on('open-url', (event, url) => {
  event.preventDefault()
  handleProtocolUrl(url)
})

app.on('second-instance', (_event, argv) => {
  const url = argv.find((arg) => arg.startsWith('pinnet://'))
  if (url) {
    handleProtocolUrl(url)
    return
  }
  showMainWindow()
})

// 冷启动时协议 URL 在 argv 里
handleProtocolUrl(process.argv.find((arg) => arg.startsWith('pinnet://')))

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', () => {
  quitting = true
  netMusic?.stop()
  netMusic = null
  trayController?.destroy()
  trayController = null
  globalShortcut.unregisterAll()
  analysisService?.dispose()
  libraryService?.dispose()
})
