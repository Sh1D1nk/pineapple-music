import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { modelsDir } from '../paths'

/**
 * 分轨模型运行时。
 *
 * 只认一种签名：4 维频谱 mask 模型（UVR / MDX-Net 系），
 *   输入  [1, C, 2049, T]  float32，C = 2（立体声实部/虚部）或 4（+ 单声道实虚）
 *   输出  [1, C', 2049, T] float32，取前 2 通道当作立体声 mask
 * 其它签名一律拒绝并给出可读原因，绝不做「形状对不上还硬喂」的推理。
 */

export interface StemModelInfo {
  file: string
  name: string
  sizeMb: number
  inputName: string
  outputName: string
  channels: number
  bins: number
  maxFrames: number | null
}

export interface StemRuntimeStatus {
  runtime: 'onnxruntime-node' | 'missing'
  runtimeVersion: string | null
  models: StemModelInfo[]
  /** 运行时与模型都就绪时才可推理 */
  ready: boolean
  reason: string | null
}

interface OrtTensor {
  data: Float32Array
  dims: number[]
}
interface OrtSession {
  inputNames: string[]
  outputNames: string[]
  inputMetadata: { name: string; isTensor: boolean; dimensions: (number | string)[] }[]
  outputMetadata: { name: string; isTensor: boolean; dimensions: (number | string)[] }[]
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>
  release?: () => Promise<void>
}
interface OrtModule {
  InferenceSession: { create(path: string, options?: unknown): Promise<OrtSession> }
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => unknown
  env?: { versions?: { common?: string } }
}

let ortModule: OrtModule | null = null
let ortError: string | null = null
const sessionCache = new Map<string, OrtSession>()

/** onnxruntime-node 是 optionalDependency：没装也不影响其它功能，只是分轨不可用。 */
export async function loadRuntime(): Promise<OrtModule | null> {
  if (ortModule) return ortModule
  if (ortError) return null
  try {
    const mod = (await import('onnxruntime-node')) as unknown as OrtModule
    if (!mod?.InferenceSession) throw new Error('onnxruntime-node 导出异常')
    ortModule = mod
    return mod
  } catch (err) {
    ortError = err instanceof Error ? err.message : String(err)
    return null
  }
}

export function runtimeError(): string | null {
  return ortError
}

/** onnxruntime 的 metadata 在不同版本里是数组、对象或缺失，这里统一成数组。 */
function normalizeMeta(
  raw: unknown,
  names: string[]
): { name: string; dimensions: number[] }[] {
  const list: { name: string; dimensions: (number | string)[] }[] = []
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const rec = entry as { name?: string; dimensions?: (number | string)[]; shape?: (number | string)[] }
      if (!rec) continue
      list.push({ name: rec.name ?? '', dimensions: rec.dimensions ?? rec.shape ?? [] })
    }
  } else if (raw && typeof raw === 'object') {
    for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
      const rec = (entry ?? {}) as { dimensions?: (number | string)[]; shape?: (number | string)[] }
      list.push({ name, dimensions: rec.dimensions ?? rec.shape ?? [] })
    }
  }
  if (list.length === 0) return names.map((name) => ({ name, dimensions: [] }))
  return list.map((entry, i) => ({ name: entry.name || names[i] || '', dimensions: entry.dimensions as number[] }))
}

function listModelFiles(): string[] {
  try {
    return readdirSync(modelsDir())
      .filter((name) => name.toLowerCase().endsWith('.onnx'))
      .map((name) => join(modelsDir(), name))
  } catch {
    return []
  }
}

/** 读取模型输入输出签名；不匹配的直接在列表里标注不可用。 */
export async function inspectModel(file: string): Promise<StemModelInfo | null> {
  const ort = await loadRuntime()
  if (!ort) return null
  let session = sessionCache.get(file)
  try {
    session ??= await ort.InferenceSession.create(file, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
      intraOpNumThreads: Math.max(1, Math.min(4, Math.floor(2)))
    })
    sessionCache.set(file, session)
  } catch {
    return null
  }
  const inputs = normalizeMeta(session.inputMetadata, session.inputNames)
  const outputs = normalizeMeta(session.outputMetadata, session.outputNames)
  const input = inputs.find((m) => m.dimensions.length === 4) ?? inputs[0]
  const output = outputs[0]
  if (!input || !output || input.dimensions.length !== 4) return null
  const channels = Number(input.dimensions[1])
  const bins = Number(input.dimensions[2])
  const frames = Number(input.dimensions[3])
  if (!Number.isFinite(channels) || (channels !== 2 && channels !== 4)) return null
  if (!Number.isFinite(bins) || bins !== 2049) return null
  return {
    file,
    name: file.split(/[\\/]/).pop() ?? file,
    sizeMb: Math.round((statSync(file).size / 1024 / 1024) * 10) / 10,
    inputName: input.name,
    outputName: output.name,
    channels,
    bins,
    maxFrames: Number.isFinite(frames) && frames > 0 ? frames : null
  }
}

export async function status(): Promise<StemRuntimeStatus> {
  const ort = await loadRuntime()
  if (!ort) {
    return {
      runtime: 'missing',
      runtimeVersion: null,
      models: [],
      ready: false,
      reason: `未安装 onnxruntime-node：${ortError ?? '模块不可用'}`
    }
  }
  const models: StemModelInfo[] = []
  for (const file of listModelFiles()) {
    const info = await inspectModel(file)
    if (info) models.push(info)
  }
  return {
    runtime: 'onnxruntime-node',
    runtimeVersion: ort.env?.versions?.common ?? null,
    models,
    ready: models.length > 0,
    reason:
      models.length > 0
        ? null
        : listModelFiles().length === 0
          ? '模型目录里没有 .onnx 文件'
          : '模型签名不支持：需要输入 [1, C, 2049, T]，C 为 2 或 4'
  }
}

export async function getSession(
  file: string
): Promise<{ ort: OrtModule; session: OrtSession; info: StemModelInfo } | null> {
  const ort = await loadRuntime()
  if (!ort) return null
  const info = await inspectModel(file)
  if (!info) return null
  const session = sessionCache.get(file)
  if (!session) return null
  return { ort, session, info }
}

export function modelExists(file: string): boolean {
  return existsSync(file)
}
