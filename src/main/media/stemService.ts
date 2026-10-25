import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SongMeta, StemInfo } from '@shared/types'
import { applyNorm, detectPhrases, istftAdd, readVocalMask, rmsCurve, stft } from '@shared/stem/stft'
import { decodeClip } from './ffmpeg'
import { getSession, modelExists, status as runtimeStatus } from './stemRuntime'
import { stemsDir } from '../paths'

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

const CHUNK_FRAMES = 64

/** 一次推理返回的掩码：planes[0] 是人声掩码。 */
interface StemMask {
  kind: 'real'
  planes: Float32Array[]
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
 * 推理串行执行（一次一首），因为它是重活，且 onnxruntime 的线程池已经吃满 CPU。
 */
export class StemService {
  private queue: string[] = []
  private running = false
  private paused = false
  private cancelled = false
  private model: string | null = null
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

      const clip = await decodeClip(song.path, { channels: 2, sampleRate: 44100 })
      const [leftRaw, rightRaw] = clip.channels as [Float32Array, Float32Array]
      const length = Math.min(leftRaw.length, rightRaw.length)

      const session = await getSession(this.model)
      if (!session) throw new Error('模型加载失败')

      // 频谱参数按模型签名走：MDX-Net 是 n_fft=4096 不居中（2048 个频点），
      // 合成测试模型是 4096 居中（2049）。块大小取模型自己的固定帧数（常见 256）。
      const profile = session.info.profile
      const chunkFrames = Math.max(16, Math.min(session.info.maxFrames ?? CHUNK_FRAMES, 512))

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

      this.progress.stage = 'infer'
      for (let frame = 0; frame < totalFrames; frame += chunkFrames) {
        if (this.cancelled) throw new Error('已取消')
        const frames = Math.min(chunkFrames, totalFrames - frame)
        const spec = stft([left, right], frame * profile.hop, frames, profile)
        const mask = await this.inferMask(session, spec.re, spec.im, frames)
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
        this.progress.percent = Math.min(0.95, (frame + frames) / totalFrames)
        if (frame % (chunkFrames * 8) === 0) this.emit()
        // 让主进程喘口气：分块之间让出事件循环，窗口不会因为分轨卡住
        await new Promise((resolve) => setTimeout(resolve, 0))
      }

      applyNorm(vocals, norm)
      applyNorm(inst, norm)
      // 裁掉首尾补的零
      if (pad > 0) {
        for (const track of [...vocals, ...inst]) track.copyWithin(0, pad, pad + length)
        for (const track of [...vocals, ...inst]) track.fill(0, length)
      }

      this.progress.stage = 'write'
      this.emit()
      const dir = join(stemsDir(), songId)
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
        model: this.model.split(/[\\/]/).pop() ?? this.model,
        error: null
      }
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
  private async inferMask(
    ctx: Awaited<ReturnType<typeof getSession>>,
    re: Float32Array[],
    im: Float32Array[],
    frames: number
  ): Promise<StemMask> {
    if (!ctx) throw new Error('模型会话不可用')
    const { ort, session, info } = ctx
    const bins = info.bins
    // 固定 T 的模型（很多 UVR 导出是 dim_t=256）要求每一块长度一致：末块补零再截取。
    const modelFrames = info.maxFrames ?? frames
    const padded = Math.max(frames, modelFrames)
    const shape = [1, info.channels, bins, padded]
    const data = new Float32Array(info.channels * bins * padded)
    // ONNX 布局 [1, C, bins, frames]：C 通道依次是 [L实, L虚, R实, R虚]，C=2 时退化为单声道 [实, 虚]
    const planes: Float32Array[] =
      info.channels === 4 ? [re[0]!, im[0]!, re[1]!, im[1]!] : [re[0]!, im[0]!]
    for (let c = 0; c < info.channels; c++) {
      const src = planes[c]!
      const offset = c * bins * padded
      for (let frame = 0; frame < frames; frame++) {
        const from = frame * bins
        const to = offset + frame * bins
        data.set(src.subarray(from, from + bins), to)
      }
    }
    const tensor = new ort.Tensor('float32', data, shape)
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

/** 16-bit PCM WAV。分轨结果是中间产物，用无损 PCM 便于直接喂给播放器与下游。 */
export function writeWav16(path: string, channels: Float32Array[], sampleRate: number): void {
  const frames = Math.min(...channels.map((c) => c.length))
  const dataBytes = frames * channels.length * 2
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'latin1')
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8, 'latin1')
  header.write('fmt ', 12, 'latin1')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels.length, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * channels.length * 2, 28)
  header.writeUInt16LE(channels.length * 2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'latin1')
  header.writeUInt32LE(dataBytes, 40)
  const out = createWriteStream(path)
  out.write(header)
  const block = Buffer.alloc(65536 * 4)
  let offset = 0
  for (let i = 0; i < frames; i += 65536) {
    const count = Math.min(65536, frames - i)
    for (let k = 0; k < count; k++) {
      for (let c = 0; c < channels.length; c++) {
        const sample = Math.max(-1, Math.min(1, channels[c]![i + k]!))
        block.writeInt16LE(Math.round(sample * 32767), (k * channels.length + c) * 2)
      }
    }
    out.write(block.subarray(0, count * channels.length * 2))
  }
  out.end()
}
