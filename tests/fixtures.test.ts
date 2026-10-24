import { describe, expect, it, beforeAll } from 'vitest'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { readTags } from '../src/main/library/tags'
import { decodeTextBuffer, looksLikeMojibake, repairMojibake } from '../src/main/library/encoding'

const fixtures = join(process.cwd(), 'fixtures')

const file = (name: string): string => join(fixtures, name)

beforeAll(() => {
  if (!existsSync(file('01 - 晴天.mp3'))) {
    const result = spawnSync(process.execPath, ['scripts/make-fixtures.mjs'], { stdio: 'inherit' })
    if (result.status !== 0) throw new Error('fixture generation failed')
  }
})

describe('fixtures', () => {
  it('generates all ten source files', () => {
    const names = readdirSync(fixtures)
    expect(names.filter((n) => /\.(mp3|flac|m4a)$/i.test(n))).toHaveLength(10)
  })

  it('reads ID3v2.3 basics, cover, USLT lyrics and TIPL credits', async () => {
    const tags = await readTags(file('01 - 晴天.mp3'))
    expect(tags.title).toBe('晴天')
    expect(tags.artists).toEqual(['林间电波'])
    expect(tags.album).toBe('天气样本')
    expect(tags.trackNo).toBe(1)
    expect(tags.trackTotal).toBe(10)
    expect(tags.year).toBe(2021)
    expect(tags.genre).toBe('City Pop')
    expect(tags.covers.length).toBeGreaterThan(0)
    expect(tags.covers[0]!.data.length).toBeGreaterThan(1000)
    expect(tags.credits.composer).toContain('周牧')
    expect(tags.credits.lyricist).toContain('苏野')
    expect(tags.credits.producer.length).toBeGreaterThan(0)
    expect(tags.credits.mixer.length).toBeGreaterThan(0)
    expect(tags.lyrics?.text).toContain('霓虹沿着江面铺开')
    expect(tags.durationSec).toBeGreaterThan(30)
    expect(tags.sampleRate).toBe(44100)
    expect(tags.channels).toBe(2)
  })

  it('reads SYLT from ID3v2.4', async () => {
    const tags = await readTags(file('02 - 夜航.mp3'))
    expect(tags.lyrics?.kind).toBe('sylt')
    expect(tags.lyrics?.synced?.length).toBeGreaterThanOrEqual(5)
    expect(tags.lyrics?.synced?.[0]?.text).toContain('霓虹')
    expect(tags.lyrics?.synced?.[0]?.t).toBeCloseTo(1.2, 1)
    expect(tags.credits.composer).toContain('周牧')
  })

  it('reads FLAC picture, LYRICS and Vorbis role tags', async () => {
    const tags = await readTags(file('03 - 山海.flac'))
    expect(tags.title).toBe('山海')
    expect(tags.covers.length).toBeGreaterThan(0)
    expect(tags.lyrics?.kind).toBe('lrc')
    expect(tags.lyrics?.text).toContain('[00:01.20]')
    expect(tags.lyrics?.text).toContain('霓虹沿着江面铺开')
    expect(tags.credits.composer).toContain('周牧')
    expect(tags.credits.lyricist).toContain('苏野')
    expect(tags.credits.producer).toContain('林间电波')
    expect(tags.credits.arranger).toContain('陈一')
    expect(tags.bpm).toBe(88)
  })

  it('reads MP4 covr, ©lyr and ©wrt', async () => {
    const tags = await readTags(file('04 - Midnight Drive.m4a'))
    expect(tags.title).toBe('Midnight Drive')
    expect(tags.album).toBe('After Hours')
    expect(tags.covers.length).toBeGreaterThan(0)
    expect(tags.lyrics?.text).toContain('Headlights')
    expect(tags.credits.composer).toContain('Lumen Park')
    expect(tags.durationSec).toBeGreaterThan(25)
  })

  it('repairs GBK bytes that were declared as ISO-8859-1', async () => {
    const tags = await readTags(file('07 - 乱码测试.mp3'))
    expect(tags.title).toBe('老街磁带 7')
    expect(tags.artists).toEqual(['老街磁带'])
    expect(tags.album).toBe('乱码样本')
    expect(tags.title).not.toContain('\ufffd')
  })

  it('falls back to the filename when there are no tags at all', async () => {
    const tags = await readTags(file('无名氏 - 未命名旋律.mp3'))
    expect(tags.title).toBe('未命名旋律')
    expect(tags.artists).toEqual(['无名氏'])
    expect(tags.covers.length).toBe(0)
  })
})

describe('encoding', () => {
  it('detects mojibake candidates', () => {
    expect(looksLikeMojibake('ÄãºÃ')).toBe(true)
    expect(looksLikeMojibake('晴天')).toBe(false)
    expect(looksLikeMojibake('Midnight Drive')).toBe(false)
  })

  it('restores GBK text from a Latin-1 round trip', () => {
    const original = '老街磁带'
    const bytes = Buffer.from([0xc0, 0xcf, 0xbd, 0xd6, 0xb4, 0xc5, 0xb4, 0xf8])
    const latin1 = bytes.toString('latin1')
    expect(repairMojibake(latin1)).toBe(original)
  })

  it('decodes UTF-8, UTF-16 and GBK buffers', () => {
    expect(decodeTextBuffer(Buffer.from('中文歌词', 'utf8')).text).toBe('中文歌词')
    expect(decodeTextBuffer(Buffer.from('\ufeff中文歌词', 'utf8')).encoding).toBe('utf-8-bom')
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文歌词', 'utf16le')])
    expect(decodeTextBuffer(utf16).text).toBe('中文歌词')
  })
})
