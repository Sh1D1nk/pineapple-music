import { describe, expect, it } from 'vitest'
import {
  fillEndTimes,
  mergeMultilingual,
  parseSidecarText
} from '../src/main/lyrics/lyricsService'
import { decodeTextBuffer } from '../src/main/library/encoding'

const STANDARD = `[ti:测试]
[ar:某人]
[offset:500]
[00:01.00]第一行
[00:05.20][00:20.40]重复行
[00:10.00]第三行
`

const ENHANCED = `[00:01.00]<00:01.00>逐<00:01.50>字<00:02.00>高<00:02.50>亮
[00:05.00]<00:05.00>第<00:05.60>二<00:06.20>行
`

const BILINGUAL = `[00:01.00]我把海放在口袋里
[00:01.00]I keep the ocean in my pocket
[00:06.00]它随呼吸慢慢涨潮
[00:06.00]It rises with every breath
`

const PLAIN = `第一段歌词
第二段歌词
第三段歌词`

describe('LRC parsing', () => {
  it('expands multiple timestamps on one line and reads the offset header', () => {
    const lines = parseSidecarText(STANDARD, 'lrc', 60)
    expect(lines.length).toBeGreaterThanOrEqual(4)
    const texts = lines.map((l) => l.words.map((w) => w.word).join(''))
    expect(texts.filter((t) => t === '重复行').length).toBe(2)
    // A positive [offset:] pulls the lyrics earlier, as every LRC player does.
    const first = lines.find((l) => l.words[0]?.word === '第一行')
    expect(first?.startTime).toBe(500)
  })

  it('keeps per-word timings from enhanced LRC', () => {
    const lines = parseSidecarText(ENHANCED, 'lrc', 30)
    expect(lines.length).toBe(2)
    expect(lines[0]!.words.length).toBe(4)
    expect(lines[0]!.words[1]!.startTime).toBeGreaterThan(lines[0]!.words[0]!.startTime)
    expect(lines[0]!.words[3]!.word).toBe('亮')
  })

  it('splits a bilingual pair into lyric + translation', () => {
    const parsed = parseSidecarText(BILINGUAL, 'lrc', 30)
    expect(parsed.length).toBe(2)
    expect(parsed[0]!.translatedLyric).toBe('I keep the ocean in my pocket')
    expect(parsed[1]!.translatedLyric).toBe('It rises with every breath')
    expect(parsed[0]!.endTime).toBeGreaterThan(parsed[0]!.startTime)
  })

  it('treats text without timestamps as a static list', () => {
    const lines = parseSidecarText(PLAIN, 'lrc', 30)
    expect(lines.length).toBe(3)
    expect(lines.every((l) => l.startTime === 0)).toBe(true)
  })

  it('caps a long interlude instead of letting a line run forever', () => {
    const lines = fillEndTimes(
      [
        {
          words: [{ startTime: 1000, endTime: 1000, word: 'a' }],
          translatedLyric: '',
          romanLyric: '',
          isBG: false,
          isDuet: false,
          startTime: 1000,
          endTime: 1000
        }
      ],
      400
    )
    expect(lines[0]!.endTime - lines[0]!.startTime).toBeLessThanOrEqual(15_000)
  })
})

const line = (text: string, start: number): Parameters<typeof mergeMultilingual>[0][number] => ({
  words: [{ startTime: start, endTime: start + 2000, word: text }],
  translatedLyric: '',
  romanLyric: '',
  isBG: false,
  isDuet: false,
  startTime: start,
  endTime: start + 2000
})

describe('multilingual merge', () => {
  it('treats a latin line under Chinese as a translation', () => {
    const lines = mergeMultilingual([line('晴天', 1000), line('A sunny day', 1000)])
    expect(lines).toHaveLength(1)
    expect(lines[0]!.translatedLyric).toBe('A sunny day')
    expect(lines[0]!.romanLyric).toBe('')
  })

  it('treats a latin line under Japanese as romaji', () => {
    const lines = mergeMultilingual([line('君の名前', 1000), line('kimi no namae', 1000)])
    expect(lines[0]!.romanLyric).toBe('kimi no namae')
    expect(lines[0]!.translatedLyric).toBe('')
  })

  it('keeps both a translation and a romanisation when three lines share a timestamp', () => {
    const lines = mergeMultilingual([
      line('君の名前', 1000),
      line('你的名字', 1000),
      line('kimi no namae', 1000)
    ])
    expect(lines).toHaveLength(1)
    expect(lines[0]!.translatedLyric).toBe('你的名字')
    expect(lines[0]!.romanLyric).toBe('kimi no namae')
  })
})

describe('encoding detection for lyric files', () => {
  it('handles UTF-8 with and without BOM', () => {
    expect(decodeTextBuffer(Buffer.from('晴天', 'utf8')).text).toBe('晴天')
    expect(decodeTextBuffer(Buffer.from('\ufeff晴天', 'utf8')).text).toBe('晴天')
  })

  it('falls back to GB18030 for GBK bytes', () => {
    const gbk = Buffer.from([0xc7, 0xe7, 0xcc, 0xec])
    expect(decodeTextBuffer(gbk).text).toBe('晴天')
  })

  it('decodes UTF-16LE with BOM', () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('晴天', 'utf16le')])
    expect(decodeTextBuffer(buf).text).toBe('晴天')
  })
})
