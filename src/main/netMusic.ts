import { WebSocketServer, type WebSocket } from 'ws'
import type {
  NetClientMessage,
  NetCommand,
  NetHeartbeat,
  NetSnapshot,
  NetStatus
} from '@shared/netmusic'
import { NETMUSIC_PORT } from '@shared/netmusic'

/**
 * 汽水音乐插件的本地桥（Pinnet 侧服务端）。
 *
 * 插件在汽水 renderer 里没有 Node 权限，开不了端口，所以服务端放这里，
 * 插件当客户端连过来；见 shared/netmusic.ts 的说明。
 *
 * 只绑定 127.0.0.1，握手校验 token；掉线后插件自己重连，这里不做主动探测。
 */

interface BridgeOptions {
  port?: number
  token: () => string
  /** 状态变化（snapshot / 心跳）时回调给渲染进程 */
  onSnapshot: (snapshot: NetSnapshot) => void
  /** 进度心跳：只带 position/playing，渲染进程单独处理，避免歌词随之重建 */
  onHeartbeat: (heartbeat: NetHeartbeat) => void
  onStatus: (status: NetStatus) => void
}

export class NetMusicBridge {
  private server: WebSocketServer | null = null
  private client: WebSocket | null = null
  private pluginVersion: string | null = null
  private lastError: string | null = null
  private snapshot: NetSnapshot | null = null
  /** 绑定失败（EADDRINUSE：上一个实例的 TIME_WAIT 还没释放）时的重试 */
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private startAttempts = 0

  constructor(private readonly opts: BridgeOptions) {}

  status(): NetStatus {
    return {
      listening: Boolean(this.server),
      connected: Boolean(this.client && this.client.readyState === 1),
      pluginVersion: this.pluginVersion,
      token: this.opts.token(),
      port: this.opts.port ?? NETMUSIC_PORT,
      lastError: this.lastError
    }
  }

  start(): void {
    if (this.server) return
    const port = this.opts.port ?? NETMUSIC_PORT
    try {
      this.server = new WebSocketServer({ host: '127.0.0.1', port })
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      this.emitStatus()
      this.scheduleRetry()
      return
    }
    this.server.on('listening', () => {
      console.log('[netmusic] bridge listening on 127.0.0.1:' + port)
      this.startAttempts = 0
      this.lastError = null
      this.emitStatus()
    })
    this.server.on('error', (err: Error) => {
      console.log('[netmusic] bridge error:', err.message)
      this.lastError = err.message
      this.emitStatus()
      // TIME_WAIT / 端口被占：退避重试，直到绑上（Windows 上重启后要等 2 分钟才释放）
      this.server?.close()
      this.server = null
      this.scheduleRetry()
    })
    this.server.on('connection', (socket, request) => {
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
      console.log('[netmusic] connection attempt, token match:', url.searchParams.get('token') === this.opts.token())
      if (url.searchParams.get('token') !== this.opts.token()) {
        socket.close(4001, 'bad token')
        return
      }
      // 单客户端：新的连接顶掉旧的（汽水重启后旧 socket 可能还没断）
      if (this.client && this.client !== socket) {
        try {
          this.client.close(4000, 'replaced')
        } catch {
          /* ignore */
        }
      }
      this.client = socket
      this.emitStatus()
      console.log('[netmusic] plugin connected, version:', String(this.pluginVersion))
      socket.on('message', (raw) => this.onMessage(raw.toString()))
      socket.on('close', () => {
        console.log('[netmusic] plugin socket closed')
        if (this.client === socket) {
          this.client = null
          this.pluginVersion = null
          this.emitStatus()
        }
      })
      socket.on('error', () => {
        if (this.client === socket) {
          this.client = null
          this.emitStatus()
        }
      })
      this.send({ type: 'welcome', server: 'pinnet', version: 1 })
    })
  }

  stop(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.client?.close()
    this.client = null
    this.server?.close()
    this.server = null
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.startAttempts >= 30) return
    this.startAttempts++
    const delay = Math.min(8000, 1000 * this.startAttempts)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.start()
    }, delay)
  }

  /** 渲染进程发来的控制指令 → 插件 */
  command(command: NetCommand): boolean {
    if (!this.client || this.client.readyState !== 1) return false
    this.send({ type: 'command', command })
    return true
  }

  latest(): { snapshot: NetSnapshot | null; status: NetStatus } {
    return { snapshot: this.snapshot, status: this.status() }
  }

  private onMessage(raw: string): void {
    let msg: NetClientMessage
    try {
      msg = JSON.parse(raw) as NetClientMessage
    } catch {
      return
    }
    if (msg.type === 'hello') {
      this.pluginVersion = msg.version
      this.emitStatus()
      return
    }
    if (msg.type === 'state') {
      this.snapshot = msg.snapshot
      this.opts.onSnapshot(msg.snapshot)
      return
    }
    if (msg.type === 'heartbeat') {
      if (this.snapshot) {
        this.snapshot.positionMs = msg.heartbeat.positionMs
        this.snapshot.playing = msg.heartbeat.playing
      }
      this.opts.onHeartbeat(msg.heartbeat)
    }
  }

  private send(message: unknown): void {
    try {
      this.client?.send(JSON.stringify(message))
    } catch {
      /* ignore */
    }
  }

  private emitStatus(): void {
    this.opts.onStatus(this.status())
  }
}

function emptySnapshot(): NetSnapshot {
  return {
    track: null,
    lyrics: [],
    playing: false,
    positionMs: 0,
    durationMs: 0,
    volume: 1,
    muted: false,
    pluginVersion: 'unknown'
  }
}
