import { create } from 'zustand'
import type {
  AnalysisProgress,
  AppSettings,
  FavoritesState,
  LibraryBatch,
  LyricsPayload,
  QueueItem,
  RepeatMode,
  ScanProgress,
  SongMeta
} from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import { bridge } from '../bridge'
import { nextQueueIndex, prevQueueIndex } from '../lib/queueNav'
import { engine, type EngineSnapshot } from '../audio/engine'

export type View =
  | { kind: 'recent' }
  | { kind: 'songs' }
  | { kind: 'albums' }
  | { kind: 'artists' }
  | { kind: 'favorites' }
  | { kind: 'album'; key: string }
  | { kind: 'artist'; name: string }
  | { kind: 'search' }
  | { kind: 'settings' }
  | { kind: 'lab' }

export interface ContextMenuState {
  x: number
  y: number
  songId: string
  albumKey?: string
}

/** 歌词页内的菜单：整页右键与歌词行右键共用一套坐标与开关。 */
export interface LyricsMenuState {
  x: number
  y: number
  kind: 'page' | 'line'
  /** 行菜单：该行原文 */
  text?: string
  /** 行菜单：该行译文 / 音译 */
  sub?: string
}

export interface Toast {
  id: number
  text: string
}

let keySeq = 0
const newKey = (): string => `q${++keySeq}`

export const queueItemOf = (songId: string): QueueItem => ({ key: newKey(), songId })

interface PlaybackState {
  queue: QueueItem[]
  index: number
  history: string[]
  playing: boolean
  position: number
  duration: number
  volume: number
  muted: boolean
  shuffle: boolean
  repeat: RepeatMode
  autoMixLabel: string | null
}

interface StoreState {
  ready: boolean
  songs: Record<string, SongMeta>
  songIds: string[]
  folders: { path: string; addedAt: number }[]
  scan: ScanProgress
  analysis: AnalysisProgress
  settings: AppSettings
  favorites: FavoritesState
  view: View
  /** 供鼠标侧键 / Esc 用的返回栈，只在主导航与详情页之间记录 */
  viewHistory: View[]
  navDirection: 'up' | 'down' | 'none'
  search: string
  queueOpen: boolean
  lyricsOpen: boolean
  fullscreen: boolean
  /** 本次全屏页是否由「随机推荐」打开：决定「接下来播放」是否 10 秒后自动隐藏 */
  fsRandomHint: boolean
  coverFlowOpen: boolean
  infoSongId: string | null
  settingsSection: string | null
  contextMenu: ContextMenuState | null
  /** 歌词页右键菜单（整页 / 歌词行） */
  lyricsMenu: LyricsMenuState | null
  /** 歌词页内设置窗 */
  lyricsSettingsOpen: boolean
  /** 自适应画质档位（0 完整 / 3 最省），由歌词页测量帧率后写回，调试页展示 */
  lyricsQualityLevel: number
  toasts: Toast[]
  dragActive: boolean
  playback: PlaybackState
  lyrics: LyricsPayload | null
  lyricsLoading: boolean

  init: () => Promise<void>
  setView: (view: View, options?: { silent?: boolean }) => void
  goBack: () => void
  setSearch: (value: string) => void
  setQueueOpen: (open: boolean) => void
  setLyricsOpen: (open: boolean) => void
  setFullscreen: (open: boolean) => void
  setCoverFlowOpen: (open: boolean) => void
  setInfoSongId: (id: string | null) => void
  setContextMenu: (menu: ContextMenuState | null) => void
  setLyricsMenu: (menu: LyricsMenuState | null) => void
  setLyricsSettingsOpen: (open: boolean) => void
  setLyricsQualityLevel: (level: number) => void
  setDragActive: (active: boolean) => void
  pushToast: (text: string) => void
  dismissToast: (id: number) => void
  toggleFavoriteSong: (id: string) => Promise<void>
  toggleFavoriteAlbum: (key: string) => Promise<void>

  playSongs: (ids: string[], startIndex: number) => void
  playSongNow: (id: string) => void
  playRandom: () => void
  togglePlay: () => void
  next: (auto?: boolean) => void
  prev: () => void
  seek: (seconds: number) => void
  setVolume: (value: number) => void
  toggleMute: () => void
  toggleShuffle: () => void
  cycleRepeat: () => void
  addNext: (ids: string[]) => void
  addLater: (ids: string[]) => void
  removeFromQueue: (key: string) => void
  clearQueue: () => void
  moveInQueue: (from: number, to: number) => void
  jumpToQueueIndex: (index: number) => void

  updateSettings: (patch: Partial<AppSettings>) => Promise<void>
  applyBatch: (batch: LibraryBatch) => void
  setAnalysis: (progress: AnalysisProgress) => void
  setScan: (progress: ScanProgress) => void
  loadLyrics: (songId: string | null) => Promise<void>
}

const emptyScan: ScanProgress = {
  active: false,
  stage: 'idle',
  processed: 0,
  total: 0,
  currentTitle: '',
  folder: null
}

const emptyAnalysis: AnalysisProgress = {
  active: false,
  done: 0,
  total: 0,
  stage: 'idle',
  currentTitle: '',
  failures: [],
  ratePerMin: 0,
  etaSec: null,
  paused: false,
  gpu: 'none',
  workers: 1
}

const PERSIST_KEY = 'localmusic.playback.v1'

interface Persisted {
  songId: string | null
  position: number
  queue: string[]
  index: number
  volume: number
  shuffle: boolean
  repeat: RepeatMode
  view: View
}

function readPersisted(): Persisted | null {
  try {
    const raw = localStorage.getItem(PERSIST_KEY)
    if (!raw) return null
    return JSON.parse(raw) as Persisted
  } catch {
    return null
  }
}

let persistTimer: number | null = null
let initPromise: Promise<void> | null = null
function persist(_state?: StoreState): void {
  if (persistTimer !== null) window.clearTimeout(persistTimer)
  persistTimer = window.setTimeout(() => {
    // 定时器触发时重新读 store：参数快照在 1.2s 延迟里可能已经过期，
    // 用旧快照会把「上次的 view / 进度」写进磁盘（恢复后页面被悄悄换掉）。
    const state = useStore.getState()
    const current = state.playback.queue[state.playback.index]
    const payload: Persisted = {
      songId: current?.songId ?? null,
      position: state.playback.position,
      queue: state.playback.queue.map((item) => item.songId),
      index: state.playback.index,
      volume: state.playback.volume,
      shuffle: state.playback.shuffle,
      repeat: state.playback.repeat,
      view: state.view
    }
    try {
      localStorage.setItem(PERSIST_KEY, JSON.stringify(payload))
    } catch {
      /* storage full — playback position is not worth failing over */
    }
  }, 1200)
}

function shuffleArray<T>(items: T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const a = out[i]!
    out[i] = out[j]!
    out[j] = a
  }
  return out
}

export const useStore = create<StoreState>((set, get) => {
  const syncEngine = (snapshot: EngineSnapshot): void => {
    const state = get()
    const cp = state.playback
    const songId = snapshot.songId
    let queue = cp.queue
    let index = cp.index
    if (songId && queue[index]?.songId !== songId) {
      const found = queue.findIndex((item) => item.songId === songId)
      if (found >= 0) index = found
    }
    set({
      playback: {
        ...cp,
        queue,
        index,
        playing: snapshot.playing,
        position: snapshot.position,
        duration: snapshot.duration || cp.duration,
        volume: snapshot.volume,
        muted: snapshot.muted
      }
    })
    persist(get())
  }

  engine.on(syncEngine)

  return {
    ready: false,
    songs: {},
    songIds: [],
    folders: [],
    scan: emptyScan,
    analysis: emptyAnalysis,
    settings: DEFAULT_SETTINGS,
    favorites: { songs: [], albums: [] },
    view: { kind: 'recent' },
    viewHistory: [],
    navDirection: 'none',
    search: '',
    queueOpen: false,
    lyricsOpen: false,
    fullscreen: false,
    fsRandomHint: false,
    coverFlowOpen: false,
    infoSongId: null,
    settingsSection: null,
    contextMenu: null,
    lyricsMenu: null,
    lyricsSettingsOpen: false,
    lyricsQualityLevel: 0,
    toasts: [],
    dragActive: false,
    lyrics: null,
    lyricsLoading: false,
    playback: {
      queue: [],
      index: 0,
      history: [],
      playing: false,
      position: 0,
      duration: 0,
      volume: 0.85,
      muted: false,
      shuffle: false,
      repeat: 'off',
      autoMixLabel: null
    },

    async init() {
      if (initPromise) return initPromise
      initPromise = (async () => {
        // Subscribe first: a folder can be added while the initial snapshot is still in flight,
        // and those batches must not be lost.
        const buffered: LibraryBatch[] = []
        let collecting = true
        const onBatch = (batch: LibraryBatch): void => {
          if (collecting) buffered.push(batch)
          else get().applyBatch(batch)
        }
        const offBatch = bridge.on('library/batch', onBatch as never)
        bridge.on('library/progress', ((progress: ScanProgress) => get().setScan(progress)) as never)
        bridge.on('library/folders', ((folders: { path: string; addedAt: number }[]) => set({ folders })) as never)
        bridge.on('analysis/progress', ((progress: AnalysisProgress) => get().setAnalysis(progress)) as never)
        bridge.on('media/key', ((key: string) => {
          if (key === 'toggle') get().togglePlay()
          else if (key === 'next') get().next()
          else if (key === 'previous') get().prev()
        }) as never)
        bridge.on('lyrics/invalidated', (() => {
          const songId = engine.snapshot().songId
          void get().loadLyrics(songId)
        }) as never)

        const [snapshot, settings, favorites] = await Promise.all([
          bridge.snapshot(),
          bridge.settings(),
          bridge.favorites.get().catch(() => ({ songs: [], albums: [] }))
        ])
        const map: Record<string, SongMeta> = {}
        for (const song of snapshot.songs) map[song.id] = song
        const ids = snapshot.songs
          .slice()
          .sort((a, b) => b.addedAt - a.addedAt)
          .map((s) => s.id)
        const analysis = await bridge.analysisProgress().catch(() => emptyAnalysis)
        set({
          ready: true,
          songs: map,
          songIds: ids,
          folders: snapshot.folders,
          scan: snapshot.progress,
          settings,
          favorites,
          analysis
        })

        collecting = false
        for (const batch of buffered) get().applyBatch(batch)
        void offBatch

        const persisted = readPersisted()
        if (persisted) {
          const queue = persisted.queue
            .filter((id) => map[id])
            .map((id) => ({ key: newKey(), songId: id }))
          set({
            view: persisted.view ?? { kind: 'recent' },
            playback: {
              ...get().playback,
              queue,
              index: Math.min(persisted.index ?? 0, Math.max(0, queue.length - 1)),
              volume: persisted.volume ?? 0.85,
              shuffle: persisted.shuffle ?? false,
              repeat: persisted.repeat ?? 'off'
            }
          })
          const current = queue[persisted.index ?? 0]
          if (current) {
            const song = map[current.songId]
            if (song) {
              await engine.load(song, { autoplay: false, position: persisted.position ?? 0 })
              // 歌词由「当前歌曲 id」订阅统一驱动，见 store 创建处的说明。
            }
          }
        }

        engine.setVolume(get().playback.volume)
        engine.setEndedHandler(() => {
          const state = get()
          if (state.playback.repeat === 'one' && state.playback.queue[state.playback.index]) {
            const song = state.songs[state.playback.queue[state.playback.index]!.songId]
            if (song) void engine.load(song, { autoplay: true, position: 0 })
            return
          }
          get().next(true)
        })
      })()
      return initPromise
    },

    setView(view, options) {
      const current = get().view
      const same =
        current.kind === view.kind &&
        JSON.stringify(current) === JSON.stringify(view)
      if (same) return
      // 主导航（最近添加/艺人/专辑/歌曲/收藏）的高低决定内容进出方向，做成「向上/向下滚过」的观感
      const order = (v: View): number =>
        v.kind === 'recent'
          ? 0
          : v.kind === 'artists'
            ? 1
            : v.kind === 'albums'
              ? 2
              : v.kind === 'songs'
                ? 3
                : v.kind === 'favorites'
                  ? 4
                  : -1
      const from = order(current)
      const to = order(view)
      const navDirection =
        from >= 0 && to >= 0 && from !== to ? (to > from ? 'down' : 'up') : 'none'
      const history = options?.silent ? get().viewHistory : [...get().viewHistory, current].slice(-24)
      set({ view, viewHistory: history, navDirection })
      persist(get())
    },

    goBack() {
      const history = get().viewHistory
      if (history.length === 0) {
        if (get().fullscreen) get().setFullscreen(false)
        else if (get().lyricsOpen) get().setLyricsOpen(false)
        else if (get().queueOpen) get().setQueueOpen(false)
        return
      }
      const previous = history[history.length - 1]!
      set({ view: previous, viewHistory: history.slice(0, -1), navDirection: 'up' })
      persist(get())
    },
    setSearch(value) {
      // 只在「真的在搜索页」时才把清空导航回最近添加。
      // 之前无条件 view: recent —— Sidebar 挂载时的那次 setSearch('') 会把
      // 刚恢复的专辑详情页打回最近添加（表现为「点进专辑却跳到了最近添加」）。
      const current = get().view
      const view =
        value.length > 0
          ? { kind: 'search' as const }
          : current.kind === 'search'
            ? { kind: 'recent' as const }
            : current
      set({ search: value, view })
      persist(get())
    },
    setQueueOpen(open) {
      set(open ? { queueOpen: true, lyricsOpen: false } : { queueOpen: false })
    },
    setLyricsOpen(open) {
      // 侧边歌词面板与全屏歌词页是两种互斥形态：面板活在 floatLayer（z-index 5），
      // 全屏页在 overlayLayer（z-index 40）之上，两者同时打开只会让面板被整页盖住。
      // 开一个必关另一个，才不会出现「点了歌词按钮却什么都没发生」。
      set(open ? { lyricsOpen: true, queueOpen: false, fullscreen: false } : { lyricsOpen: false })
    },
    setCoverFlowOpen(open) {
      set({ coverFlowOpen: open })
    },

    setFullscreen(open) {
      // 只做应用内全屏：切换系统全屏会把窗口状态搅乱（尤其在最大化时），
      // 真正的系统全屏留给 F11。全屏页与侧边面板互斥，理由见 setLyricsOpen。
      // 退出歌词页时顺手收掉页内菜单与设置窗 —— 否则它们会孤零零地浮在别的页面上。
      set(
        open
          ? { fullscreen: true, lyricsOpen: false, lyricsMenu: null, fsRandomHint: false }
          : { fullscreen: false, lyricsMenu: null, lyricsSettingsOpen: false }
      )
    },
    setLyricsMenu(menu) {
      set({ lyricsMenu: menu })
    },
    setLyricsSettingsOpen(open) {
      set({ lyricsSettingsOpen: open, lyricsMenu: open ? null : get().lyricsMenu })
    },
    setLyricsQualityLevel(level) {
      set({ lyricsQualityLevel: level })
    },
    setInfoSongId(id) {
      set({ infoSongId: id })
    },
    setContextMenu(menu) {
      set({ contextMenu: menu })
    },
    setDragActive(active) {
      set({ dragActive: active })
    },
    pushToast(text) {
      const id = Date.now() + Math.random()
      set({ toasts: [...get().toasts, { id, text }] })
      window.setTimeout(() => get().dismissToast(id), 4200)
    },
    dismissToast(id) {
      set({ toasts: get().toasts.filter((t) => t.id !== id) })
    },

    async toggleFavoriteSong(id) {
      // 先请求主进程写盘，再用它返回的结果刷新内存：收藏是唯一真相在磁盘上的状态，
      // 不做乐观更新，避免写失败后界面「显示已收藏但重启就没了」。
      const favorites = await bridge.favorites.toggle('song', id)
      set({ favorites })
    },

    async toggleFavoriteAlbum(key) {
      const favorites = await bridge.favorites.toggle('album', key)
      set({ favorites })
    },

    playSongs(ids, startIndex) {
      if (ids.length === 0) return
      const items = ids.map((songId) => ({ key: newKey(), songId }))
      const index = Math.max(0, Math.min(startIndex, items.length - 1))
      set({ playback: { ...get().playback, queue: items, index, history: [] } })
      const song = get().songs[items[index]!.songId]
      if (song) {
        void engine.load(song, { autoplay: true, position: 0 })
      }
      void bridge.orderAnalysis(ids)
      persist(get())
    },

    playSongNow(id) {
      const state = get()
      const existing = state.playback.queue.findIndex((item) => item.songId === id)
      if (existing >= 0) {
        state.jumpToQueueIndex(existing)
        return
      }
      state.playSongs([id], 0)
    },

    playRandom() {
      const state = get()
      const ids = state.songIds
      if (ids.length === 0) return
      // 整库洗牌作为队列：这样「当前」与「下一首」都是随机的，
      // 全屏歌词页的「接下来播放」卡片才有真实内容可显示。
      const shuffled = shuffleArray(ids)
      const currentId = state.playback.queue[state.playback.index]?.songId ?? null
      // 只有一首歌时无从避开；否则把「还是当前这首」的头挪到队尾，保证真的换了一首
      const pool =
        shuffled[0] === currentId && shuffled.length > 1
          ? [...shuffled.slice(1), shuffled[0]!]
          : shuffled
      const items = pool.map((songId) => ({ key: newKey(), songId }))
      set({
        playback: { ...state.playback, queue: items, index: 0, history: [] },
        // 随机推荐的核心体验：点一下直接落到全屏歌词页（它与侧边歌词面板互斥，见 setFullscreen）
        fullscreen: true,
        // 「接下来播放」在随机推荐里只亮 10 秒就收起，把舞台还给歌词（hover 可召回）
        fsRandomHint: true,
        lyricsOpen: false,
        queueOpen: false
      })
      const song = state.songs[items[0]!.songId]
      if (song) {
        void engine.load(song, { autoplay: true, position: 0 })
      }
      persist(get())
    },

    togglePlay() {
      void engine.toggle()
    },

    next(auto = false) {
      const state = get()
      const { queue, index, repeat, shuffle } = state.playback
      if (queue.length === 0) return
      const currentSong = state.songs[queue[index]?.songId ?? '']
      if (auto && currentSong) {
        state.playback.history.push(currentSong.id)
      }
      const nextIndex = nextQueueIndex(index, queue.length, repeat)
      if (nextIndex === null) return
      // 回到队首且开着随机：重排整条队列，让这一轮也是随机的
      if (nextIndex === 0 && index === queue.length - 1 && shuffle) {
        const shuffled = shuffleArray(queue).map((item) => ({ ...item, key: newKey() }))
        set({ playback: { ...state.playback, queue: shuffled, index: 0 } })
        const song = state.songs[shuffled[0]!.songId]
        if (song) {
          void engine.load(song, { autoplay: true, position: 0 })
        }
        persist(get())
        return
      }
      const item = queue[nextIndex]
      if (!item) return
      const song = state.songs[item.songId]
      set({ playback: { ...state.playback, index: nextIndex } })
      if (song) {
        void engine.crossfadeTo(song, { position: 0, duration: auto ? 1.2 : 0.7 })
      }
      persist(get())
    },

    prev() {
      const state = get()
      const { queue, index } = state.playback
      if (queue.length === 0) return
      if (state.playback.position > 3) {
        state.seek(0)
        return
      }
      const prevIndex = prevQueueIndex(index, queue.length)
      const item = queue[prevIndex]
      if (!item) return
      const song = state.songs[item.songId]
      set({ playback: { ...state.playback, index: prevIndex } })
      if (song) {
        void engine.crossfadeTo(song, { position: 0, duration: 0.7 })
      }
      persist(get())
    },

    seek(seconds) {
      const state = get()
      engine.seek(seconds)
      set({ playback: { ...state.playback, position: seconds } })
    },

    setVolume(value) {
      engine.setVolume(value)
      set({ playback: { ...get().playback, volume: value, muted: false } })
      engine.setMuted(false)
      persist(get())
    },

    toggleMute() {
      const muted = !get().playback.muted
      engine.setMuted(muted)
      set({ playback: { ...get().playback, muted } })
    },

    toggleShuffle() {
      const state = get()
      const shuffle = !state.playback.shuffle
      const { queue, index } = state.playback
      if (queue.length === 0) {
        set({ playback: { ...state.playback, shuffle } })
        return
      }
      const current = queue[index]!
      const rest = queue.filter((_, i) => i !== index)
      const nextQueue = shuffle
        ? [current, ...shuffleArray(rest).map((item) => ({ ...item, key: newKey() }))]
        : [current, ...rest]
      set({ playback: { ...state.playback, shuffle, queue: nextQueue, index: 0 } })
      persist(get())
    },

    cycleRepeat() {
      const state = get()
      const order: RepeatMode[] = ['off', 'all', 'one']
      const current = order.indexOf(state.playback.repeat)
      const repeat = order[(current + 1) % order.length]!
      set({ playback: { ...state.playback, repeat } })
      persist(get())
    },

    addNext(ids) {
      const state = get()
      const { queue, index } = state.playback
      const items = ids.map((songId) => ({ key: newKey(), songId }))
      const nextQueue = [...queue.slice(0, index + 1), ...items, ...queue.slice(index + 1)]
      set({ playback: { ...state.playback, queue: nextQueue } })
      state.pushToast(`已加入 ${ids.length} 首，接下来播放`)
      persist(get())
    },

    addLater(ids) {
      const state = get()
      const items = ids.map((songId) => ({ key: newKey(), songId }))
      set({ playback: { ...state.playback, queue: [...state.playback.queue, ...items] } })
      state.pushToast(`已加入 ${ids.length} 首到待播清单`)
      persist(get())
    },

    removeFromQueue(key) {
      const state = get()
      const { queue, index } = state.playback
      const at = queue.findIndex((item) => item.key === key)
      if (at < 0) return
      const nextQueue = queue.filter((item) => item.key !== key)
      const nextIndex = at < index ? index - 1 : index
      set({ playback: { ...state.playback, queue: nextQueue, index: Math.max(0, Math.min(nextIndex, nextQueue.length - 1)) } })
      persist(get())
    },

    clearQueue() {
      const state = get()
      const current = state.playback.queue[state.playback.index]
      const queue = current ? [current] : []
      set({ playback: { ...state.playback, queue, index: 0 } })
      persist(get())
    },

    moveInQueue(from, to) {
      const state = get()
      const { queue, index } = state.playback
      if (from === to || from < 0 || to < 0 || from >= queue.length || to >= queue.length) return
      const nextQueue = [...queue]
      const [moved] = nextQueue.splice(from, 1)
      if (!moved) return
      nextQueue.splice(to, 0, moved)
      let nextIndex = index
      if (index === from) nextIndex = to
      else if (from < index && to >= index) nextIndex = index - 1
      else if (from > index && to <= index) nextIndex = index + 1
      set({ playback: { ...state.playback, queue: nextQueue, index: nextIndex } })
      persist(get())
    },

    jumpToQueueIndex(index) {
      const state = get()
      const item = state.playback.queue[index]
      if (!item) return
      const song = state.songs[item.songId]
      set({ playback: { ...state.playback, index } })
      if (song) {
        void engine.load(song, { autoplay: true, position: 0 })
      }
      persist(get())
    },

    async updateSettings(patch) {
      const settings = await bridge.saveSettings(patch)
      set({ settings })
    },

    applyBatch(batch) {
      const state = get()
      const songs = { ...state.songs }
      for (const song of batch.added) songs[song.id] = song
      for (const song of batch.updated) songs[song.id] = song
      for (const id of batch.removed) delete songs[id]
      const ids = Object.values(songs)
        .sort((a, b) => b.addedAt - a.addedAt)
        .map((s) => s.id)
      let playback = state.playback
      if (batch.removed.length > 0) {
        const removed = new Set(batch.removed)
        const queue = playback.queue.filter((item) => !removed.has(item.songId))
        if (queue.length !== playback.queue.length) {
          playback = { ...playback, queue, index: Math.min(playback.index, Math.max(0, queue.length - 1)) }
        }
      }
      set({ songs, songIds: ids, playback, scan: batch.progress })
      persist(get())
    },

    setAnalysis(progress) {
      set({ analysis: progress })
    },

    setScan(progress) {
      set({ scan: progress })
    },

    async loadLyrics(songId) {
      if (!songId) {
        set({ lyrics: null })
        return
      }
      set({ lyricsLoading: true })
      const payload = await bridge.lyrics(songId)
      if (get().playback.queue[get().playback.index]?.songId !== songId) {
        // A newer track started while this request was in flight.
        set({ lyricsLoading: false })
        return
      }
      set({ lyrics: payload, lyricsLoading: false })
    }
  }
})

/**
 * 只订阅「当前歌曲 id / 是否在播放」这两个标量。
 *
 * 直接 `useStore((s) => s.playback)` 会让列表页跟着进度收到每秒 10 次的新对象，
 * 整页（含所有封面与玻璃层）重渲染 —— 歌曲/专辑/收藏页的滚动卡顿主要来自这里。
 */
export const useCurrentSongId = (): string | null =>
  useStore((s) => s.playback.queue[s.playback.index]?.songId ?? null)

export const useIsPlaying = (): boolean => useStore((s) => s.playback.playing)

// 歌词跟随「当前歌曲」自动加载：订阅当前歌曲 id，变化即重载。
// 之前 loadLyrics 分散在 playSongs / next / prev / jumpToQueueIndex / AutoMix 各处，
// AutoMix 的 bridge 交接（engine.enterBridge）只推 engine 快照、不走这些入口，
// 于是过渡结束后歌已经换掉了，歌词还停在上一首。订阅驱动从根上消灭漏调路径。
// 注意：必须放在 create() 之后 —— factory 内部 useStore 还在 TDZ。
let trackedLyricsSongId: string | null | undefined = undefined
useStore.subscribe((state) => {
  const songId = state.playback.queue[state.playback.index]?.songId ?? null
  if (songId === trackedLyricsSongId) return
  trackedLyricsSongId = songId
  void useStore.getState().loadLyrics(songId)
})

if (typeof window !== 'undefined') {
  // 诊断用：控制台可直接读 store 状态
  ;(window as unknown as { __store?: unknown }).__store = useStore
}
