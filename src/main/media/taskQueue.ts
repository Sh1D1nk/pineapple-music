export type TaskStatus = 'queued' | 'running' | 'done' | 'failed'

export interface QueueTask {
  key: string
  songId: string
  type: 'analyze' | 'stem'
  priority: number
  attempts: number
  status: TaskStatus
  error?: string
}

export interface QueueOptions {
  concurrency: number
  run: (task: QueueTask) => Promise<void>
  onEvent?: () => void
  maxAttempts?: number
}

/**
 * Priority queue for background work. Tasks are keyed by song+type so re-prioritising the queue
 * (a new song starts playing, the shuffle order changes) never duplicates work, and stale tasks
 * are simply dropped by priority rather than by cancellation events.
 */
export class TaskQueue {
  private tasks = new Map<string, QueueTask>()
  private running = new Set<string>()
  private paused = false
  private stopped = false
  private tickScheduled = false

  constructor(private readonly opts: QueueOptions) {}

  get concurrency(): number {
    return this.opts.concurrency
  }

  setConcurrency(n: number): void {
    this.opts.concurrency = Math.max(1, Math.min(8, n))
    this.tick()
  }

  add(songId: string, type: 'analyze' | 'stem', priority: number): void {
    const key = `${songId}:${type}`
    const existing = this.tasks.get(key)
    if (existing) {
      if (existing.status === 'queued' && priority < existing.priority) {
        existing.priority = priority
        this.opts.onEvent?.()
      }
      return
    }
    this.tasks.set(key, { key, songId, type, priority, attempts: 0, status: 'queued' })
    this.opts.onEvent?.()
    this.scheduleTick()
  }

  /**
   * Adds usually arrive in bursts (a folder scan returns 40 songs at once). Deferring the first
   * tick by a microtask lets the whole burst be prioritised before anything starts running.
   */
  private scheduleTick(): void {
    if (this.tickScheduled) return
    this.tickScheduled = true
    queueMicrotask(() => {
      this.tickScheduled = false
      this.tick()
    })
  }

  /** Re-number priorities from an ordered list (index 0 = most urgent). */
  setOrder(songIds: string[]): void {
    const rank = new Map(songIds.map((id, i) => [id, i]))
    for (const task of this.tasks.values()) {
      if (task.status !== 'queued') continue
      const r = rank.get(task.songId)
      task.priority = r === undefined ? 10_000 + task.priority : r
    }
    this.opts.onEvent?.()
    this.scheduleTick()
  }

  cancelSong(songId: string): void {
    for (const [key, task] of [...this.tasks]) {
      if (task.songId === songId && task.status === 'queued') {
        this.tasks.delete(key)
      }
    }
    this.opts.onEvent?.()
  }

  /** Drops queued tasks whose song disappeared from the library. */
  retain(exists: (songId: string) => boolean): void {
    let changed = false
    for (const [key, task] of [...this.tasks]) {
      if (!exists(task.songId) && task.status !== 'running') {
        this.tasks.delete(key)
        changed = true
      }
    }
    if (changed) this.opts.onEvent?.()
  }

  pause(): void {
    this.paused = true
    this.opts.onEvent?.()
  }

  resume(): void {
    this.paused = false
    this.opts.onEvent?.()
    this.tick()
  }

  get isPaused(): boolean {
    return this.paused
  }

  has(songId: string, type: 'analyze' | 'stem'): boolean {
    const task = this.tasks.get(`${songId}:${type}`)
    return task != null && task.status !== 'failed'
  }

  stats(): { queued: number; running: number; done: number; failed: number } {
    let queued = 0
    let running = 0
    let done = 0
    let failed = 0
    for (const t of this.tasks.values()) {
      if (t.status === 'queued') queued++
      else if (t.status === 'running') running++
      else if (t.status === 'done') done++
      else failed++
    }
    return { queued, running, done, failed }
  }

  failures(): QueueTask[] {
    return [...this.tasks.values()].filter((t) => t.status === 'failed')
  }

  retryFailed(): void {
    for (const t of this.tasks.values()) {
      if (t.status === 'failed') {
        t.status = 'queued'
        t.attempts = 0
        t.error = undefined
      }
    }
    this.tick()
  }

  clearFinished(): void {
    for (const [key, t] of [...this.tasks]) {
      if (t.status === 'done') this.tasks.delete(key)
    }
  }

  stop(): void {
    this.stopped = true
  }

  private tick(): void {
    if (this.stopped || this.paused) return
    while (this.running.size < this.opts.concurrency) {
      const next = this.pick()
      if (!next) return
      this.running.add(next.key)
      next.status = 'running'
      this.opts.onEvent?.()
      void this.opts
        .run(next)
        .then(() => {
          next.status = 'done'
        })
        .catch((err: unknown) => {
          next.attempts++
          const maxAttempts = this.opts.maxAttempts ?? 2
          if (next.attempts > maxAttempts) {
            next.status = 'failed'
            next.error = String(err)
          } else {
            next.status = 'queued'
          }
        })
        .finally(() => {
          this.running.delete(next.key)
          this.opts.onEvent?.()
          this.tick()
        })
    }
  }

  private pick(): QueueTask | null {
    let best: QueueTask | null = null
    for (const task of this.tasks.values()) {
      if (task.status !== 'queued') continue
      if (!best || task.priority < best.priority) best = task
    }
    return best
  }
}
