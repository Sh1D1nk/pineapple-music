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
  onSnapshot: (snapshot: NetSnapshot, heartbeat: NetHeartbeat | null) => void
  onStatus: (status: NetStatus) => void
}

export class NetMusicBridge {
  private server: WebSocketServer | null = null
  private client: WebSocket | null = null
  private pluginVersion: string | null = null
  private lastError: string | null = null
  private snapshot: NetSnapshot | null = null

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
      return
    }
    this.server.on('listening', () => {
      this.lastError = null
      this.emitStatus()
    })
    this.server.on('error', (err: Error) => {
      this.lastError = err.message
      this.emitStatus()
    })
    this.server.on('connection', (socket, request) => {
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
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
      socket.on('message', (raw) => this.onMessage(raw.toString()))
      socket.on('close', () => {
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
    this.client?.close()
    this.client = null
    this.server?.close()
    this.server = null
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
      this.opts.onSnapshot(msg.snapshot, null)
      return
    }
    if (msg.type === 'heartbeat') {
      if (this.snapshot) {
        this.snapshot.positionMs = msg.heartbeat.positionMs
        this.snapshot.playing = msg.heartbeat.playing
      }
      this.opts.onSnapshot(this.snapshot ?? emptySnapshot(), msg.heartbeat)
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
