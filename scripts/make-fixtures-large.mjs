#!/usr/bin/env node
/**
 * 生成大曲库夹具：默认 1800 张专辑 × 3 首 = 5400 个极小 MP3。
 * 只有 ID3 标签 + 几帧静音，单个 ~1KB，扫描时只走元数据解析，不产生音频分析。
 *
 * 用法：node scripts/make-fixtures-large.mjs [专辑数] [每张曲目数]
 */
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const albums = Number(process.argv[2] ?? 1800)
const perAlbum = Number(process.argv[3] ?? 3)
const root = join(import.meta.dirname, '..', 'fixtures', 'large')

function syncsafe(n) {
  return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f])
}

function frame(id, text) {
  const body = Buffer.concat([Buffer.from([0]), Buffer.from(text, 'latin1')]) // encoding 0 = ISO-8859-1
  const head = Buffer.alloc(10)
  head.write(id, 0, 4, 'latin1')
  head.writeUInt32BE(body.length, 4)
  head.writeUInt16BE(0, 8)
  return Buffer.concat([head, body])
}

function id3(title, artist, album, track, year) {
  const body = Buffer.concat([
    frame('TIT2', title),
    frame('TPE1', artist),
    frame('TALB', album),
    frame('TRCK', String(track)),
    frame('TYER', String(year))
  ])
  return Buffer.concat([Buffer.from('ID3'), Buffer.from([3, 0, 0]), syncsafe(body.length), body])
}

// 44.1kHz / 128kbps MPEG-1 Layer III 帧头，帧长 417 字节；4 帧 ≈ 0.1 秒
const frameBytes = Buffer.alloc(417)
frameBytes[0] = 0xff
frameBytes[1] = 0xfb
frameBytes[2] = 0x90
frameBytes[3] = 0x64
const audio = Buffer.concat([frameBytes, frameBytes, frameBytes, frameBytes])

let made = 0
for (let a = 1; a <= albums; a++) {
  const albumName = `Fixture Album ${String(a).padStart(4, '0')}`
  const artist = `Artist ${String((a % 97) + 1).padStart(2, '0')}`
  const dir = join(root, `A${String(a).padStart(4, '0')}`)
  mkdirSync(dir, { recursive: true })
  for (let t = 1; t <= perAlbum; t++) {
    const title = `Track ${String(t).padStart(2, '0')}`
    const file = join(dir, `${String(t).padStart(2, '0')} - ${title}.mp3`)
    if (existsSync(file)) continue
    writeFileSync(file, Buffer.concat([id3(title, artist, albumName, t, 1990 + (a % 30)), audio]))
    made++
  }
  if (a % 200 === 0) console.log(`albums ${a}/${albums}`)
}
console.log(`created ${made} files under ${root}（${albums} 张专辑 × ${perAlbum} 首）`)
