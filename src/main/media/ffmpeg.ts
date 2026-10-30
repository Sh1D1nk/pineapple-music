import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, sep } from 'node:path'

let cachedPath: string | null = null

/**
 * Resolution order: explicit env override, the ffmpeg-static tarball (optional dependency — its
 * installer downloads from GitHub, which is not always reachable), a binary bundled next to the
 * app, then whatever `ffmpeg` is on PATH. The app never hard-fails because of this.
 */
function resolveFfmpeg(): string {
  const override = process.env.LOCALMUSIC_FFMPEG
  if (override && existsSync(override)) return override

  try {
    const req = createRequire(__filename)
    const mod = req('ffmpeg-static') as string | { default?: string }
    const raw = typeof mod === 'string' ? mod : mod.default
    if (raw) {
      // ffmpeg-static resolves into app.asar when packaged; the binary only exists unpacked.
      const unpacked = raw.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
      if (existsSync(unpacked)) return unpacked
      if (existsSync(raw)) return raw
    }
  } catch {
    /* optional dependency not installed */
  }

  const resources = (process as unknown as { resourcesPath?: string }).resourcesPath
  const candidates = [
    resources ? join(resources, 'bin', 'ffmpeg.exe') : null,
    join(process.cwd(), 'resources', 'bin', 'ffmpeg.exe'),
    // 开发/测试环境兜底：cwd 就是项目根时直接指向依赖里的二进制。
    // 打包后 cwd 下没有 node_modules，这两个候选会被 existsSync 跳过，不会误命中。
    join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'),
    join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg')
  ].filter(Boolean) as string[]
  for (const candidate of candidates) if (existsSync(candidate)) return candidate

  return 'ffmpeg'
}

export function ffmpegPath(): string {
  if (!cachedPath) cachedPath = resolveFfmpeg()
  return cachedPath
}

export interface RunResult {
  code: number
  stdout: Buffer
  stderr: string
}

export function runFfmpeg(args: string[], timeoutMs = 120_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), ['-hide_banner', '-nostdin', ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const chunks: Buffer[] = []
    let stderr = ''
    let killed = false
    const timer = setTimeout(() => {
      killed = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.on('data', (d: Buffer) => chunks.push(d))
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000)
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (killed) return reject(new Error('ffmpeg timed out'))
      resolve({ code: code ?? -1, stdout: Buffer.concat(chunks), stderr })
    })
  })
}

function toFloat32(buf: Buffer): Float32Array {
  const bytes = buf.byteLength - (buf.byteLength % 4)
  if (bytes <= 0) return new Float32Array(0)
  if (buf.byteOffset % 4 === 0) {
    return new Float32Array(buf.buffer, buf.byteOffset, bytes / 4)
  }
  const copy = new Uint8Array(bytes)
  copy.set(buf.subarray(0, bytes))
  return new Float32Array(copy.buffer, 0, bytes / 4)
}

export interface DecodeOptions {
  start?: number
  duration?: number
  sampleRate?: number
  channels?: 1 | 2
}

export interface PcmClip {
  channels: Float32Array[]
  sampleRate: number
  /** absolute seconds of the first sample */
  start: number
  duration: number
}

/** Decodes one clip to planar float PCM at 44.1 kHz — the only format the mixer accepts. */
export async function decodeClip(file: string, opts: DecodeOptions = {}): Promise<PcmClip> {
  const sampleRate = opts.sampleRate ?? 44100
  const channels = opts.channels ?? 2
  const args: string[] = ['-v', 'error']
  if (opts.start && opts.start > 0) args.push('-ss', opts.start.toFixed(3))
  if (opts.duration && opts.duration > 0) args.push('-t', opts.duration.toFixed(3))
  args.push(
    '-i',
    file,
    '-map',
    '0:a:0',
    '-ac',
    String(channels),
    '-ar',
    String(sampleRate),
    '-f',
    'f32le',
    '-acodec',
    'pcm_f32le',
    'pipe:1'
  )
  const { code, stdout, stderr } = await runFfmpeg(args, 180_000)
  if (code !== 0) throw new Error(`ffmpeg decode failed (${code}): ${stderr.slice(-400)}`)
  const interleaved = toFloat32(stdout)
  const frames = Math.floor(interleaved.length / channels)
  const planars: Float32Array[] = []
  for (let c = 0; c < channels; c++) {
    const plane = new Float32Array(frames)
    for (let i = 0; i < frames; i++) plane[i] = interleaved[i * channels + c]!
    planars.push(plane)
  }
  return {
    channels: planars,
    sampleRate,
    start: opts.start ?? 0,
    duration: frames / sampleRate
  }
}

/** Mono downmix used by the analysis worker. */
export async function decodeMono(file: string, start: number, duration: number): Promise<Float32Array> {
  const clip = await decodeClip(file, { start, duration, channels: 1, sampleRate: 44100 })
  return clip.channels[0] ?? new Float32Array(0)
}

export interface DynamicsMeasurement {
  duration: number
  lufs: number
  leadSilence: number
  tailSilence: number
  audioStart: number
  audioEnd: number
  samplePeakDb: number
}

/**
 * One ffmpeg pass for duration, integrated loudness and the effective audio bounds.
 * `silencedetect` gives the real head/tail silence, which is what the transition planner uses
 * instead of the file duration.
 */
export async function measureDynamics(file: string): Promise<DynamicsMeasurement> {
  const args = [
    '-nostats',
    '-i',
    file,
    '-map',
    '0:a:0',
    '-af',
    'silencedetect=noise=-50dB:d=0.25,ebur128=peak=true:framelog=quiet',
    '-f',
    'null',
    '-'
  ]
  const { stderr } = await runFfmpeg(args, 300_000)

  const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/)
  let duration = 0
  if (durationMatch) {
    duration =
      Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
  }

  const iMatches = [...stderr.matchAll(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/g)]
  const lufs = iMatches.length > 0 ? Number(iMatches[iMatches.length - 1]![1]) : -23

  const peaks = [...stderr.matchAll(/Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/g)]
  const samplePeakDb = peaks.length > 0 ? Number(peaks[peaks.length - 1]![1]) : -1

  const starts = [...stderr.matchAll(/silence_start:\s*(-?\d+(?:\.\d+)?)/g)].map((m) =>
    Number(m[1])
  )
  const ends = [...stderr.matchAll(/silence_end:\s*(-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]))

  let audioStart = 0
  let audioEnd = duration
  if (starts.length > 0 && starts[0]! <= 0.35) {
    const end = ends.find((e) => e > starts[0]!)
    if (end !== undefined) audioStart = end
  }
  if (ends.length > 0) {
    const lastEnd = ends[ends.length - 1]!
    const lastStart = starts.length > 0 ? starts[starts.length - 1]! : undefined
    if (lastStart !== undefined && lastStart > audioStart && duration - lastEnd < 1.5) {
      audioEnd = lastStart
    }
  }
  if (audioEnd <= audioStart) audioEnd = duration

  return {
    duration,
    lufs,
    leadSilence: audioStart,
    tailSilence: Math.max(0, duration - audioEnd),
    audioStart,
    audioEnd,
    samplePeakDb
  }
}
