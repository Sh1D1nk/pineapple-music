import { existsSync, readFileSync, promises as fs } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import {
  parseLrcLike,
  parseLys,
  parseQrc,
  parseTTML,
  parseYrc,
  type LyricLine
} from '@applemusic-like-lyrics/lyric'
import type { LyricLineData, LyricSourceKind, LyricsPayload, SongMeta } from '@shared/types'
import type { EmbeddedLyrics } from '../library/tags'
import { decodeTextBuffer } from '../library/encoding'
import { lyricsCacheDir } from '../paths'
import { effectiveSources, lyricsCacheStamp } from './sourcePolicy'

const SIDECAR_ORDER: { ext: string; kind: LyricSourceKind }[] = [
  { ext: '.lrc', kind: 'lrc' },
  { ext: '.ttml', kind: 'ttml' },
  { ext: '.lys', kind: 'lys' },
  { ext: '.yrc', kind: 'yrc' },
  { ext: '.qrc', kind: 'qrc' }
]

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/
const KANA_RE = /[\u3040-\u30ff]/

function isMostlyLatin(text: string): boolean {
  const stripped = text.replace(/[\s\p{P}\p{S}]/gu, '')
  if (stripped.length === 0) return false
  let latin = 0
  for (const ch of stripped) if (/[A-Za-z\u00c0-\u024f]/.test(ch)) latin++
  return latin / stripped.length > 0.7
}

/**
 * SPL / enhanced LRC and most bilingual files put the translation on the same timestamp as the
 * original. AMLL keeps those as independent lines; the player wants one line with a translation
 * field, so merge groups of near-identical timestamps.
 */
export function mergeMultilingual(lines: LyricLine[]): LyricLine[] {
  const sorted = [...lines].sort((a, b) => a.startTime - b.startTime || b.words.length - a.words.length)
  const groups: LyricLine[][] = []
  for (const line of sorted) {
    const group = groups[groups.length - 1]
    if (group && Math.abs(group[0]!.startTime - line.startTime) <= 40) group.push(line)
    else groups.push([line])
  }
  const merged: LyricLine[] = []
  for (const group of groups) {
    const primary = group.reduce((a, b) => (b.words.length > a.words.length ? b : a), group[0]!)
    const primaryText = primary.words.map((w) => w.word).join('')
    const others = group.filter((l) => l !== primary)
    const result: LyricLine = {
      words: primary.words,
      translatedLyric: primary.translatedLyric || '',
      romanLyric: primary.romanLyric || '',
      isBG: primary.isBG,
      isDuet: primary.isDuet,
      startTime: primary.startTime,
      endTime: primary.endTime
    }
    for (const other of others) {
      const text = other.words.map((w) => w.word).join('').trim()
      if (!text) continue
      if (!result.translatedLyric) {
        // A Latin line under Japanese is almost always romaji; under Chinese it is almost always
        // an English translation, which is the far more common bilingual-LRC layout.
        if (KANA_RE.test(primaryText) && isMostlyLatin(text)) result.romanLyric = text
        else result.translatedLyric = text
      } else if (!result.romanLyric) {
        result.romanLyric = text
      }
    }
    merged.push(result)
  }
  merged.sort((a, b) => a.startTime - b.startTime)
  return merged
}

/** Fill missing end times from the next line, capped so a long instrumental gap stays readable. */
export function fillEndTimes(lines: LyricLine[], trackDuration: number): LyricLine[] {
  return lines.map((line, i) => {
    const next = lines[i + 1]
    const cap = line.startTime + 15_000
    const end = Math.min(next ? next.startTime : trackDuration * 1000, cap)
    return line.endTime > line.startTime && line.endTime <= end + 1 ? line : { ...line, endTime: Math.max(end, line.startTime + 300) }
  })
}

function syltToLines(synced: { t: number; text: string }[], duration: number): LyricLine[] {
  const lines: LyricLine[] = []
  for (let i = 0; i < synced.length; i++) {
    const cur = synced[i]!
    const next = synced[i + 1]
    const text = cur.text.trim()
    if (!text) continue
    const start = Math.round(cur.t * 1000)
    const end = Math.min(next ? Math.round(next.t * 1000) : start + 8000, start + 15000)
    lines.push({
      words: [{ startTime: start, endTime: end, word: text }],
      translatedLyric: '',
      romanLyric: '',
      isBG: false,
      isDuet: false,
      startTime: start,
      endTime: end
    })
  }
  return fillEndTimes(lines, duration)
}

function plainToLines(text: string): LyricLine[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => ({
      words: [{ startTime: 0, endTime: 0, word: l }],
      translatedLyric: '',
      romanLyric: '',
      isBG: false,
      isDuet: false,
      startTime: 0,
      endTime: 0
    }))
}

export function parseSidecarText(text: string, kind: LyricSourceKind, duration: number): LyricLine[] {
  switch (kind) {
    case 'ttml':
      return fillEndTimes(mergeMultilingual(parseTTML(text).lines), duration)
    case 'lys':
      return fillEndTimes(mergeMultilingual(parseLys(text)), duration)
    case 'yrc':
      return fillEndTimes(mergeMultilingual(parseYrc(text)), duration)
    case 'qrc':
      return fillEndTimes(mergeMultilingual(parseQrc(text)), duration)
    case 'lrc':
    default: {
      if (!/\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/.test(text)) {
        return plainToLines(text)
      }
      const parsed = parseLrcLike(text, { mode: 'spl' })
      const offsetEntry = parsed.metadata.find(([key]) => key.toLowerCase() === 'offset')
      const offsetMs = Number(offsetEntry?.[1]?.[0] ?? 0) || 0
      // AMLL keeps `[offset:]` as metadata and leaves the timestamps alone; the LRC convention is
      // that a positive offset makes the lyrics appear earlier.
      const shifted =
        offsetMs === 0
          ? parsed.lines
          : parsed.lines.map((line) => ({
              ...line,
              startTime: line.startTime - offsetMs,
              endTime: line.endTime - offsetMs,
              words: line.words.map((word) => ({
                ...word,
                startTime: word.startTime - offsetMs,
                endTime: word.endTime - offsetMs
              }))
            }))
      return fillEndTimes(mergeMultilingual(shifted), duration)
    }
  }
}

function toData(lines: LyricLine[]): LyricLineData[] {
  return lines.map((l) => ({
    words: l.words.map((w) => ({ startTime: w.startTime, endTime: w.endTime, word: w.word })),
    translatedLyric: l.translatedLyric,
    romanLyric: l.romanLyric,
    isBG: l.isBG,
    isDuet: l.isDuet,
    startTime: l.startTime,
    endTime: l.endTime
  }))
}

interface CacheEntry {
  payload: LyricsPayload
  stamp: string
}

export class LyricsService {
  private cache = new Map<string, CacheEntry>()

  invalidate(songId?: string): void {
    if (songId) this.cache.delete(songId)
    else this.cache.clear()
  }

  /** Called by the folder watcher when any lyric-ish file changes. */
  invalidateByPath(path: string): void {
    const dir = dirname(path).toLowerCase()
    const base = basename(path, extname(path)).toLowerCase()
    for (const [id, entry] of this.cache) {
      if (entry.payload.filePath && dirname(entry.payload.filePath).toLowerCase() === dir) {
        this.cache.delete(id)
      } else if (entry.payload.filePath) {
        const other = basename(entry.payload.filePath, extname(entry.payload.filePath)).toLowerCase()
        if (other === base) this.cache.delete(id)
      }
    }
  }

  private findSidecar(song: SongMeta): { path: string; kind: LyricSourceKind } | null {
    const base = basename(song.path, extname(song.path))
    const dir = dirname(song.path)
    for (const candidate of SIDECAR_ORDER) {
      const p = join(dir, base + candidate.ext)
      if (existsSync(p)) return { path: p, kind: candidate.kind }
    }
    return null
  }

  private readEmbedded(song: SongMeta): EmbeddedLyrics | null {
    const file = join(lyricsCacheDir(), `${song.id}.json`)
    if (!existsSync(file)) return null
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as EmbeddedLyrics
    } catch {
      return null
    }
  }

  async get(
    song: SongMeta,
    priority: ('sidecar' | 'embedded' | 'text')[],
    autoFallback = true
  ): Promise<LyricsPayload> {
    const sidecar = priority[0] === 'sidecar' ? this.findSidecar(song) : null
    const sidecarStat = sidecar ? await fs.stat(sidecar.path).catch(() => null) : null
    const stamp = lyricsCacheStamp({
      sidecarPath: sidecar?.path ?? null,
      sidecarMtimeMs: sidecarStat?.mtimeMs ?? 0,
      songMtimeMs: song.mtimeMs,
      priority,
      autoFallback
    })
    const cached = this.cache.get(song.id)
    if (cached && cached.stamp === stamp) return cached.payload

    // 自动回退关闭时只尝试第一个来源，取不到就返回空（而不是悄悄换源）
    const effective = effectiveSources(priority, autoFallback)
    const payload = await this.load(song, effective)
    this.cache.set(song.id, { payload, stamp })
    return payload
  }

  private async load(song: SongMeta, priority: ('sidecar' | 'embedded' | 'text')[]): Promise<LyricsPayload> {
    const empty: LyricsPayload = {
      songId: song.id,
      kind: 'none',
      lines: [],
      plain: null,
      source: 'none',
      sourceLabel: '无歌词',
      filePath: null,
      hasTranslation: false,
      hasRoman: false,
      raw: ''
    }

    for (const source of priority) {
      if (source === 'sidecar') {
        const found = this.findSidecar(song)
        if (!found) continue
        const buf = await fs.readFile(found.path)
        const { text } = decodeTextBuffer(buf)
        if (!text.trim()) continue
        const lines = parseSidecarText(text, found.kind, song.durationSec)
        if (lines.length === 0) continue
        const synced = lines.some((l) => l.startTime > 0)
        return {
          songId: song.id,
          kind: synced ? 'synced' : 'plain',
          lines: toData(lines),
          plain: synced ? null : lines.map((l) => l.words.map((w) => w.word).join('')).join('\n'),
          source: found.kind,
          sourceLabel: `同名 ${extname(found.path).slice(1).toUpperCase()}`,
          filePath: found.path,
          hasTranslation: lines.some((l) => l.translatedLyric.length > 0),
          hasRoman: lines.some((l) => l.romanLyric.length > 0),
          raw: text
        }
      } else {
        const embedded = this.readEmbedded(song)
        if (!embedded) continue
        if (embedded.kind === 'sylt' && embedded.synced && embedded.synced.length > 0) {
          const lines = syltToLines(embedded.synced, song.durationSec)
          return {
            songId: song.id,
            kind: 'synced',
            lines: toData(lines),
            plain: null,
            source: 'sylt',
            sourceLabel: '内嵌 SYLT',
            filePath: null,
            hasTranslation: false,
            hasRoman: false,
            raw: embedded.synced.map((s) => s.text).join('\n')
          }
        }
        if (embedded.text) {
          const kind: LyricSourceKind = embedded.kind === 'lrc' ? 'lrc' : 'embedded'
          const lines = embedded.kind === 'lrc' ? parseSidecarText(embedded.text, 'lrc', song.durationSec) : plainToLines(embedded.text)
          const synced = embedded.kind === 'lrc'
          return {
            songId: song.id,
            kind: synced ? 'synced' : 'plain',
            lines: toData(lines),
            plain: synced ? null : embedded.text,
            source: kind,
            sourceLabel: synced ? '内嵌 LRC' : '内嵌纯文本',
            filePath: null,
            hasTranslation: lines.some((l) => l.translatedLyric.length > 0),
            hasRoman: lines.some((l) => l.romanLyric.length > 0),
            raw: embedded.text
          }
        }
      }
    }
    return empty
  }
}
