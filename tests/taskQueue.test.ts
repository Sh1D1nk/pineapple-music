import { describe, expect, it } from 'vitest'
import { TaskQueue } from '../src/main/media/taskQueue'

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * 轮询等待条件成立，而不是死等固定时长。
 * 固定 sleep 在机器负载高时（例如同时跑 50+ 用例）会不够用，导致偶发失败。
 */
const waitUntil = async (predicate: () => boolean, timeoutMs = 4000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await wait(10)
  }
}

describe('TaskQueue', () => {
  it('runs in priority order', async () => {
    const order: string[] = []
    const queue = new TaskQueue({
      concurrency: 1,
      run: async (task) => {
        order.push(task.songId)
        await wait(2)
      }
    })
    queue.add('c', 'analyze', 30)
    queue.add('a', 'analyze', 10)
    queue.add('b', 'analyze', 20)
    await waitUntil(() => order.length === 3)
    expect(order).toEqual(['a', 'b', 'c'])
  })

  it('re-prioritises without duplicating work', async () => {
    const order: string[] = []
    const queue = new TaskQueue({
      concurrency: 1,
      run: async (task) => {
        order.push(task.songId)
        await wait(5)
      }
    })
    queue.add('a', 'analyze', 100)
    queue.add('b', 'analyze', 200)
    queue.add('c', 'analyze', 300)
    queue.setOrder(['c', 'b', 'a'])
    await waitUntil(() => order.length === 3)
    expect(order).toEqual(['c', 'b', 'a'])
    expect(order.filter((id) => id === 'a')).toHaveLength(1)
  })

  it('respects concurrency and pause', async () => {
    let running = 0
    let peak = 0
    const queue = new TaskQueue({
      concurrency: 2,
      run: async () => {
        running++
        peak = Math.max(peak, running)
        await wait(10)
        running--
      }
    })
    for (let i = 0; i < 6; i++) queue.add(`s${i}`, 'analyze', i)
    queue.pause()
    expect(queue.stats().running).toBe(0)
    queue.resume()
    await waitUntil(() => queue.stats().done === 6)
    expect(peak).toBeLessThanOrEqual(2)
    expect(queue.stats().done).toBe(6)
  })

  it('retries twice then marks the task failed', async () => {
    let attempts = 0
    const queue = new TaskQueue({
      concurrency: 1,
      maxAttempts: 2,
      run: async () => {
        attempts++
        throw new Error('boom')
      }
    })
    queue.add('x', 'stem', 0)
    await wait(80)
    expect(attempts).toBe(3)
    expect(queue.failures()).toHaveLength(1)
    queue.retryFailed()
    await wait(80)
    expect(attempts).toBe(6)
  })

  it('drops queued tasks for songs that no longer exist', async () => {
    const queue = new TaskQueue({ concurrency: 1, run: async () => wait(5) })
    queue.add('keep', 'analyze', 0)
    queue.add('gone', 'analyze', 1)
    queue.retain((id) => id === 'keep')
    await wait(40)
    expect(queue.stats().queued).toBe(0)
    expect(queue.has('gone', 'analyze')).toBe(false)
  })
})
