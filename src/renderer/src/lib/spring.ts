/** 极简弹簧：阻尼比 0.5、刚度 300 的按压反馈，可随时被下一次按下打断。 */
export interface SpringHandle {
  stop(): void
}

export function springTo(
  from: number,
  to: number,
  onUpdate: (value: number) => void,
  opts: { stiffness?: number; damping?: number; onDone?: () => void } = {}
): SpringHandle {
  const stiffness = opts.stiffness ?? 300
  const damping = opts.damping ?? 2 * 0.5 * Math.sqrt(stiffness)
  let value = from
  let velocity = 0
  let last = performance.now()
  let raf = 0
  let stopped = false

  const step = (now: number): void => {
    if (stopped) return
    const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000))
    last = now
    const force = -stiffness * (value - to) - damping * velocity
    velocity += force * dt
    value += velocity * dt
    if (Math.abs(value - to) < 0.001 && Math.abs(velocity) < 0.01) {
      onUpdate(to)
      opts.onDone?.()
      return
    }
    onUpdate(value)
    raf = requestAnimationFrame(step)
  }
  raf = requestAnimationFrame(step)
  return {
    stop() {
      stopped = true
      cancelAnimationFrame(raf)
    }
  }
}
