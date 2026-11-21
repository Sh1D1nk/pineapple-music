import type { LyricsPayload } from '@shared/types'

/**
 * 「这首歌没有真正可唱的歌词」的统一判断。
 *
 * 除了空载荷，还要识别纯音乐占位（"纯音乐，请欣赏" / "Instrumental" 之类）：
 * 它们常常作为一行普通歌词存在于 LRC 里，只按行数判断会得到「有歌词」，
 * 界面上就会出现一行居中的提示语 —— 那正是要避免的样子。
 */
const MARKER = /(纯音乐|请欣赏|没有填词|无歌词|暂无歌词|instrumental|no\s*lyrics|music\s*only)/i

function normalize(text: string): string {
  return text.replace(/[\s，,。.、！!？?：:；;~～\-—（）()]/g, '')
}

export function isInstrumentalTexts(texts: string[]): boolean {
  const meaningful = texts.map((text) => text.trim()).filter(Boolean)
  if (meaningful.length === 0) return true
  if (meaningful.length <= 3 && meaningful.every((text) => MARKER.test(normalize(text)))) return true
  return false
}

export function hasRealLyrics(lines: { words: { word: string }[] }[]): boolean {
  return !isInstrumentalTexts(lines.map((line) => line.words.map((word) => word.word).join('')))
}

export function payloadHasLyrics(payload: LyricsPayload | null | undefined): boolean {
  if (!payload) return false
  if (payload.kind === 'plain') {
    const text = payload.plain?.trim() ?? ''
    return text.length > 0 && !MARKER.test(normalize(text.slice(0, 60)))
  }
  if (payload.kind === 'synced') return hasRealLyrics(payload.lines)
  return false
}
