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
import { UpdateService } from './updater'
import { askCloseBehavior, resolveCloseDecision, type CloseDecision } from './closeDialog'
import { perfSnapshot, startPerfSampler, stopPerfSampler } from './perf'
import { lowerProcessPriority, noteUserInput, setBackgroundMode } from './governor'

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
let updateService: UpdateService | null = null
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
// 基准测试专用：把 userData 指到临时目录，避免污染真实曲库（bench --profile）
if (process.env.PINNET_USER_DATA) {
  try {
    app.setPath('userData', process.env.PINNET_USER_DATA)
  } catch {
    /* ignore */
  }
}
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
  // 性能对照：bench 用 PINNET_PERF_LEGACY=1 启动，同一份构建里走「上一版」路径
  const perfLegacy = process.env.PINNET_PERF_LEGACY === '1'
  const noKeepAlive = process.env.PINNET_PERF_NO_KEEPALIVE === '1'
  const params: Record<string, string> | undefined = perfLegacy ? { perfLegacy: '1' } : noKeepAlive ? { perfNoKeepAlive: '1' } : undefined
  const query = params ? { query: params } : undefined
  if (devUrl) {
    const suffix = perfLegacy ? '?perfLegacy=1' : noKeepAlive ? '?perfNoKeepAlive=1' : ''
    void win.loadURL(`${devUrl}${suffix}`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), query)
  }

  return win
}

app.whenReady().then(async () => {
  app.setAppUserModelId('com.pinnet.player')
  // 后台任务全程低于正常优先级；用户一动手就停（见 governor）
  lowerProcessPriority()
  startPerfSampler()

  settingsService = new SettingsService()
  setBackgroundMode(settingsService.get().backgroundProcessing ?? 'idle')
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
  updateService = new UpdateService()
  updateService.on('status', (status) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update/status', status)
  })

  registerIpc({
    library: libraryService,
    lyrics: lyricsService,
    analysis: analysisService,
    stems: stemService,
    settings: settingsService,
    updater: updateService,
    getWindow: () => mainWindow
  })
  wireEvents({
    library: libraryService,
    lyrics: lyricsService,
    analysis: analysisService,
    stems: stemService,
    settings: settingsService,
    updater: updateService,
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
  // 性能基准：不自动分析全库（5400 首夹具会让 ffmpeg 把机器拖垮，测出来的数全是噪声）
  if (process.env.PINNET_BENCH !== '1') {
    // Stage 1 analysis for everything already indexed, newest imports first.
    const pending = libraryService
      .snapshot()
      .filter((s) => !s.analysis)
      .sort((a, b) => b.addedAt - a.addedAt)
      .map((s) => s.id)
    if (pending.length > 0) analysisService.enqueueMany(pending, 3000)
  }

  registerMediaKeys()

  // 自动检查更新：启动 8 秒后（让首屏先稳定），只在设置开启时
  if (settingsService.get().autoUpdateCheck !== false) {
    updateService.setAuto(true)
    updateService.scheduleInitialCheck(8000)
  } else {
    updateService.setAuto(false)
  }

  ipcMain.handle('netmusic/status', () => {
    const latest = netMusic?.latest()
    return { status: latest?.status ?? { listening: false, connected: false, pluginVersion: null, token: 'pinnet', port: 17891, lastError: null }, snapshot: latest?.snapshot ?? null }
  })
  ipcMain.handle('netmusic/command', (_e, command) => Boolean(netMusic?.command(command)))

  /* ---- 性能 HUD 的主进程侧探针 ---- */
  ipcMain.handle('perf/main', () => {
    const stemProgress = stemService?.snapshot()
    return perfSnapshot({
      active: Boolean(stemProgress?.active),
      stage: stemProgress?.stage ?? 'idle',
      percent: stemProgress ? Math.round((stemProgress.percent ?? 0) * 100) : 0
    })
  })
  ipcMain.on('perf/input', () => noteUserInput())
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
  stopPerfSampler()
  netMusic?.stop()
  netMusic = null
  updateService?.dispose()
  updateService = null
  trayController?.destroy()
  trayController = null
  globalShortcut.unregisterAll()
  analysisService?.dispose()
  libraryService?.dispose()
})
