import { parentPort, workerData } from 'node:worker_threads'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { StemInfo } from '@shared/types'
import { applyNorm, detectPhrases, istftAdd, readVocalMask, rmsCurve, stft } from '@shared/stem/stft'
import { decodeClip } from '../media/ffmpeg'
import { getSession } from '../media/stemRuntime'
import { writeWav16 } from '../media/wav'
import type { StemStage } from '../media/stemService'

/**
 * 分轨推理 worker —— 把「解码 → STFT → ONNX 推理 → iSTFT → 写 WAV」整条重管线
 * 搬出主进程事件循环。
 *
 * 背景：这条管线原先跑在主进程主线程上，每块之间只靠 setTimeout(0) 喘一口气。
 * 每块几百毫秒的纯 JS DSP（FFT / 掩码拷贝 / iSTFT）加上 onnxruntime 的原生线程，
 * 会把渲染进程饿到被 Windows 判成「未响应」，表现为「冻结 → 复活一瞬 → 再冻结」的循环。
 * 搬进 worker 后，主进程只负责队列与进度转发，界面不再挨饿。
 */

export interface StemJobRequest {
  type: 'job'
  songId: string
  songPath: string
  modelFile: string
}

export interface StemCancelRequest {
  type: 'cancel'
}

export type StemWorkerRequest = StemJobRequest | StemCancelRequest

export interface StemProgressMsg {
  type: 'progress'
  stage: StemStage
  percent: number
}

export type StemJobResult =
  | { type: 'done'; songId: string; stem: StemInfo }
  | { type: 'failed'; songId: string; error: string }
  | { type: 'cancelled'; songId: string }

export type StemWorkerMessage = StemProgressMsg | StemJobResult

interface WorkerData {
  stemsDir: string
  ffmpegPath: string
}

const CHUNK_FRAMES = 64

/** 一次推理返回的掩码：planes[0] 是人声掩码。 */
interface StemMask {
  kind: 'real'
  planes: Float32Array[]
}

const data = workerData as WorkerData
// ffmpeg 的二进制路径由主进程解析好注入（worker 里没有 process.resourcesPath）。
// ffmpeg.ts 的解析顺序里 env 覆盖排第一，这里正好借道。
if (data.ffmpegPath) process.env.LOCALMUSIC_FFMPEG = data.ffmpegPath

let cancelled = false
let running = false

function post(msg: StemWorkerMessage): void {
  parentPort?.postMessage(msg)
}

function postProgress(stage: StemStage, percent: number): void {
  post({ type: 'progress', stage, percent })
}

parentPort?.on('message', (req: StemWorkerRequest) => {
  if (req.type === 'cancel') {
    cancelled = true
    return
  }
  if (req.type === 'job' && !running) {
    running = true
    cancelled = false
    void runJob(req)
  }
})

class CancelledError extends Error {
  constructor() {
    super('已取消')
  }
}

async function runJob(req: StemJobRequest): Promise<void> {
  const { songId, songPath, modelFile } = req
  try {
    const ctx = await getSession(modelFile)
    if (!ctx) throw new Error('模型加载失败')
    const { ort, session, info } = ctx

    postProgress('decode', 0)
    const clip = await decodeClip(songPath, { channels: 2, sampleRate: 44100 })
    const [leftRaw, rightRaw] = clip.channels as [Float32Array, Float32Array]
    const length = Math.min(leftRaw.length, rightRaw.length)

    // 频谱参数按模型签名走：MDX-Net 是 n_fft=4096 不居中（2048 个频点），
    // 合成测试模型是 4096 居中（2049）。块大小取模型自己的固定帧数（常见 256）。
    const profile = info.profile
    const chunkFrames = Math.max(16, Math.min(info.maxFrames ?? CHUNK_FRAMES, 512))

    // 不居中的频谱（MDX-Net 的做法）第一帧的窗函数在样本 0 处为 0，
    // 直接算会让开头 n_fft/2 个样本被吃掉。UVR 的做法是首尾各补 n_fft/2 个零，
    // 这里照做：补零后再算，最后把补的部分裁掉。
    const pad = profile.center === false ? Math.floor(profile.nFft / 2) : 0
    const paddedLength = length + pad * 2
    const left = new Float32Array(paddedLength)
    const right = new Float32Array(paddedLength)
    left.set(leftRaw.subarray(0, length), pad)
    right.set(rightRaw.subarray(0, length), pad)
    const vocals: Float32Array[] = [new Float32Array(paddedLength), new Float32Array(paddedLength)]
    const inst: Float32Array[] = [new Float32Array(paddedLength), new Float32Array(paddedLength)]
    const norm = new Float32Array(paddedLength)
    const totalFrames = Math.ceil((paddedLength + profile.nFft) / profile.hop)

    postProgress('infer', 0)
    for (let frame = 0; frame < totalFrames; frame += chunkFrames) {
      if (cancelled) throw new CancelledError()
      const frames = Math.min(chunkFrames, totalFrames - frame)
      const spec = stft([left, right], frame * profile.hop, frames, profile)
      const mask = await inferMask(ort, session, info, spec.re, spec.im, frames)
      const vocRe = [new Float32Array(frames * spec.bins), new Float32Array(frames * spec.bins)]
      const vocIm = [new Float32Array(frames * spec.bins), new Float32Array(frames * spec.bins)]
      const insRe = [new Float32Array(frames * spec.bins), new Float32Array(frames * spec.bins)]
      const insIm = [new Float32Array(frames * spec.bins), new Float32Array(frames * spec.bins)]
      // 掩码第 0 通道就是人声掩码（UVR 的 MDX/MDX23C 都是这么取的）：
      // 人声轨 = 谱 × 掩码，伴奏轨 = 谱 × (1 - 掩码)，两声道用同一张掩码。
      const vocalMask = mask.planes[0]!
      for (let ch = 0; ch < 2; ch++) {
        for (let i = 0; i < frames * spec.bins; i++) {
          const value = vocalMask[i]!
          vocRe[ch]![i] = spec.re[ch]![i]! * value
          vocIm[ch]![i] = spec.im[ch]![i]! * value
          insRe[ch]![i] = spec.re[ch]![i]! * (1 - value)
          insIm[ch]![i] = spec.im[ch]![i]! * (1 - value)
        }
      }
      const startSample = frame * profile.hop
      istftAdd(vocals, norm, vocRe, vocIm, startSample, frames, profile)
      istftAdd(inst, norm, insRe, insIm, startSample, frames, profile)
      const percent = Math.min(0.95, (frame + frames) / totalFrames)
      if (frame % (chunkFrames * 4) === 0) postProgress('infer', percent)
      // 块间让出 worker 的事件循环：取消请求靠它送达
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    applyNorm(vocals, norm)
    applyNorm(inst, norm)
    // 裁掉首尾补的零
    if (pad > 0) {
      for (const track of [...vocals, ...inst]) track.copyWithin(0, pad, pad + length)
      for (const track of [...vocals, ...inst]) track.fill(0, length)
    }

    postProgress('write', 0.95)
    const dir = join(data.stemsDir, songId)
    mkdirSync(dir, { recursive: true })
    writeWav16(join(dir, 'vocals.wav'), vocals, clip.sampleRate)
    writeWav16(join(dir, 'instrumental.wav'), inst, clip.sampleRate)

    const monoVocal = new Float32Array(length)
    for (let i = 0; i < length; i++) monoVocal[i] = (vocals[0]![i]! + vocals[1]![i]!) * 0.5
    const curve = rmsCurve(monoVocal, clip.sampleRate, 0.05)
    const phrases = detectPhrases(curve, 0.05, 0, 0.12, 0.6, 0.8)

    const stem: StemInfo = {
      state: 'ready',
      window: { start: 0, end: length / clip.sampleRate },
      vocalCurve: curve,
      phrases,
      model: modelFile.split(/[\\/]/).pop() ?? modelFile,
      error: null
    }
    post({ type: 'done', songId, stem })
  } catch (err) {
    if (err instanceof CancelledError || cancelled) {
      post({ type: 'cancelled', songId })
      return
    }
    post({ type: 'failed', songId, error: err instanceof Error ? err.message : String(err) })
  } finally {
    running = false
  }
}

/**
 * 把一块频谱送进模型，返回人声掩码。
 *
 * 两个容易踩的坑：
 * 1. 输出布局是 [1, C, bins, frames] —— 时间维在最后，所以第 (b, f) 个元素
 *    在 c*bins*frames + b*frames + f。**按 frame-major 读会把掩码整体转置**，
 *    结果是分轨出来全是噪声。
 * 2. 掩码的第 0 通道才是人声（UVR 的 MDX / MDX23C 都取第一通道），
 *    伴奏轨用 1 - 掩码。
 */
async function inferMask(
  ort: NonNullable<Awaited<ReturnType<typeof getSession>>>['ort'],
  session: NonNullable<Awaited<ReturnType<typeof getSession>>>['session'],
  info: NonNullable<Awaited<ReturnType<typeof getSession>>>['info'],
  re: Float32Array[],
  im: Float32Array[],
  frames: number
): Promise<StemMask> {
  const bins = info.bins
  // 固定 T 的模型（很多 UVR 导出是 dim_t=256）要求每一块长度一致：末块补零再截取。
  const modelFrames = info.maxFrames ?? frames
  const padded = Math.max(frames, modelFrames)
  const shape = [1, info.channels, bins, padded]
  const tensorData = new Float32Array(info.channels * bins * padded)
  // ONNX 布局 [1, C, bins, frames]：C 通道依次是 [L实, L虚, R实, R虚]，C=2 时退化为单声道 [实, 虚]
  const planes: Float32Array[] = info.channels === 4 ? [re[0]!, im[0]!, re[1]!, im[1]!] : [re[0]!, im[0]!]
  for (let c = 0; c < info.channels; c++) {
    const src = planes[c]!
    const offset = c * bins * padded
    for (let frame = 0; frame < frames; frame++) {
      const from = frame * bins
      const to = offset + frame * bins
      tensorData.set(src.subarray(from, from + bins), to)
    }
  }
  const tensor = new ort.Tensor('float32', tensorData, shape)
  const feeds: Record<string, unknown> = { [info.inputName]: tensor }
  const result = await session.run(feeds)
  const output = result[info.outputName] ?? Object.values(result)[0]
  if (!output || output.data.length < bins * padded) {
    throw new Error(
      `模型输出形状不符合预期：期望至少 ${bins * padded} 个 float，实际 ${output?.data.length ?? 0}`
    )
  }
  // 输出是 [C][bins][frames]：取第 0 通道（人声），按 bin-major 读回 frame-major
  const vocal = readVocalMask(output.data, bins, frames, padded)
  return { kind: 'real', planes: [vocal, vocal] }
}
