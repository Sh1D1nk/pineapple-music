#!/usr/bin/env node
/**
 * Builds the test fixtures: ten short audio files that cover every tag path the app reads
 * (ID3v2.3/v2.4, SYLT, FLAC pictures + Vorbis comments, MP4 ilst, a GBK-mislabeled file, a
 * tagless file and two drum loops at known tempos) plus matching .lrc files.
 *
 * Everything is synthesised here — no third-party audio is embedded.
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'fixtures')
const require = createRequire(import.meta.url)

function ffmpegBin() {
  if (process.env.LOCALMUSIC_FFMPEG) return process.env.LOCALMUSIC_FFMPEG
  try {
    const candidate = require('ffmpeg-static')
    if (typeof candidate === 'string' && existsSync(candidate)) return candidate
  } catch {
    /* optional */
  }
  return 'ffmpeg'
}

const FFMPEG = ffmpegBin()

function run(args) {
  return new Promise((res, rej) => {
    const child = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      windowsHide: true
    })
    let stderr = ''
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('error', rej)
    child.on('close', (code) => (code === 0 ? res() : rej(new Error(`ffmpeg ${code}: ${stderr}`))))
  })
}

/* ------------------------------------------------------------------ audio */

const SINE = (freq, seconds, extra = '') =>
  `sine=frequency=${freq}:duration=${seconds},volume=0.22${extra}`

async function makeTone(file, seconds, freq, format) {
  await run([
    '-f',
    'lavfi',
    '-i',
    SINE(freq, seconds),
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${freq * 1.5}:duration=${seconds},volume=0.12`,
    '-filter_complex',
    '[0:a][1:a]amix=inputs=2:duration=shortest,afade=t=in:d=0.3,afade=t=out:st=' +
      (seconds - 1.2).toFixed(2) +
      ':d=1.2',
    ...format
  ])
}

/**
 * A kick/snare/hat pattern at an exact tempo, synthesised sample by sample — ffmpeg's filter
 * parser mangles the commas in aevalsrc expressions, and doing it here guarantees the BPM.
 */
async function makeLoop(file, bpm, bars = 24) {
  const sr = 44100
  const beat = 60 / bpm
  const total = beat * 4 * bars
  const frames = Math.ceil(total * sr)
  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  let seed = 12345
  const noise = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296
    return (seed / 4294967296) * 2 - 1
  }
  const add = (atSec, lengthSec, gen, gain) => {
    const start = Math.floor(atSec * sr)
    const count = Math.floor(lengthSec * sr)
    for (let i = 0; i < count; i++) {
      const index = start + i
      if (index >= frames) break
      const t = i / sr
      const value = gen(t) * gain
      left[index] += value
      right[index] += value
    }
  }
  const kick = (t) => Math.sin(2 * Math.PI * (52 + 110 * Math.exp(-t * 26)) * t) * Math.exp(-t * 11)
  const snare = (t) => noise() * Math.exp(-t * 26) * 0.8
  const hat = (t) => noise() * Math.exp(-t * 90) * 0.28
  const bass = (t, freq) => Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * 3.2) * 0.28

  for (let bar = 0; bar < bars; bar++) {
    for (let step = 0; step < 4; step++) {
      const at = (bar * 4 + step) * beat
      add(at, 0.35, kick, 0.95)
      if (step === 1 || step === 3) add(at, 0.22, snare, 0.7)
      add(at, 0.06, hat, 0.5)
      add(at + beat / 2, 0.05, hat, 0.34)
      add(at, beat * 1.8, (t) => bass(t, step % 2 === 0 ? 55 : 73.4), 0.8)
    }
  }

  const wav = Buffer.alloc(44 + frames * 4)
  wav.write('RIFF', 0, 'latin1')
  wav.writeUInt32LE(36 + frames * 4, 4)
  wav.write('WAVE', 8, 'latin1')
  wav.write('fmt ', 12, 'latin1')
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(2, 22)
  wav.writeUInt32LE(sr, 24)
  wav.writeUInt32LE(sr * 4, 28)
  wav.writeUInt16LE(4, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36, 'latin1')
  wav.writeUInt32LE(frames * 4, 40)
  for (let i = 0; i < frames; i++) {
    const l = Math.max(-1, Math.min(1, left[i]))
    const r = Math.max(-1, Math.min(1, right[i]))
    wav.writeInt16LE(Math.round(l * 32000), 44 + i * 4)
    wav.writeInt16LE(Math.round(r * 32000), 46 + i * 4)
  }
  const tmp = join(outDir, '.loop.wav')
  writeFileSync(tmp, wav)
  await run(['-i', tmp, '-ac', '2', '-ar', '44100', '-b:a', '192k', '-id3v2_version', '0', file])
  rmSync(tmp, { force: true })
  return { bpm, total }
}

/* ------------------------------------------------------------------ images */

async function makeCover(file, color, accent) {
  // drawtext needs fontconfig, which a bare ffmpeg build on Windows does not ship — geometric
  // artwork is enough for a fixture and always renders.
  const filters = [
    'drawbox=x=70:y=70:w=560:h=560:color=white@0.22:t=5',
    'drawbox=x=140:y=140:w=420:h=420:color=' + accent + '@0.55:t=fill',
    'drawbox=x=250:y=250:w=200:h=200:color=white@0.85:t=fill',
    'drawgrid=w=70:h=70:t=1:c=white@0.12'
  ].join(',')
  await run([
    '-f',
    'lavfi',
    '-i',
    'color=c=' + color + ':s=700x700',
    '-vf',
    filters,
    '-frames:v',
    '1',
    file
  ])
}

/* ------------------------------------------------------------------ ID3v2 */

const syncsafe = (n) => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f])
const u32be = (n) => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n >>> 0, 0)
  return b
}

function utf16(str) {
  const body = Buffer.from(str, 'utf16le')
  const swapped = Buffer.alloc(body.length)
  for (let i = 0; i < body.length; i += 2) {
    swapped[i] = body[i + 1]
    swapped[i + 1] = body[i]
  }
  return Buffer.concat([Buffer.from([0xff, 0xfe]), body])
}

function textFrame(id, text, { utf8 = true, gbk = false } = {}) {
  let payload
  if (gbk) payload = Buffer.concat([Buffer.from([0x00]), Buffer.from(text, 'latin1')])
  else if (utf8) payload = Buffer.concat([Buffer.from([0x03]), Buffer.from(text, 'utf8')])
  else payload = Buffer.concat([Buffer.from([0x01]), utf16(text)])
  return { id, payload }
}

function rawTextFrame(id, rawBytes) {
  return { id, payload: Buffer.concat([Buffer.from([0x00]), rawBytes]) }
}

function apicFrame(jpeg) {
  return {
    id: 'APIC',
    payload: Buffer.concat([
      Buffer.from([0x00]),
      Buffer.from('image/jpeg', 'latin1'),
      Buffer.from([0x00, 0x03]),
      Buffer.from('Front cover', 'latin1'),
      Buffer.from([0x00]),
      jpeg
    ])
  }
}

function usltFrame(text, { utf8 = true } = {}) {
  const body = utf8
    ? Buffer.concat([Buffer.from([0x03]), Buffer.from('chi', 'latin1'), Buffer.from([0x00]), Buffer.from(text, 'utf8')])
    : Buffer.concat([Buffer.from([0x01]), Buffer.from('chi', 'latin1'), Buffer.from([0x00, 0x00]), utf16(text)])
  return { id: 'USLT', payload: body }
}

function syltFrame(lines, { utf8 = true } = {}) {
  const parts = [
    Buffer.from([utf8 ? 0x03 : 0x01]),
    Buffer.from('chi', 'latin1'),
    Buffer.from([0x02, 0x01])
  ]
  parts.push(utf8 ? Buffer.from([0x00]) : Buffer.from([0x00, 0x00]))
  for (const line of lines) {
    parts.push(utf8 ? Buffer.from(line.text, 'utf8') : utf16(line.text))
    if (utf8) parts.push(Buffer.from([0x00]))
    else parts.push(Buffer.from([0x00, 0x00]))
    const ts = Buffer.alloc(4)
    ts.writeUInt32BE(Math.round(line.time * 1000), 0)
    parts.push(ts)
  }
  return { id: 'SYLT', payload: Buffer.concat(parts) }
}

function writeId3v2(file, version, frames) {
  const body = []
  for (const frame of frames) {
    const size =
      version === 4 ? syncsafe(frame.payload.length) : u32be(frame.payload.length)
    body.push(Buffer.from(frame.id, 'latin1'), size, Buffer.from([0, 0]), frame.payload)
  }
  const framesBuf = Buffer.concat(body)
  const header = Buffer.concat([
    Buffer.from('ID3', 'latin1'),
    Buffer.from([version, 0, 0]),
    syncsafe(framesBuf.length)
  ])
  const audio = readFileSync(file)
  writeFileSync(file, Buffer.concat([header, framesBuf, audio]))
}

const BASIC = (title, artist, album, albumArtist, track, total, year, genre, bpm = '92') => [
  textFrame('TIT2', title, { utf8: false }),
  textFrame('TPE1', artist, { utf8: false }),
  textFrame('TPE2', albumArtist, { utf8: false }),
  textFrame('TALB', album, { utf8: false }),
  textFrame('TRCK', `${track}/${total}`),
  textFrame('TPOS', '1/1'),
  textFrame('TYER', String(year)),
  textFrame('TCON', genre),
  textFrame('TBPM', bpm)
]

/* ------------------------------------------------------------------ FLAC blocks */

function readFlacBlocks(buf) {
  const blocks = []
  let offset = 4
  let last = false
  while (!last) {
    const header = buf[offset]
    last = (header & 0x80) !== 0
    const type = header & 0x7f
    const length = (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3]
    blocks.push({ type, data: buf.subarray(offset + 4, offset + 4 + length) })
    offset += 4 + length
  }
  return { blocks, audioStart: offset }
}

function vorbisComment(fields) {
  const vendor = Buffer.from('local-music-fixtures', 'utf8')
  const parts = [u32le(vendor.length), vendor, u32le(fields.length)]
  for (const [key, value] of fields) {
    const entry = Buffer.from(`${key}=${value}`, 'utf8')
    parts.push(u32le(entry.length), entry)
  }
  return Buffer.concat(parts)
}

function u32le(n) {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n >>> 0, 0)
  return b
}

function pictureBlock(jpeg, width, height) {
  const mime = Buffer.from('image/jpeg', 'latin1')
  const desc = Buffer.from('Front', 'latin1')
  return Buffer.concat([
    u32be(3),
    u32be(mime.length),
    mime,
    u32be(desc.length),
    desc,
    u32be(width),
    u32be(height),
    u32be(24),
    u32be(0),
    u32be(jpeg.length),
    jpeg
  ])
}

function writeFlac(file, { comments, picture }) {
  const buf = readFileSync(file)
  const { blocks, audioStart } = readFlacBlocks(buf)
  const kept = blocks.filter((b) => b.type !== 4 && b.type !== 6)
  const next = [...kept, { type: 4, data: vorbisComment(comments) }]
  if (picture) next.push({ type: 6, data: pictureBlock(picture, 700, 700) })
  const out = [Buffer.from('fLaC', 'latin1')]
  next.forEach((block, index) => {
    const isLast = index === next.length - 1
    const header = Buffer.from([
      (isLast ? 0x80 : 0) | block.type,
      (block.data.length >> 16) & 0xff,
      (block.data.length >> 8) & 0xff,
      block.data.length & 0xff
    ])
    out.push(header, block.data)
  })
  out.push(buf.subarray(audioStart))
  writeFileSync(file, Buffer.concat(out))
}

/* ------------------------------------------------------------------ MP4 ilst */

function atom(name, ...children) {
  const payload = Buffer.concat(children)
  const size = Buffer.alloc(4)
  size.writeUInt32BE(payload.length + 8, 0)
  return Buffer.concat([size, Buffer.from(name, 'latin1'), payload])
}

function dataAtom(typeFlag, payload) {
  const flag = Buffer.alloc(4)
  flag.writeUInt32BE(typeFlag, 0)
  return atom('data', flag, Buffer.alloc(4), payload)
}

function textItem(name, text) {
  return atom(name, dataAtom(1, Buffer.from(text, 'utf8')))
}

function trknItem(track, total) {
  const payload = Buffer.from([0, 0, track, total, 0, 0, 0, 0])
  return atom('trkn', dataAtom(0, payload))
}

function covrItem(jpeg) {
  return atom('covr', dataAtom(13, jpeg))
}

/** Insert a udta/meta/ilst into an existing moov, fixing every size on the way back out. */
function writeMp4Tags(file, items) {
  const buf = readFileSync(file)
  let offset = 0
  const boxes = []
  while (offset < buf.length) {
    const size = buf.readUInt32BE(offset)
    const type = buf.toString('latin1', offset + 4, offset + 8)
    boxes.push({ type, start: offset, size })
    if (size === 0) break
    offset += size
  }
  const moov = boxes.find((b) => b.type === 'moov')
  if (!moov) throw new Error('no moov atom')

  const moovPayload = buf.subarray(moov.start + 8, moov.start + moov.size)
  // Strip an existing udta so re-running the script stays idempotent.
  const children = []
  let p = 0
  while (p < moovPayload.length) {
    const size = moovPayload.readUInt32BE(p)
    const type = moovPayload.toString('latin1', p + 4, p + 8)
    if (type !== 'udta') children.push(moovPayload.subarray(p, p + size))
    p += size
  }

  const hdlr = atom(
    'hdlr',
    Buffer.from([0, 0, 0, 0]),
    Buffer.alloc(4),
    Buffer.from('mdir', 'latin1'),
    Buffer.from('appl', 'latin1'),
    Buffer.alloc(9),
    Buffer.from([0])
  )
  const ilst = atom('ilst', ...items)
  const meta = atom('meta', Buffer.from([0, 0, 0, 0]), hdlr, ilst)
  const udta = atom('udta', meta)
  const newMoov = atom('moov', ...children, udta)

  const before = buf.subarray(0, moov.start)
  const after = buf.subarray(moov.start + moov.size)
  writeFileSync(file, Buffer.concat([before, newMoov, after]))
}

/* ------------------------------------------------------------------ LRC files */

const LRC_STANDARD = `[ti:夜航]
[ar:林间电波]
[al:夜航]
[by:local-music-fixtures]
[offset:0]
[00:01.20]霓虹沿着江面铺开
[00:05.60]风把城市吹得很轻
[00:10.10]我在旧收音机里
[00:14.40]听见另一个黎明
[00:19.20]所有的灯都醒着
[00:23.80]等一句没有回应的晚安
[00:28.40]夜航的人不睡
[00:32.90]把星星当作路标
`

const LRC_ENHANCED = `[ti:逐字测试]
[ar:林间电波]
[al:逐字]
[00:01.00]<00:01.00>逐<00:01.55>字<00:02.10>点<00:02.65>亮<00:03.20>屏<00:03.75>幕
[00:05.50]<00:05.50>每<00:06.00>一<00:06.50>个<00:07.00>音<00:07.50>节
[00:10.00]<00:10.00>都<00:10.60>有<00:11.20>光<00:11.80>的<00:12.40>形<00:13.00>状
[00:16.00]<00:16.00>慢<00:16.70>慢<00:17.40>落<00:18.10>下
[00:22.00]<00:22.00>然<00:22.60>后<00:23.20>又<00:23.80>升<00:24.40>起
`

const LRC_BILINGUAL = `[ti:双语测试]
[ar:林间电波]
[00:01.50]我把海放在口袋里
[00:01.50]I keep the ocean in my pocket
[00:06.20]它随呼吸慢慢涨潮
[00:06.20]It rises with every breath I take
[00:11.40]如果你听见风
[00:11.40]If you can hear the wind
[00:15.90]那是我在说你
[00:15.90]Then I am calling your name
`

const LRC_GBK_TEXT = `[ti:乱码测试]
[ar:老街磁带]
[00:01.00]这是用国标编码保存的歌词
[00:05.50]如果没有正确解码就会变成乱码
[00:10.20]测试字符：中文、标点、数字 123
[00:15.00]最后一行用来确认解析完整
`

/* ------------------------------------------------------------------ main */

async function main() {
  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })

  const cover1 = join(outDir, 'cover-fleet.jpg')
  const cover2 = join(outDir, 'cover-night.jpg')
  await makeCover(cover1, '0x1b3b6f', '0x2f6fb5')
  await makeCover(cover2, '0x5f2230', '0xb5462f')
  const jpeg1 = readFileSync(cover1)
  const jpeg2 = readFileSync(cover2)

  // 1 — mp3 ID3v2.3: APIC + USLT + TCOM/TEXT/TIPL + full basics
  const f1 = join(outDir, '01 - 晴天.mp3')
  await makeTone(f1, 34, 330, ['-ac', '2', '-ar', '44100', '-b:a', '192k', '-id3v2_version', '0', f1])
  writeId3v2(f1, 3, [
    ...BASIC('晴天', '林间电波', '天气样本', '林间电波', 1, 10, 2021, 'City Pop'),
    apicFrame(jpeg1),
    usltFrame(LRC_STANDARD, { utf8: false }),
    textFrame('TCOM', '周牧', { utf8: false }),
    textFrame('TEXT', '苏野', { utf8: false }),
    textFrame('IPLS', 'producer\u0000林间电波\u0000mix\u0000陈一\u0000arranger\u0000周牧', { utf8: false })
  ])

  // 2 — mp3 ID3v2.4 UTF-8 with SYLT
  const f2 = join(outDir, '02 - 夜航.mp3')
  await makeTone(f2, 36, 262, ['-ac', '2', '-ar', '44100', '-b:a', '192k', '-id3v2_version', '0', f2])
  writeId3v2(f2, 4, [
    textFrame('TIT2', '夜航'),
    textFrame('TPE1', '林间电波'),
    textFrame('TPE2', '林间电波'),
    textFrame('TALB', '夜航'),
    textFrame('TRCK', '2/10'),
    textFrame('TYER', '2023'),
    textFrame('TCON', 'Ambient'),
    textFrame('TCOM', '周牧'),
    textFrame('TEXT', '苏野'),
    apicFrame(jpeg2),
    syltFrame([
      { time: 1.2, text: '霓虹沿着江面铺开' },
      { time: 5.6, text: '风把城市吹得很轻' },
      { time: 10.1, text: '我在旧收音机里' },
      { time: 14.4, text: '听见另一个黎明' },
      { time: 19.2, text: '所有的灯都醒着' }
    ])
  ])

  // 3 — flac: PICTURE + LYRICS (LRC) + composer/lyricist/producer/arranger
  const f3 = join(outDir, '03 - 山海.flac')
  await makeTone(f3, 32, 196, ['-ac', '2', '-ar', '44100', f3])
  writeFlac(f3, {
    comments: [
      ['TITLE', '山海'],
      ['ARTIST', '林间电波'],
      ['ALBUMARTIST', '林间电波'],
      ['ALBUM', '山海'],
      ['TRACKNUMBER', '3'],
      ['TRACKTOTAL', '10'],
      ['DATE', '2022'],
      ['GENRE', 'Folk'],
      ['BPM', '88'],
      ['COMPOSER', '周牧'],
      ['LYRICIST', '苏野'],
      ['PRODUCER', '林间电波'],
      ['ARRANGER', '陈一'],
      ['LYRICS', LRC_STANDARD]
    ],
    picture: jpeg1
  })

  // 4 — m4a: covr + ©lyr + ©wrt
  const f4 = join(outDir, '04 - Midnight Drive.m4a')
  await makeTone(f4, 30, 294, ['-ac', '2', '-ar', '44100', '-c:a', 'aac', '-b:a', '192k', f4])
  writeMp4Tags(f4, [
    textItem('\u00a9nam', 'Midnight Drive'),
    textItem('\u00a9ART', 'Lumen Park'),
    textItem('aART', 'Lumen Park'),
    textItem('\u00a9alb', 'After Hours'),
    textItem('\u00a9wrt', 'Lumen Park'),
    textItem('\u00a9day', '2024'),
    textItem('\u00a9gen', 'Synthwave'),
    textItem('\u00a9lyr', '[00:02.00]Headlights on the empty lane\n[00:07.00]The city hums a slower song\n[00:12.00]We drive until the morning comes'),
    trknItem(1, 8),
    covrItem(jpeg2)
  ])

  // 5 — standard LRC sidecar
  const f5 = join(outDir, '05 - 逐字测试.mp3')
  await makeTone(f5, 30, 349, ['-ac', '2', '-ar', '44100', '-b:a', '192k', '-id3v2_version', '0', f5])
  writeId3v2(f5, 3, [
    ...BASIC('逐字测试', '林间电波', '逐字', '林间电波', 5, 10, 2024, 'Electronic'),
    apicFrame(jpeg1)
  ])
  writeFileSync(join(outDir, '05 - 逐字测试.lrc'), LRC_ENHANCED, 'utf8')

  // 6 — bilingual LRC
  const f6 = join(outDir, '06 - 双语测试.mp3')
  await makeTone(f6, 28, 220, ['-ac', '2', '-ar', '44100', '-b:a', '192k', '-id3v2_version', '0', f6])
  writeId3v2(f6, 3, [
    ...BASIC('双语测试', '林间电波', '双语', '林间电波', 6, 10, 2024, 'Indie'),
    apicFrame(jpeg2)
  ])
  writeFileSync(join(outDir, '06 - 双语测试.lrc'), LRC_BILINGUAL, 'utf8')

  // 7 — declared ISO-8859-1 but the bytes are GBK (both tags and the .lrc)
  const f7 = join(outDir, '07 - 乱码测试.mp3')
  await makeTone(f7, 26, 175, ['-ac', '2', '-ar', '44100', '-b:a', '192k', '-id3v2_version', '0', f7])
  writeId3v2(f7, 3, [
    rawTextFrame('TIT2', Buffer.from([0xc0, 0xcf, 0xbd, 0xd6, 0xb4, 0xc5, 0xb4, 0xf8, 0x20, 0x37])),
    rawTextFrame('TPE1', Buffer.from([0xc0, 0xcf, 0xbd, 0xd6, 0xb4, 0xc5, 0xb4, 0xf8])),
    rawTextFrame('TALB', Buffer.from([0xc2, 0xd2, 0xc2, 0xeb, 0xd1, 0xf9, 0xb1, 0xbe])),
    apicFrame(jpeg1)
  ])
  writeFileSync(join(outDir, '07 - 乱码测试.lrc'), Buffer.from(encodeGbk(LRC_GBK_TEXT)))

  // 8 — no tags at all, filename carries "artist - title"
  const f8 = join(outDir, '无名氏 - 未命名旋律.mp3')
  await makeTone(f8, 24, 311, ['-ac', '2', '-ar', '44100', '-b:a', '192k', '-id3v2_version', '0', f8])

  // 9/10 — drum loops for the AutoMix planner (100 and 108 BPM)
  const loopA = join(outDir, '09 - Loop 100.mp3')
  const loopB = join(outDir, '10 - Loop 108.mp3')
  const a = await makeLoop(loopA, 100, 40)
  const b = await makeLoop(loopB, 108, 40)
  writeId3v2(loopA, 3, [
    ...BASIC('Loop 100', 'Fixture Beats', 'AutoMix Lab', 'Fixture Beats', 1, 2, 2026, 'Electronic', '100'),
    apicFrame(jpeg1)
  ])
  writeId3v2(loopB, 3, [
    ...BASIC('Loop 108', 'Fixture Beats', 'AutoMix Lab', 'Fixture Beats', 2, 2, 2026, 'Electronic', '108'),
    apicFrame(jpeg2)
  ])

  rmSync(cover1, { force: true })
  rmSync(cover2, { force: true })

  console.log(`fixtures written to ${outDir}`)
  console.log(`  loops: 100 BPM (${a.total.toFixed(2)}s), 108 BPM (${b.total.toFixed(2)}s)`)
}

function encodeGbk(text) {
  // Node cannot encode GBK natively; use the reverse lookup of TextDecoder by scanning.
  const decoder = new TextDecoder('gbk')
  const cache = new Map()
  for (let hi = 0x81; hi <= 0xfe; hi++) {
    for (let lo = 0x40; lo <= 0xfe; lo++) {
      if (lo === 0x7f) continue
      const ch = decoder.decode(Buffer.from([hi, lo]))
      if (ch.length === 1 && !cache.has(ch)) cache.set(ch, [hi, lo])
    }
  }
  const out = []
  for (const ch of text) {
    const code = ch.codePointAt(0)
    if (code < 0x80) out.push(code)
    else {
      const pair = cache.get(ch)
      if (pair) out.push(pair[0], pair[1])
      else out.push(0x3f)
    }
  }
  return out
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
