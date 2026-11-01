import { BrowserWindow, Tray, nativeImage, nativeTheme, screen, type NativeImage } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { coverFile } from './library/covers'

/**
 * 系统托盘 + 自绘玻璃菜单。
 *
 * 托盘图标不读文件：直接按像素画（橙色渐变圆 + 白色音符），4× 超采样后下采样，
 * 这样任务栏在 100%/125%/150% 缩放下都有清晰的 16/32px 图标。
 *
 * 菜单不是原生 Menu（原生菜单无法做玻璃/圆角），而是一个无边框透明窗口，
 * 加载同一个 renderer 的 ?overlay=tray 分支，由 CSS + hyalite 画液态玻璃。
 */

export interface TrayPlaybackState {
  playing: boolean
  hasTrack: boolean
  title: string
  artist: string
  volume: number
  /** 当前曲目的封面 id（covers.ts 的内容哈希），托盘图标直接用它 */
  coverId?: string | null
}

export interface TrayHostOptions {
  /** 主窗口渲染 URL（dev）或文件路径（prod） */
  renderer: { url?: string; file?: string }
  onCommand: (command: 'toggle' | 'next' | 'previous') => void
  onOpenMain: () => void
  onQuit: () => void
  onVolume?: (value: number) => void
}

const MENU_WIDTH = 258
const MENU_HEIGHT = 296
/** Windows 托盘按 16px 显示，直接给 16 比给 32 再缩放更锐利 */
const TRAY_ICON = 16
const ICON_SIZE = 32

/** 32×32：橙渐变圆 + 白色音符（4× 超采样，边缘用距离场抗锯齿）。 */
function createTrayIcon(): NativeImage {
  const ss = 4
  const w = ICON_SIZE * ss
  const rgba = new Uint8ClampedArray(w * w * 4)
  const cx = w / 2
  const cy = w / 2
  const radius = w * 0.47

  const blend = (x: number, y: number, color: [number, number, number], alpha: number): void => {
    if (alpha <= 0) return
    const i = (y * w + x) * 4
    const a = Math.min(1, alpha)
    const da = rgba[i + 3]! / 255
    const oa = a + da * (1 - a)
    if (oa <= 0) return
    rgba[i] = Math.round((color[0] * a + rgba[i]! * da * (1 - a)) / oa)
    rgba[i + 1] = Math.round((color[1] * a + rgba[i + 1]! * da * (1 - a)) / oa)
    rgba[i + 2] = Math.round((color[2] * a + rgba[i + 2]! * da * (1 - a)) / oa)
    rgba[i + 3] = Math.round(oa * 255)
  }

  const inRect = (x: number, y: number, x0: number, y0: number, x1: number, y1: number): number => {
    // 返回到矩形的有符号距离（>0 在内），单位：超采样像素
    const dx = Math.min(x - x0, x1 - x)
    const dy = Math.min(y - y0, y1 - y)
    return Math.min(dx, dy)
  }

  // 音符几何（按 32 网格定义，再乘 ss）
  const s = (v: number): number => v * ss
  const stem1 = [s(10), s(11), s(12.6), s(21.6)]
  const stem2 = [s(19.4), s(8), s(22), s(18.6)]
  const beam = [s(10), s(8), s(22), s(11)]
  const head1 = { x: s(9.4), y: s(21.6), r: s(3.4) }
  const head2 = { x: s(18.8), y: s(18.6), r: s(3.4) }

  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      // 圆底
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
      const circleAlpha = Math.max(0, Math.min(1, radius - d + 0.5))
      if (circleAlpha > 0) {
        const t = Math.min(1, Math.max(0, (x + y) / (2 * w)))
        blend(x, y, [255, Math.round(186 - 62 * t), Math.round(80 - 56 * t)], circleAlpha)
      }
      // 音符
      const px = x + 0.5
      const py = y + 0.5
      const distStem = Math.max(
        inRect(px, py, stem1[0]!, stem1[1]!, stem1[2]!, stem1[3]!),
        inRect(px, py, stem2[0]!, stem2[1]!, stem2[2]!, stem2[3]!),
        inRect(px, py, beam[0]!, beam[1]!, beam[2]!, beam[3]!)
      )
      const distHead = Math.max(
        head1.r - Math.hypot(px - head1.x, py - head1.y),
        head2.r - Math.hypot(px - head2.x, py - head2.y)
      )
      const noteAlpha = Math.max(0, Math.min(1, Math.max(distStem, distHead) + 0.5))
      if (noteAlpha > 0) blend(x, y, [255, 255, 255], noteAlpha)
    }
  }

  // 下采样：平均到 32×32，写成 BGRA（createFromBitmap 期望的字节序）
  const out = Buffer.alloc(ICON_SIZE * ICON_SIZE * 4)
  for (let y = 0; y < ICON_SIZE; y++) {
    for (let x = 0; x < ICON_SIZE; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let dy = 0; dy < ss; dy++) {
        for (let dx = 0; dx < ss; dx++) {
          const i = ((y * ss + dy) * w + (x * ss + dx)) * 4
          r += rgba[i]!
          g += rgba[i + 1]!
          b += rgba[i + 2]!
          a += rgba[i + 3]!
        }
      }
      const n = ss * ss
      const o = (y * ICON_SIZE + x) * 4
      out[o] = Math.round(b / n)
      out[o + 1] = Math.round(g / n)
      out[o + 2] = Math.round(r / n)
      out[o + 3] = Math.round(a / n)
    }
  }
  const image = nativeImage.createFromBitmap(out, { width: ICON_SIZE, height: ICON_SIZE })
  if (image.isEmpty()) return image
  try {
    return image.resize({ width: TRAY_ICON, height: TRAY_ICON, quality: 'best' })
  } catch {
    return image
  }
}

export class TrayController {
  private tray: Tray | null = null
  private menu: BrowserWindow | null = null
  private state: TrayPlaybackState = {
    playing: false,
    hasTrack: false,
    title: '',
    artist: '',
    volume: 1,
    coverId: null
  }
  /** 没有封面时的兜底图标（自绘，和封面的圆形裁切观感接近） */
  private fallbackIcon: NativeImage | null = null
  private ready = false

  constructor(private readonly opts: TrayHostOptions) {}

  start(): void {
    if (this.tray) return
    try {
      this.fallbackIcon = createTrayIcon()
      this.tray = new Tray(this.fallbackIcon)
    } catch (err) {
      // 托盘创建失败不能影响主窗口：记一笔就放弃托盘
      console.error('[tray] create failed:', err)
      return
    }
    this.tray.setToolTip('Pineapple Music')
    // 左键和右键都打开同一份自绘菜单
    this.tray.on('click', () => this.toggleMenu())
    this.tray.on('right-click', () => this.toggleMenu())
    // 菜单窗口懒创建：只有第一次点托盘时才建，启动时不占用渲染进程/内存，
    // 也不会在窗口枚举里多出一个隐藏窗口。
  }

  updateState(patch: Partial<TrayPlaybackState>): void {
    this.state = { ...this.state, ...patch }
    if (this.tray) {
      const label = this.state.hasTrack
        ? `${this.state.playing ? '正在播放' : '已暂停'} · ${this.state.title}${this.state.artist ? ' — ' + this.state.artist : ''}`
        : 'Pineapple Music'
      this.tray.setToolTip(label)
    }
    if (patch.coverId !== undefined) this.applyIcon()
    if (this.menu && !this.menu.isDestroyed() && this.ready) {
      this.menu.webContents.send('overlay/tray-state', this.state)
    }
  }

  /** 托盘图标 = 当前专辑封面（缩到 16px，圆角矩形裁切观感），没有封面时用兜底图标 */
  private applyIcon(): void {
    const tray = this.tray
    if (!tray) return
    const id = this.state.coverId
    if (id) {
      const file = coverFile(id, 80)
      if (existsSync(file)) {
        const image = nativeImage.createFromPath(file).resize({ width: TRAY_ICON, height: TRAY_ICON, quality: 'best' })
        if (!image.isEmpty()) {
          tray.setImage(image)
          return
        }
      }
    }
    if (this.fallbackIcon) tray.setImage(this.fallbackIcon)
  }

  /** 主窗口显示/隐藏时同步（隐藏到托盘后，菜单里的「打开主窗口」才有意义） */
  destroy(): void {
    this.menu?.destroy()
    this.menu = null
    this.tray?.destroy()
    this.tray = null
  }

  private ensureMenu(): void {
    if (this.menu && !this.menu.isDestroyed()) return
    const menu = new BrowserWindow({
      width: MENU_WIDTH,
      height: MENU_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    })
    menu.setAlwaysOnTop(true, 'pop-up-menu')
    menu.on('blur', () => {
      if (!menu.isDestroyed()) menu.hide()
    })
    menu.on('closed', () => {
      this.menu = null
    })
    menu.webContents.on('did-finish-load', () => {
      this.ready = true
      menu.webContents.send('overlay/tray-state', this.state)
    })
    const { url, file } = this.opts.renderer
    const dark = nativeTheme.shouldUseDarkColors ? '1' : '0'
    if (url) void menu.loadURL(`${url}?overlay=tray&dark=${dark}`)
    else if (file) void menu.loadFile(file, { query: { overlay: 'tray', dark } })
    this.menu = menu
  }

  /** 菜单命令：由渲染进程通过 IPC 发回，主进程再转给主窗口执行 */
  handleCommand(command: string | { type: 'volume'; value: number }): void {
    if (typeof command === 'object' && command?.type === 'volume') {
      this.opts.onVolume?.(command.value)
      return
    }
    const key = String(command)
    if (key === 'toggle' || key === 'next' || key === 'previous') {
      this.opts.onCommand(key)
    } else if (key === 'open-main') {
      this.hideMenu()
      this.opts.onOpenMain()
    } else if (key === 'quit') {
      this.hideMenu()
      this.opts.onQuit()
    }
  }

  /** 渲染进程量出来的内容高度 → 窗口高度，避免底部留一块空白 */
  setMenuHeight(height: number): void {
    const menu = this.menu
    if (!menu || menu.isDestroyed()) return
    const next = Math.max(180, Math.min(560, Math.round(height)))
    const size = menu.getContentSize()
    const currentWidth = size[0] ?? 0
    const currentHeight = size[1] ?? 0
    if (Math.abs(currentHeight - next) <= 1 && currentWidth === MENU_WIDTH) return
    menu.setContentSize(MENU_WIDTH, next)
  }

  hideMenu(): void {
    this.menu?.hide()
  }

  private toggleMenu(): void {
    if (!this.menu) this.ensureMenu()
    const menu = this.menu
    if (!menu) return
    if (menu.isVisible()) {
      menu.hide()
      return
    }
    this.positionMenu(menu)
    menu.show()
    menu.focus()
    if (this.ready) menu.webContents.send('overlay/tray-state', this.state)
  }

  /** 贴在托盘图标上方（任务栏在底部）或下方（任务栏在顶部/侧边） */
  private positionMenu(menu: BrowserWindow): void {
    const tray = this.tray
    if (!tray) return
    const bounds = tray.getBounds()
    const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y })
    const area = display.workArea
    const centerX = bounds.x + bounds.width / 2 - MENU_WIDTH / 2
    const x = Math.max(area.x + 8, Math.min(area.x + area.width - MENU_WIDTH - 8, centerX))
    const above = bounds.y > area.y + area.height / 2
    const y = above ? bounds.y - MENU_HEIGHT - 8 : bounds.y + bounds.height + 8
    menu.setBounds({ x: Math.round(x), y: Math.round(y), width: MENU_WIDTH, height: MENU_HEIGHT })
  }
}
