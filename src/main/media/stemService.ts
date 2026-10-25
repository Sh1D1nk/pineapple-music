import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { SongMeta, StemInfo } from '@shared/types'
import { ffmpegPath } from './ffmpeg'
import { modelExists, status as runtimeStatus } from './stemRuntime'
import { stemsDir } from '../paths'
import type { StemJobResult, StemWorkerMessage, StemWorkerRequest } from '../workers/stem.worker'

export type StemStage = 'queued' | 'decode' | 'infer' | 'write' | 'done' | 'failed'

export interface StemProgress {
  active: boolean
  stage: StemStage
  songId: string | null
  title: string
  percent: number
  queued: number
  done: number
  total: number
  model: string | null
  error: string | null
  /** 最近一次成功的分轨耗时（秒） */
  lastSeconds: number | null
}

interface Deps {
  songs: () => SongMeta[]
  patchSong: (id: string, patch: Partial<SongMeta>) => void
  onProgress: (progress: StemProgress) => void
  cacheLimitGB: () => number
}

/**
 * 分轨服务：把一首歌离线拆成 vocals / instrumental 两轨，并把人声能量曲线写回曲库。
 *
 * 只做「频谱 mask」这一族模型（UVR / MDX-Net）。管线：
 *   ffmpeg 解码 → 分块 STFT(4096/1024) → 每块喂 ONNX 拿 mask →
 *   用 mask 与 1-mask 分别 iSTFT 重建 → 写 vocals.wav / instrumental.wav →
 *   从 vocals 算 50ms 能量曲线与人声乐句 → patchSong(stem)。
 *
 * **整条重管线跑在 worker 线程里**（worker-stem.js）：FFM 解码、JS DSP、ONNX 推理、
 * WAV 写盘都不碰主进程事件循环——原先它们在主线程上跑，每块几百毫秒的 DSP 会把
 * 渲染进程饿成「冻结 → 复活一瞬 → 再冻结」的循环。本类只保留队列、进度转发、
 * 取消与缓存淘汰；一次一首（worker 内串行），onnxruntime 本身限 2 线程。
 */
export class StemService {
  private queue: string[] = []
  private running = false
  private paused = false
  private cancelled = false
  private model: string | null = null
  private worker: Worker | null = null
  private jobWaiter: ((result: StemJobResult) => void) | null = null
  private jobSongId: string | null = null
  private progress: StemProgress = {
    active: false,
    stage: 'queued',
    songId: null,
    title: '',
    percent: 0,
    queued: 0,
    done: 0,
    total: 0,
    model: null,
    error: null,
    lastSeconds: null
  }

  constructor(private deps: Deps) {}

  snapshot(): StemProgress {
    return { ...this.progress }
  }

  async status(): Promise<{ runtime: string; ready: boolean; reason: string | null; models: number }> {
    const s = await runtimeStatus()
    return { runtime: s.runtime, ready: s.ready, reason: s.reason, models: s.models.length }
  }

  /** 入队（去重）。已在缓存里的不会重复跑。 */
  enqueue(ids: string[]): void {
    const songs = new Map(this.deps.songs().map((s) => [s.id, s]))
    for (const id of ids) {
      const song = songs.get(id)
      if (!song) continue
      if (song.stem?.state === 'ready') continue
      const cached = this.cachedStem(id)
      if (cached) {
        this.deps.patchSong(id, { stem: cached })
        continue
      }
      if (!this.queue.includes(id)) this.queue.push(id)
    }
    this.progress.queued = this.queue.length
    this.emit()
    void this.pump()
  }

  pause(): void {
    this.paused = true
    this.emit()
  }

  resume(): void {
    this.paused = false
    this.emit()
    void this.pump()
  }

  /** 停止当前这一首并清空队列。 */
  cancel(): void {
    this.cancelled = true
    this.queue = []
    this.progress.queued = 0
    this.sendToWorker({ type: 'cancel' })
    this.emit()
  }

  private emit(): void {
    this.deps.onProgress({ ...this.progress })
  }

  private cachedStem(songId: string): StemInfo | null {
    const meta = join(stemsDir(), songId, 'meta.json')
    if (!existsSync(meta)) return null
    try {
      const parsed = JSON.parse(readFileSync(meta, 'utf8')) as StemInfo
      if (parsed.state === 'ready') return parsed
    } catch {
      /* 缓存坏了就当没有 */
    }
    return null
  }

  private async pump(): Promise<void> {
    if (this.running || this.paused) return
    const next = this.queue.shift()
    if (!next) {
      this.progress.active = false
      this.progress.stage = 'queued'
      this.progress.queued = 0
      this.emit()
      return
    }
    this.running = true
    this.cancelled = false
    this.progress.queued = this.queue.length
    try {
      await this.run(next)
    } finally {
      this.running = false
      if (!this.paused && this.queue.length > 0) void this.pump()
    }
  }

  private async run(songId: string): Promise<void> {
    const song = this.deps.songs().find((s) => s.id === songId)
    if (!song) return
    const started = Date.now()
    this.progress = {
      ...this.progress,
      active: true,
      stage: 'decode',
      songId,
      title: song.title,
      percent: 0,
      error: null,
      model: this.model
    }
    this.emit()

    try {
      const runtime = await runtimeStatus()
      if (!runtime.ready) throw new Error(runtime.reason ?? '分轨运行时不可用')
      this.model = runtime.models[0]!.file
      this.progress.model = this.model
      if (!modelExists(this.model)) throw new Error('模型文件已丢失')

      // 重活全在 worker：解码、STFT、ONNX 推理、iSTFT、写 WAV。
      const result = await this.runInWorker(songId, song.path, this.model)
      if (result.type === 'cancelled') throw new Error('已取消')
      if (result.type === 'failed') throw new Error(result.error)

      const stem = result.stem
      const dir = join(stemsDir(), songId)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'meta.json'), JSON.stringify(stem))
      this.deps.patchSong(songId, { stem })

      this.progress = {
        ...this.progress,
        active: false,
        stage: 'done',
        percent: 1,
        lastSeconds: Math.round((Date.now() - started) / 1000)
      }
      this.emit()
      this.evictCache()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.deps.patchSong(songId, {
        stem: {
          state: 'failed',
          window: null,
          vocalCurve: null,
          phrases: null,
          model: this.model,
          error: message
        }
      })
      this.progress = { ...this.progress, active: false, stage: 'failed', error: message }
      this.emit()
    }
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(join(__dirname, 'worker-stem.js'), {
      workerData: { stemsDir: stemsDir(), ffmpegPath: ffmpegPath() }
    })
    worker.on('message', (msg: StemWorkerMessage) => {
      if (msg.type === 'progress') {
        this.progress.stage = msg.stage
        this.progress.percent = msg.percent
        this.emit()
        return
      }
      const waiter = this.jobWaiter
      this.jobWaiter = null
      waiter?.(msg)
    })
    worker.on('error', (err) => {
      const waiter = this.jobWaiter
      this.jobWaiter = null
      waiter?.({ type: 'failed', songId: this.jobSongId ?? '', error: String(err) })
    })
    worker.on('exit', () => {
      this.worker = null
      const waiter = this.jobWaiter
      this.jobWaiter = null
      waiter?.({ type: 'failed', songId: this.jobSongId ?? '', error: '分轨 worker 意外退出' })
    })
    worker.unref()
    this.worker = worker
    return worker
  }

  private runInWorker(songId: string, songPath: string, modelFile: string): Promise<StemJobResult> {
    const worker = this.ensureWorker()
    this.jobSongId = songId
    return new Promise<StemJobResult>((resolve) => {
      this.jobWaiter = resolve
      this.sendToWorker({ type: 'job', songId, songPath, modelFile })
    })
  }

  private sendToWorker(req: StemWorkerRequest): void {
    this.worker?.postMessage(req)
  }

  /** 按 cacheLimitGB 做一次简单的「最久未用」淘汰。 */
  private evictCache(): void {
    const limit = this.deps.cacheLimitGB() * 1024 * 1024 * 1024
    const dirs = readdirSyncSafe(stemsDir())
    let total = 0
    const entries = dirs.map((name) => {
      const path = join(stemsDir(), name)
      const size = dirSize(path)
      total += size
      return { path, size, at: statSync(path).mtimeMs }
    })
    if (total <= limit) return
    entries.sort((a, b) => a.at - b.at)
    for (const entry of entries) {
      if (total <= limit) break
      try {
        rmSync(entry.path, { recursive: true, force: true })
        total -= entry.size
      } catch {
        /* 被占用就跳过，下次再说 */
      }
    }
  }
}

function readdirSyncSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function dirSize(dir: string): number {
  let total = 0
  for (const name of readdirSyncSafe(dir)) {
    const path = join(dir, name)
    try {
      const st = statSync(path)
      total += st.isDirectory() ? dirSize(path) : st.size
    } catch {
      /* ignore */
    }
  }
  return total
}

export { writeWav16 } from './wav'
