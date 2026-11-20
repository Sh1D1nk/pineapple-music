/**
 * 汽水音乐插件 ↔ Pinnet 的联动协议（v1）。
 *
 * 架构（与原描述的差异，理由见汇报）：
 *   插件运行在汽水音乐的 **renderer**（没有 Node 权限，无法监听端口），
 *   所以由 **Pinnet 主进程** 在 127.0.0.1 上开 WebSocket 服务端，
 *   插件作为客户端主动连接。这样：
 *     - 插件侧只需要浏览器自带的 WebSocket，零依赖；
 *     - 端口只绑定回环地址，凭 token 握手，外部无法连入；
 *     - Pinnet 先启动/后启动、插件先启动/后启动都能靠重连覆盖。
 *
 * 端口：17891（可在插件设置里改，Pinnet 侧固定监听该端口）
 * 鉴权：连接 URL 带 ?token=xxx；token 在 Pinnet 设置里生成/展示
 */

export const NETMUSIC_PORT = 17891
export const NETMUSIC_DEFAULT_TOKEN = 'pinnet'

export interface NetTrack {
  id: string
  title: string
  artists: string
  album: string
  /** 宿主给的封面地址；插件会转成可直接加载的 URL */
  coverUrl: string | null
  durationMs: number
}

/** 与 @applemusic-like-lyrics/lyric 的 LyricLine 兼容（插件直接用 AMLL 的行结构） */
export interface NetLyricWord {
  word: string
  startTime: number
  endTime: number
}

export interface NetLyricLine {
  startTime: number
  endTime: number
  words: NetLyricWord[]
  translatedLyric?: string
  romanLyric?: string
  isBG?: boolean
  isDuet?: boolean
}

/** 插件 → Pinnet 的完整状态（只在变化时推；进度另发心跳） */
export interface NetSnapshot {
  track: NetTrack | null
  lyrics: NetLyricLine[]
  playing: boolean
  /** 插件侧测量的当前位置（ms） */
  positionMs: number
  durationMs: number
  volume: number
  muted: boolean
  /** 插件版本，用于版本不匹配提示 */
  pluginVersion: string
}

/** 进度心跳：带时间戳，Pinnet 本地插值 */
export interface NetHeartbeat {
  positionMs: number
  playing: boolean
  at: number
}

export type NetCommand =
  | { type: 'toggle' }
  | { type: 'prev' }
  | { type: 'next' }
  | { type: 'seek'; value: number }
  | { type: 'volume'; value: number }

/** 插件 → Pinnet */
export type NetClientMessage =
  | { type: 'hello'; version: string; token?: string }
  | { type: 'state'; snapshot: NetSnapshot }
  | { type: 'heartbeat'; heartbeat: NetHeartbeat }

/** Pinnet → 插件 */
export type NetServerMessage =
  | { type: 'welcome'; server: string; version: number }
  | { type: 'command'; command: NetCommand }
  | { type: 'ping' }

/** Pinnet 渲染进程看到的连接状态 */
export interface NetStatus {
  listening: boolean
  connected: boolean
  pluginVersion: string | null
  token: string
  port: number
  lastError: string | null
}
