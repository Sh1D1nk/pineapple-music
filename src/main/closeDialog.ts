import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'

/**
 * 关闭主窗口时的自绘确认框。
 *
 * 不用 dialog.showMessageBox：原生对话框无法做圆角玻璃，和应用的视觉语言不搭。
 * 这里开一个无边框透明小窗，加载同一个 renderer 的 ?overlay=close 分支，
 * 由 CSS + hyalite 画液态玻璃，用户的选择通过 IPC 回传。
 */

export type CloseAction = 'background' | 'quit'

export interface CloseDecision {
  action: CloseAction | 'cancel'
  /** 勾选「记住我的选择」时为 true —— 主进程会写进 settings.closeBehavior */
  remember: boolean
}

export interface OverlayRenderer {
  url?: string
  file?: string
}

const DIALOG_WIDTH = 432
const DIALOG_HEIGHT = 244

let pending: { resolve: (value: CloseDecision) => void } | null = null

/** 供 IPC 调用：渲染进程点了按钮 */
export function resolveCloseDecision(decision: CloseDecision): void {
  const waiter = pending
  pending = null
  waiter?.resolve(decision)
}

export function askCloseBehavior(
  parent: BrowserWindow | null,
  renderer: OverlayRenderer,
  dark: boolean
): Promise<CloseDecision> {
  return new Promise<CloseDecision>((resolve) => {
    const area = parent && !parent.isDestroyed()
      ? parent.getBounds()
      : screen.getPrimaryDisplay().workArea
    const x = Math.round(area.x + (area.width - DIALOG_WIDTH) / 2)
    const y = Math.round(area.y + (area.height - DIALOG_HEIGHT) / 2)

    const dialog = new BrowserWindow({
      x,
      y,
      width: DIALOG_WIDTH,
      height: DIALOG_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      parent: parent && !parent.isDestroyed() ? parent : undefined,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    })

    dialog.setAlwaysOnTop(true, 'modal-panel')
    let settled = false
    const finish = (value: CloseDecision): void => {
      if (settled) return
      settled = true
      pending = null
      resolve(value)
      if (!dialog.isDestroyed()) dialog.destroy()
    }
    pending = { resolve: finish }

    dialog.once('ready-to-show', () => dialog.show())
    dialog.on('closed', () => {
      if (!settled) {
        settled = true
        pending = null
        resolve({ action: 'cancel', remember: false })
      }
    })
    // Esc 关闭 = 取消（不关主窗口）
    dialog.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') finish({ action: 'cancel', remember: false })
    })

    const { url, file } = renderer
    if (url) void dialog.loadURL(`${url}?overlay=close&dark=${dark ? '1' : '0'}`)
    else if (file) void dialog.loadFile(file, { query: { overlay: 'close', dark: dark ? '1' : '0' } })
  })
}
