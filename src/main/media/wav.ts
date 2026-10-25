import { createWriteStream } from 'node:fs'

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
  header.writeUInt16LE(channels.length, 32)
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
