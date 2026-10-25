import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { stftProfileFor, type StftOptions } from '../../shared/stem/stft'

/**
 * 分轨模型运行时。
 *
 * 认的是「频谱 mask 模型」这一类签名：
 *   输入  [1, C, bins, T]  float32，C = 2（单声道实虚）或 4（立体声实虚交错）
 *   输出  [1, C', bins, T] float32
 * 其中 bins 决定本应用要用哪种频谱：
 *   2049 → n_fft=4096 居中（合成测试模型 / librosa 风格）
 *   2048 → n_fft=4096 不居中（UVR MDX-Net 的标准设置）
 *   4097 / 4096 → n_fft=8192
 * 其它 bins（例如 MDX 的 3072 → n_fft=6144）本应用的 radix-2 FFT 跑不了，
 * 会明确写出原因，而不是「形状对不上还硬喂」。
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
  /** 这个模型需要的频谱配置（按 bins 推导） */
  profile: StftOptions
}

export interface StemRuntimeStatus {
  runtime: 'onnxruntime-node' | 'missing'
  runtimeVersion: string | null
  models: StemModelInfo[]
  /** 目录里存在但签名不兼容的模型，带具体原因（期望 vs 实际） */
  rejected?: { name: string; reason: string }[]
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

/**
 * 列出模型目录里的 .onnx 文件。paths.ts 依赖 electron（app.getPath），而本模块会被
 * worker-stem 线程导入（那边没有 electron），所以这里改成动态导入、只在主进程侧调用。
 */
async function listModelFiles(): Promise<string[]> {
  const { modelsDir } = await import('../paths')
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
  // bins 决定用哪种频谱：2049 居中 / 2048 不居中（MDX-Net）/ 4096、4097 走 n_fft=8192
  const profile = stftProfileFor(bins)
  if (!profile) return null
  return {
    file,
    name: file.split(/[\\/]/).pop() ?? file,
    sizeMb: Math.round((statSync(file).size / 1024 / 1024) * 10) / 10,
    inputName: input.name,
    outputName: output.name,
    channels,
    bins,
    maxFrames: Number.isFinite(frames) && frames > 0 ? frames : null,
    profile
  }
}

/** 拆轨模型要求的签名，用于把「为什么不能用」讲清楚。 */
export const EXPECTED_SIGNATURE =
  '输入 [1, C, bins, T]（C = 2 或 4；bins = 2049 居中 / 2048 不居中 / 4096、4097），输出同形状的频谱 mask'

export interface ModelProbe {
  ok: boolean
  name: string
  sizeMb: number
  /** 实际输入形状，读不到时为 null */
  inputShape: string | null
  outputShape: string | null
  /** 不可用的具体原因（期望 vs 实际） */
  reason: string | null
}

function shapeText(dims: (number | string)[] | undefined): string | null {
  if (!dims || dims.length === 0) return null
  const parts = dims.map((dim) => {
    if (dim === null || dim === undefined || dim === '') return 'T'
    const num = Number(dim)
    return Number.isFinite(num) && num > 0 ? String(num) : 'T'
  })
  return `[${parts.join(', ')}]`
}

/**
 * 读取一个 .onnx 的真实输入输出形状，并给出人话结论。
 * 与 inspectModel 的区别：这里不吞错误 —— 导入失败时界面要显示「期望 vs 实际」，
 * 只回一个 false 对用户没有任何帮助。
 */
export async function probeModel(file: string): Promise<ModelProbe> {
  const name = file.split(/[\\/]/).pop() ?? file
  let sizeMb = 0
  try {
    sizeMb = Math.round((statSync(file).size / 1024 / 1024) * 10) / 10
  } catch {
    return { ok: false, name, sizeMb: 0, inputShape: null, outputShape: null, reason: '文件读不到（可能已被移动）' }
  }
  const ort = await loadRuntime()
  if (!ort) {
    return {
      ok: false,
      name,
      sizeMb,
      inputShape: null,
      outputShape: null,
      reason: `onnxruntime-node 不可用：${ortError ?? '模块未安装'}`
    }
  }
  let session = sessionCache.get(file)
  if (!session) {
    try {
      session = await ort.InferenceSession.create(file, {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
        intraOpNumThreads: 2
      })
      sessionCache.set(file, session)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        ok: false,
        name,
        sizeMb,
        inputShape: null,
        outputShape: null,
        reason: `ONNX 解析失败：${message.split('\n')[0]}`
      }
    }
  }
  const inputs = normalizeMeta(session.inputMetadata, session.inputNames)
  const outputs = normalizeMeta(session.outputMetadata, session.outputNames)
  const input = inputs.find((meta) => meta.dimensions.length === 4) ?? inputs[0]
  const output = outputs[0]
  const inputShape = shapeText(input?.dimensions)
  const outputShape = shapeText(output?.dimensions)

  if (!input || input.dimensions.length !== 4) {
    return {
      ok: false,
      name,
      sizeMb,
      inputShape,
      outputShape,
      reason: `输入不是 4 维频谱张量：实际 ${inputShape ?? '未知'}，期望 ${EXPECTED_SIGNATURE}`
    }
  }
  const channels = Number(input.dimensions[1])
  const bins = Number(input.dimensions[2])
  if (channels !== 2 && channels !== 4) {
    return {
      ok: false,
      name,
      sizeMb,
      inputShape,
      outputShape,
      reason: `通道数 C=${Number.isFinite(channels) ? channels : '?'} 不受支持（只接受 2 或 4，实际 ${inputShape}）`
    }
  }
  if (bins !== 2049) {
    return {
      ok: false,
      name,
      sizeMb,
      inputShape,
      outputShape,
      reason: `频点数 ${Number.isFinite(bins) ? bins : '?'} ≠ 2049（本应用 STFT 为 n_fft=4096 / hop=1024，实际 ${inputShape}）`
    }
  }
  return { ok: true, name, sizeMb, inputShape, outputShape, reason: null }
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
  const rejected: { name: string; reason: string }[] = []
  const files = await listModelFiles()
  for (const file of files) {
    const info = await inspectModel(file)
    if (info) {
      models.push(info)
      continue
    }
    const probe = await probeModel(file)
    rejected.push({ name: probe.name, reason: probe.reason ?? '签名不匹配' })
  }
  return {
    runtime: 'onnxruntime-node',
    runtimeVersion: ort.env?.versions?.common ?? null,
    models,
    rejected,
    ready: models.length > 0,
    reason:
      models.length > 0
        ? null
        : files.length === 0
          ? '模型目录里没有 .onnx 文件'
          : `模型签名不支持：需要${EXPECTED_SIGNATURE}（被拒原因见下方列表）`
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
