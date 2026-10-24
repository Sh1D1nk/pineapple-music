import { parseFile, type IAudioMetadata } from 'music-metadata'
import { repairMojibake } from './encoding'
import type { Credits } from '@shared/types'

export interface EmbeddedLyrics {
  kind: 'sylt' | 'lrc' | 'text'
  text: string | null
  synced: { t: number; text: string }[] | null
}

export interface CoverImage {
  data: Buffer
  mime: string
  type: string | null
}

export interface RawTags {
  title: string | null
  artists: string[]
  albumArtist: string | null
  album: string | null
  trackNo: number | null
  trackTotal: number | null
  discNo: number | null
  discTotal: number | null
  year: number | null
  genre: string | null
  bpm: number | null
  durationSec: number
  bitrate: number | null
  sampleRate: number | null
  bitDepth: number | null
  channels: number | null
  codec: string
  container: string
  credits: Credits
  replayGainTrackGain: number | null
  replayGainTrackPeak: number | null
  replayGainAlbumGain: number | null
  covers: CoverImage[]
  lyrics: EmbeddedLyrics | null
  hasEmbeddedLyrics: boolean
}

const str = (v: unknown): string | null => {
  if (typeof v === 'string') return v.trim() || null
  if (typeof v === 'number') return String(v)
  return null
}

/** Collect every string inside an unknown native tag value (arrays, `{text}`, `{name}` shapes). */
function strings(v: unknown): string[] {
  if (v == null) return []
  if (typeof v === 'string') return v.trim() ? [v.trim()] : []
  if (typeof v === 'number') return [String(v)]
  if (Array.isArray(v)) return v.flatMap(strings)
  if (typeof v === 'object') {
    const rec = v as Record<string, unknown>
    for (const key of ['text', 'value', 'name', 'description']) {
      if (typeof rec[key] === 'string') return strings(rec[key])
    }
    return Object.values(rec).flatMap(strings)
  }
  return []
}

function splitList(v: unknown): string[] {
  return strings(v)
    .flatMap((s) => s.split(/\s*[;/]\s*|\s*,\s*(?=[^)]*$)/))
    .map((s) => s.trim())
    .filter(Boolean)
}

type NativeTag = { id: string; value: unknown }

function nativeTags(md: IAudioMetadata, keys: string[]): NativeTag[] {
  const native = md.native as unknown as Record<string, NativeTag[] | undefined>
  const out: NativeTag[] = []
  for (const key of keys) {
    const tags = native[key]
    if (Array.isArray(tags)) out.push(...tags)
  }
  return out
}

const ROLE_ALIASES: Record<string, keyof Credits> = {
  composer: 'composer',
  作曲: 'composer',
  lyricist: 'lyricist',
  'lyrics by': 'lyricist',
  作词: 'lyricist',
  arranger: 'arranger',
  arrangement: 'arranger',
  编曲: 'arranger',
  producer: 'producer',
  'produced by': 'producer',
  制作人: 'producer',
  监制: 'producer',
  mixer: 'mixer',
  mix: 'mixer',
  'mixed by': 'mixer',
  混音: 'mixer',
  mastering: 'mastering',
  'mastered by': 'mastering',
  'mastering engineer': 'mastering',
  母带: 'mastering',
  母带处理: 'mastering',
  engineer: 'engineer',
  'recording engineer': 'engineer',
  录音: 'engineer',
  录音师: 'engineer',
  performer: 'performer',
  vocal: 'performer',
  vocals: 'performer',
  演唱: 'performer'
}

function pushRole(credits: Credits, role: string | null, names: string[]): void {
  if (!role) {
    credits.performer.push(...names)
    return
  }
  const key = ROLE_ALIASES[role.trim().toLowerCase()] ?? ROLE_ALIASES[role.trim()]
  if (!key) {
    credits.performer.push(...names)
    return
  }
  for (const n of names) if (!credits[key].includes(n)) credits[key].push(n)
}

/**
 * TIPL / IPLS / TMCL. music-metadata already folds these into a role → names object; a raw pair
 * list (role, name, role, name) is still handled in case a writer emits it verbatim.
 */
function readRolePairs(value: unknown): { role: string | null; name: string }[] {
  if (Array.isArray(value)) {
    const flat = value.flatMap((v) => (typeof v === 'string' ? [v] : strings(v)))
    const out: { role: string | null; name: string }[] = []
    for (let i = 0; i + 1 < flat.length; i += 2) {
      out.push({ role: flat[i] ?? null, name: flat[i + 1]! })
    }
    if (out.length === 0 && flat.length === 1) out.push({ role: null, name: flat[0]! })
    return out
  }
  if (value && typeof value === 'object') {
    const out: { role: string | null; name: string }[] = []
    for (const [role, names] of Object.entries(value as Record<string, unknown>)) {
      for (const name of strings(names)) out.push({ role, name })
    }
    return out
  }
  return strings(value).map((name) => ({ role: null, name }))
}

function emptyCredits(): Credits {
  return {
    composer: [],
    lyricist: [],
    arranger: [],
    producer: [],
    mixer: [],
    mastering: [],
    engineer: [],
    performer: []
  }
}

function decodeField(value: string | null | undefined): string | null {
  if (!value) return null
  const repaired = repairMojibake(value)
  return repaired.trim() || null
}

const LRC_TIMESTAMP = /\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/

/**
 * Embedded lyrics, with the raw text preferred over music-metadata's own LRC split: AMLL parses
 * `[offset:]`, per-word timestamps and bilingual pairs, which the generic split does not.
 */
export function extractEmbeddedLyrics(md: IAudioMetadata): EmbeddedLyrics | null {
  const common = md.common as unknown as Record<string, unknown>
  const raw = common.lyrics
  const list = raw ? (Array.isArray(raw) ? raw : [raw]) : []

  let sylt: { t: number; text: string }[] = []
  let syncedFromText: { t: number; text: string }[] = []
  let plain: string | null = null

  for (const item of list) {
    if (typeof item === 'string') {
      plain = plain && plain.length > item.length ? plain : item
      continue
    }
    const rec = item as Record<string, unknown>
    const syncText = rec.syncText
    if (Array.isArray(syncText) && syncText.length > 0) {
      const parsed = syncText
        .map((s) => {
          const srec = s as Record<string, unknown>
          const text = str(srec.text) ?? ''
          const t = typeof srec.timestamp === 'number' ? srec.timestamp : null
          return t != null ? { t: t / 1000, text } : null
        })
        .filter((v): v is { t: number; text: string } => v !== null)
      if (parsed.length > syncedFromText.length) syncedFromText = parsed
    }
    const text = str(rec.text) ?? str(rec.lyrics)
    if (text && (!plain || text.length > plain.length)) plain = text
  }

  // A real SYLT frame carries its own timings; music-metadata exposes it under the SYLT id.
  const nativeAudio = md.native as unknown as Record<string, NativeTag[] | undefined>
  for (const key of ['ID3v2.4', 'ID3v2.3']) {
    for (const tag of nativeAudio[key] ?? []) {
      if (tag.id !== 'SYLT') continue
      const rec = tag.value as Record<string, unknown>
      const entries = rec.syncText ?? rec.SynchronisedText ?? rec.syncLyrics
      if (Array.isArray(entries)) {
        const parsed = entries
          .map((entry) => {
            const erec = entry as Record<string, unknown>
            const text = str(erec.text) ?? ''
            const ts = typeof erec.timestamp === 'number' ? erec.timestamp : null
            return ts != null ? { t: ts / 1000, text } : null
          })
          .filter((v): v is { t: number; text: string } => v !== null)
        if (parsed.length > 0) sylt = parsed
      }
    }
  }

  // Raw lyric text straight from the container. music-metadata strips LRC timestamps when it
  // produces syncText, so the untouched string is what AMLL's parser needs.
  const candidates: string[] = plain ? [plain] : []
  for (const key of ['vorbis', 'iTunes', 'APEv2', 'ID3v2.3', 'ID3v2.4']) {
    for (const tag of nativeAudio[key] ?? []) {
      const id = tag.id.toUpperCase()
      if (id === 'LYRICS' || id === 'UNSYNCEDLYRICS' || id === 'LYRIC' || id === 'USLT' || tag.id === '\u00a9lyr') {
        const values = strings(tag.value)
        if (values.length > 0) candidates.push(values.join('\n'))
      }
    }
  }
  const withTimestamps = candidates.find((text) => LRC_TIMESTAMP.test(text))
  if (withTimestamps) plain = withTimestamps
  else if (candidates.length > 0) plain = candidates.sort((a, b) => b.length - a.length)[0] ?? plain

  if (plain && LRC_TIMESTAMP.test(plain)) {
    return { kind: 'lrc', text: repairMojibake(plain), synced: null }
  }
  if (sylt.length > 0) {
    sylt.sort((a, b) => a.t - b.t)
    return { kind: 'sylt', synced: sylt, text: null }
  }
  if (syncedFromText.length > 0) {
    syncedFromText.sort((a, b) => a.t - b.t)
    return { kind: 'sylt', synced: syncedFromText, text: null }
  }
  if (plain) {
    return { kind: 'text', text: repairMojibake(plain), synced: null }
  }
  return null
}

function pickCover(md: IAudioMetadata): CoverImage[] {
  const pics = md.common.picture ?? []
  if (pics.length === 0) return []
  const front = pics.find((p) => (p.type ?? '').toLowerCase().includes('front'))
  const ordered = front ? [front, ...pics.filter((p) => p !== front)] : pics
  return ordered.slice(0, 2).map((p) => ({
    data: Buffer.from(p.data),
    mime: p.format || 'image/jpeg',
    type: p.type ?? null
  }))
}

function parseFilename(file: string): { title: string | null; artist: string | null } {
  const base = file.split(/[\\/]/).pop() ?? ''
  const noExt = base.replace(/\.[a-z0-9]+$/i, '')
  const cleaned = noExt.replace(/^\s*\d{1,3}[\s._-]+/, '').trim()
  const m = cleaned.match(/^(.{1,80}?)\s+[-–—]\s+(.{1,120})$/)
  if (m) return { artist: m[1]!.trim(), title: m[2]!.trim() }
  return { title: cleaned || null, artist: null }
}

export function parseFileTitle(file: string): { title: string | null; artist: string | null } {
  return parseFilename(file)
}

export async function readTags(file: string): Promise<RawTags> {
  const md = await parseFile(file, { duration: true, skipCovers: false })
  const common = md.common
  const format = md.format

  const credits = emptyCredits()
  const nativeAll = nativeTags(md, ['ID3v2.2', 'ID3v2.3', 'ID3v2.4', 'vorbis', 'iTunes', 'APEv2'])

  // ---- ID3: TIPL / IPLS / TMCL carry role→name pairs.
  for (const tag of nativeAll) {
    if (tag.id === 'TIPL' || tag.id === 'IPLS' || tag.id === 'TMCL') {
      for (const pair of readRolePairs(tag.value)) pushRole(credits, pair.role, [pair.name])
    }
    if (tag.id === 'TXXX' || tag.id.startsWith('----')) {
      const rec = tag.value as Record<string, unknown> | undefined
      if (rec && typeof rec === 'object' && typeof rec.description === 'string') {
        const desc = rec.description.replace(/^com\.apple\.iTunes:/i, '')
        const values = strings(rec.value ?? rec.text)
        if (values.length > 0) pushRole(credits, desc, values)
      }
    }
  }

  // ---- Common fields cover Vorbis COMPOSER/LYRICIST/... and MP4 ©wrt and iTunes ---- free fields.
  const commonCredits: [keyof Credits, unknown][] = [
    ['composer', common.composer],
    ['lyricist', common.lyricist],
    ['arranger', common.arranger],
    ['producer', common.producer],
    ['mixer', common.mixer],
    ['engineer', common.engineer]
  ]
  for (const [role, value] of commonCredits) {
    for (const name of splitList(value)) {
      if (!credits[role].includes(name)) credits[role].push(name)
    }
  }

  // ---- ReplayGain: kept in native tags by most writers.
  let rgTrack: number | null = null
  let rgAlbum: number | null = null
  let rgPeak: number | null = null
  for (const tag of nativeAll) {
    const id = tag.id.toUpperCase()
    if (id.includes('REPLAYGAIN_TRACK_GAIN')) rgTrack = parseGain(strings(tag.value)[0])
    else if (id.includes('REPLAYGAIN_ALBUM_GAIN')) rgAlbum = parseGain(strings(tag.value)[0])
    else if (id.includes('REPLAYGAIN_TRACK_PEAK')) {
      const v = Number.parseFloat(strings(tag.value)[0] ?? '')
      if (Number.isFinite(v)) rgPeak = v
    }
  }
  const formatRec = format as unknown as Record<string, unknown>
  if (rgTrack == null && typeof formatRec.trackGain === 'number') rgTrack = formatRec.trackGain
  if (rgAlbum == null && typeof formatRec.albumGain === 'number') rgAlbum = formatRec.albumGain
  if (rgPeak == null && typeof formatRec.trackPeakLevel === 'number') rgPeak = formatRec.trackPeakLevel

  const filename = parseFilename(file)
  const artists = (common.artists ?? (common.artist ? [common.artist] : []))
    .map((a) => decodeField(a))
    .filter((a): a is string => Boolean(a))
  const albumArtist = decodeField(common.albumartist)
  const title = decodeField(common.title) ?? filename.title
  const album = decodeField(common.album)

  const lyrics = extractEmbeddedLyrics(md)
  const year =
    common.year ??
    (common.date ? Number.parseInt(common.date.slice(0, 4), 10) || null : null)

  return {
    title,
    artists: artists.length > 0 ? artists : filename.artist ? [filename.artist] : [],
    albumArtist,
    album,
    trackNo: common.track?.no ?? null,
    trackTotal: common.track?.of ?? null,
    discNo: common.disk?.no ?? null,
    discTotal: common.disk?.of ?? null,
    year: Number.isFinite(year ?? NaN) ? year : null,
    genre: decodeField(common.genre?.[0]),
    bpm: typeof common.bpm === 'number' && common.bpm > 0 ? Math.round(common.bpm) : null,
    durationSec: format.duration ?? 0,
    bitrate: format.bitrate ? Math.round(format.bitrate) : null,
    sampleRate: format.sampleRate ?? null,
    bitDepth: format.bitsPerSample ?? null,
    channels: format.numberOfChannels ?? null,
    codec: format.codec ?? format.container ?? 'unknown',
    container: format.container ?? 'unknown',
    credits,
    replayGainTrackGain: rgTrack,
    replayGainTrackPeak: rgPeak,
    replayGainAlbumGain: rgAlbum,
    covers: pickCover(md),
    lyrics,
    hasEmbeddedLyrics: lyrics != null
  }
}

function parseGain(value: string | undefined): number | null {
  if (!value) return null
  const m = value.match(/-?\d+(\.\d+)?/)
  if (!m) return null
  const v = Number.parseFloat(m[0])
  return Number.isFinite(v) ? v : null
}
