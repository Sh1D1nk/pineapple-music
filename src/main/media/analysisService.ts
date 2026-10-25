import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { cpus } from 'node:os'
import { Worker } from 'node:worker_threads'
import type { AnalysisProgress, AnalysisResult, SongMeta } from '@shared/types'
import type { AnalyzeOk, AnalyzeRequest, AnalyzeResponse } from '../workers/analysis.worker'
import { decodeMono, measureDynamics } from './ffmpeg'
import { TaskQueue } from './taskQueue'
import type { LibraryService } from '../library/scanner'

const HEAD_WINDOW = 40
const TAIL_WINDOW = 72

interface Pending {
  resolve: (value: AnalyzeResponse) => void
  reject: (err: Error) => void
}

export class AnalysisService extends EventEmitter {
  private worker: Worker | null = null
  private pending = new Map<number, Pending>()
  private seq = 1
  private queue: TaskQueue
  private failures: { songId: string; title: string; reason: string }[] = []
  private doneSinceStart = 0
  private windowStart = Date.now()
  private current: string | null = null
  private active = false
  private gpu: 'directml' | 'cpu' | 'none' = 'none'
  private last: AnalysisProgress | null = null

  constructor(private readonly library: LibraryService) {
    super()
    this.queue = new TaskQueue({
      concurrency: 1,
      run: (task) => this.runTask(task.songId),
      onEvent: () => this.emitProgress()
    })
  }

  start(): void {
    const cores = cpus().length
    this.queue.setConcurrency(Math.max(1, Math.min(2, Math.floor(cores / 4) || 1)))
  }

  setConcurrency(n: number): void {
    this.queue.setConcurrency(n)
  }

  /** Re-compute queue priorities from what the user is listening to / looking at. */
  setOrder(songIds: string[]): void {
    this.queue.setOrder(songIds)
  }

  enqueue(songId: string, priority = 500): void {
    this.queue.add(songId, 'analyze', priority)
    this.active = true
    this.emitProgress()
  }

  enqueueMany(songIds: string[], startPriority = 0): void {
    songIds.forEach((id, i) => this.queue.add(id, 'analyze', startPriority + i))
    this.active = true
    this.emitProgress()
  }

  pause(): void {
    this.queue.pause()
    this.emitProgress()
  }

  resume(): void {
    this.queue.resume()
    this.emitProgress()
  }

  retryFailures(): void {
    this.failures = []
    this.queue.retryFailed()
    this.emitProgress()
  }

  isPaused(): boolean {
    return this.queue.isPaused
  }

  async analyzeNow(song: SongMeta): Promise<AnalysisResult> {
    const result = await this.analyzeSong(song)
    this.library.patchSong(song.id, { analysis: result })
    return result
  }

  private async runTask(songId: string): Promise<void> {
    const song = this.library.get(songId)
    if (!song) return
    if (song.analysis) return
    this.current = song.title
    this.emitProgress()
    try {
      const result = await this.analyzeSong(song)
      this.library.patchSong(songId, { analysis: result })
      this.doneSinceStart++
      this.emitProgress()
    } catch (err) {
      this.failures.push({ songId, title: song.title, reason: String(err).slice(0, 200) })
      this.emitProgress()
      throw err
    } finally {
      this.current = null
    }
  }

  private async analyzeSong(song: SongMeta): Promise<AnalysisResult> {
    const dynamics = await measureDynamics(song.path)
    const duration = song.durationSec > 0 ? song.durationSec : dynamics.duration
    const audioEnd = Math.min(duration, dynamics.audioEnd || duration)
    const tailStart = Math.max(0, audioEnd - TAIL_WINDOW)
    const [head, tail] = await Promise.all([
      decodeMono(song.path, 0, Math.min(HEAD_WINDOW, duration)),
      decodeMono(song.path, tailStart, Math.min(TAIL_WINDOW, Math.max(1, audioEnd - tailStart)))
    ])
    const req: Omit<AnalyzeRequest, 'id'> = {
      sampleRate: 44100,
      head,
      headStart: 0,
      tail,
      tailStart
    }
    const result = await this.runInWorker(req)
    const grid = {
      tail: result.tailBeats.filter((t) => t > audioEnd - 50),
      head: result.headBeats.filter((t) => t < 32),
      period: result.period,
      stability: result.stability,
      downbeat: result.downbeat,
      tailDownbeats: result.tailDownbeats.filter((t) => t > audioEnd - 50),
      headDownbeats: result.headDownbeats.filter((t) => t < 32)
    }
    return {
      bpm: result.bpm,
      bpmConfidence: result.bpmConfidence,
      bpmCandidates: result.bpmCandidates,
      grid,
      key: result.key,
      keyConfidence: result.keyConfidence,
      lufs: dynamics.lufs,
      leadSilence: dynamics.leadSilence,
      tailSilence: Math.max(0, duration - audioEnd),
      audioStart: dynamics.audioStart,
      audioEnd,
      analyzedAt: Date.now(),
      engine: result.engine
    }
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(join(__dirname, 'worker-analysis.js'))
    worker.on('message', (msg: AnalyzeResponse) => {
      const waiter = this.pending.get(msg.id)
      if (!waiter) return
      this.pending.delete(msg.id)
      if (msg.ok) waiter.resolve(msg)
      else waiter.reject(new Error(msg.error))
    })
    worker.on('error', (err) => {
      for (const [, waiter] of this.pending) waiter.reject(err as Error)
      this.pending.clear()
      this.worker = null
    })
    worker.unref()
    this.worker = worker
    return worker
  }

  private runInWorker(req: Omit<AnalyzeRequest, 'id'>): Promise<AnalyzeOk> {
    const worker = this.ensureWorker()
    const id = this.seq++
    return new Promise<AnalyzeOk>((resolve, reject) => {
      this.pending.set(id, { resolve: (r) => resolve(r as AnalyzeOk), reject })
      const payload: AnalyzeRequest = { ...req, id }
      const transfer: ArrayBuffer[] = []
      if (req.head.buffer instanceof ArrayBuffer) transfer.push(req.head.buffer)
      if (req.tail.buffer instanceof ArrayBuffer) transfer.push(req.tail.buffer)
      worker.postMessage(payload, transfer)
    })
  }

  private emitProgress(): void {
    const elapsed = (Date.now() - this.windowStart) / 60000
    const rate = elapsed > 0.2 ? this.doneSinceStart / elapsed : 0
    const snapshot = this.library.snapshot()
    const total = snapshot.length
    const analyzed = snapshot.filter((s) => s.analysis).length
    const remaining = Math.max(0, total - analyzed)
    const stats = this.queue.stats()
    const progress: AnalysisProgress = {
      active: this.active && (stats.queued > 0 || stats.running > 0),
      done: analyzed,
      total,
      stage: stats.running > 0 ? 'analyzing' : 'idle',
      currentTitle: this.current ?? '',
      failures: this.failures.slice(-40),
      ratePerMin: Math.round(rate * 10) / 10,
      etaSec: rate > 0.1 ? Math.round((remaining / rate) * 60) : null,
      paused: this.queue.isPaused,
      gpu: this.gpu,
      workers: this.queue.concurrency
    }
    this.last = progress
    this.emit('progress', progress)
  }

  getProgress(): AnalysisProgress {
    return (
      this.last ?? {
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
    )
  }

  dispose(): void {
    this.queue.stop()
    this.worker?.terminate()
    this.worker = null
  }
}
