/** 主进程侧的性能探针：事件循环延迟、GPU、显示器、线程/句柄。 */
import { app, screen } from 'electron'
import { cpus, totalmem, freemem } from 'node:os'
import { inputIdleMs } from './governor'

const loopDelays: number[] = []
let sampler: NodeJS.Timeout | null = null

/** 每 100ms 期望醒一次，迟到多少就是事件循环被占用的时间。 */
export function startPerfSampler(): void {
  if (sampler) return
  let expected = performance.now() + 100
  sampler = setInterval(() => {
    const now = performance.now()
    const late = Math.max(0, now - expected)
    loopDelays.push(late)
    if (loopDelays.length > 120) loopDelays.shift()
    expected = now + 100
  }, 100)
  sampler.unref?.()
}

export function stopPerfSampler(): void {
  if (sampler) clearInterval(sampler)
  sampler = null
}

function pct(values: number[], q: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.round((sorted.length - 1) * q))] ?? 0
}

const VENDORS: Record<number, string> = {
  0x8086: 'Intel',
  0x10de: 'NVIDIA',
  0x1002: 'AMD',
  0x1022: 'AMD',
  0x1414: 'Microsoft',
  0x106b: 'Apple'
}

interface GpuCache {
  vendor: string
  device: string
  driver: string
  feature: string
  accelerated: boolean
}

let gpuCache: GpuCache | null = null

async function readGpu(): Promise<GpuCache> {
  let vendor = '未知 GPU'
  let device = ''
  let driver = ''
  try {
    const info = (await app.getGPUInfo('complete')) as unknown as {
      gpuDevice?: { vendorId?: number; deviceId?: number; driverVendor?: string; driverVersion?: string; active?: boolean }[]
    }
    const list = info.gpuDevice ?? []
    const active = list.find((entry) => entry.active) ?? list[0]
    if (active) {
      vendor = VENDORS[active.vendorId ?? 0] ?? `vendor 0x${(active.vendorId ?? 0).toString(16)}`
      device = `device 0x${(active.deviceId ?? 0).toString(16)}`
      driver = active.driverVersion ? `driver ${active.driverVersion}` : ''
    }
  } catch {
    /* ignore */
  }
  let feature = 'unknown'
  let accelerated = false
  try {
    const status = app.getGPUFeatureStatus() as unknown as Record<string, string>
    feature = status['gpu_compositing'] ?? 'unknown'
    accelerated = feature.includes('enabled') && !feature.includes('software')
  } catch {
    /* ignore */
  }
  return { vendor, device, driver, feature, accelerated }
}

export interface PerfSnapshot {
  loop: { p50: number; p95: number; max: number }
  cpu: number
  cores: number
  handles: number
  memoryMb: number
  freeMemMb: number
  gpu: GpuCache
  display: { width: number; height: number; refresh: number; scale: number }
  inputIdleMs: number
  uptimeSec: number
  stems: { active: boolean; stage: string; percent: number }
}

export async function perfSnapshot(stems: { active: boolean; stage: string; percent: number }): Promise<PerfSnapshot> {
  if (!gpuCache) gpuCache = await readGpu()
  const display = screen.getPrimaryDisplay()
  const usage = process.getCPUUsage()
  return {
    loop: {
      p50: Math.round(pct(loopDelays, 0.5) * 10) / 10,
      p95: Math.round(pct(loopDelays, 0.95) * 10) / 10,
      max: Math.round(Math.max(0, ...loopDelays) * 10) / 10
    },
    cpu: Math.round(usage.percentCPUUsage * 10) / 10,
    cores: cpus().length,
    handles: process.getActiveResourcesInfo().length,
    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    freeMemMb: Math.round(freemem() / 1024 / 1024),
    gpu: gpuCache,
    display: {
      width: display.size.width,
      height: display.size.height,
      refresh: Math.round(display.displayFrequency || 60),
      scale: display.scaleFactor
    },
    inputIdleMs: inputIdleMs(),
    uptimeSec: Math.round(process.uptime()),
    stems
  }
}
