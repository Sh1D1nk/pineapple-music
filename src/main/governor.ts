/** 后台任务的「让路」策略：用户一动手，后台就靠边。 */
import { setPriority, constants } from 'node:os'

type Mode = 'idle' | 'always' | 'off'
let mode: Mode = 'idle'
let lastInputAt = Date.now()

export function setBackgroundMode(next: Mode): void {
  mode = next
}

export function backgroundMode(): Mode {
  return mode
}

export function noteUserInput(): void {
  lastInputAt = Date.now()
}

export function inputIdleMs(): number {
  return Date.now() - lastInputAt
}

export function isIdle(thresholdMs = 1500): boolean {
  return inputIdleMs() >= thresholdMs
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 在一首歌开始处理前调用：
 *  - 'always'：立即放行
 *  - 'idle'：等到用户最近 1.5 秒没有任何指针/键盘/滚动输入
 *  - 'off'：一直等到用户改成其它模式（任务不丢，只是停在队列里）
 *
 * 粒度说明：单曲分析/分轨是一个不可中断的整体（ffmpeg 解码 + 推理），
 * 所以抢占点在「歌与歌之间」；进程本身以 BELOW_NORMAL 运行，用户操作期间
 * 即使还有残余计算，也不会和界面抢调度。
 */
export async function waitForBackgroundTurn(): Promise<void> {
  while (true) {
    if (mode === 'always') return
    if (mode === 'off') {
      await sleep(600)
      continue
    }
    if (isIdle()) return
    await sleep(120)
  }
}

let lowered = false
/** 把整个主进程降到 BELOW_NORMAL：worker 线程与 ffmpeg 子进程都继承这个优先级。 */
export function lowerProcessPriority(): void {
  if (lowered) return
  lowered = true
  try {
    setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL)
  } catch {
    /* 某些受限环境不允许改优先级，忽略 */
  }
}

export function lowerChildPriority(pid: number | undefined): void {
  if (!pid) return
  try {
    setPriority(pid, constants.priority.PRIORITY_BELOW_NORMAL)
  } catch {
    /* ignore */
  }
}
