import chardet from 'chardet'
import iconv from 'iconv-lite'

/**
 * Repair tags that were written as raw CJK bytes but declared as ISO-8859-1 (very common with
 * Chinese rips: an ID3v2.3 frame saying "latin1" while the bytes are GBK). The reader decodes the
 * bytes one-to-one into U+0000..U+00FF, which is lossless — so we can rebuild the byte string and
 * decode it again with the right code page.
 */

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/

export function looksLikeMojibake(input: string): boolean {
  if (!input) return false
  let high = 0
  let chars = 0
  for (const ch of input) {
    const cp = ch.codePointAt(0)!
    if (cp === 0x09 || cp === 0x0a || cp === 0x0d) continue
    chars++
    if (cp > 0xff) return false
    if (cp >= 0x80) high++
  }
  if (chars === 0) return false
  // "Ã¤", "ºÃ" style: a lot of Latin-1 supplement characters and no plain ASCII-heavy text.
  return high >= 2 && high / chars >= 0.25
}

function latin1Bytes(text: string): Buffer {
  const out = Buffer.allocUnsafe(text.length)
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff
  return out
}

function cjkRatio(text: string): number {
  let cjk = 0
  let visible = 0
  for (const ch of text) {
    if (/\s/.test(ch)) continue
    visible++
    if (CJK.test(ch)) cjk++
  }
  return visible === 0 ? 0 : cjk / visible
}

function acceptable(text: string): boolean {
  if (!text || text.includes('\ufffd')) return false
  if (text.includes('\u0000')) return false
  // Reject strings that stayed in the C1 control block or are mostly punctuation noise.
  if (/[\u0080-\u009f]/.test(text)) return false
  return cjkRatio(text) >= 0.25
}

/**
 * Returns a repaired string, or the original when no candidate decodes cleanly.
 * `rawBytes` short-circuits the Latin-1 round trip when the caller already has the bytes.
 */
export function repairMojibake(input: string, rawBytes?: Buffer): string {
  if (!input) return input
  if (!looksLikeMojibake(input)) return input

  const bytes = rawBytes ?? latin1Bytes(input)
  const detected = chardet.detect(bytes)
  const candidates: string[] = []
  if (detected) candidates.push(detected)
  candidates.push('GB18030', 'Big5', 'Shift_JIS', 'EUC-JP', 'EUC-KR', 'windows-1252')

  for (const enc of candidates) {
    if (!iconv.encodingExists(enc)) continue
    let decoded: string
    try {
      decoded = iconv.decode(bytes, enc)
    } catch {
      continue
    }
    if (acceptable(decoded)) return decoded.normalize('NFC')
  }
  return input
}

/** Decode a buffer that may hold UTF-8, UTF-16 or a legacy CJK code page. */
export function decodeTextBuffer(buf: Buffer): { text: string; encoding: string } {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8-bom' }
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: iconv.decode(buf.subarray(2), 'utf-16le'), encoding: 'utf-16le' }
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: iconv.decode(buf.subarray(2), 'utf-16be'), encoding: 'utf-16be' }
  }
  // Strict UTF-8 first: if it validates, it is UTF-8 beyond reasonable doubt.
  const asUtf8 = buf.toString('utf8')
  if (!asUtf8.includes('\ufffd')) {
    const ratio = cjkRatio(asUtf8)
    if (ratio > 0 || !/[\u0080-\u00ff]/.test(asUtf8)) return { text: asUtf8, encoding: 'utf-8' }
  }
  const detected = chardet.detect(buf)
  const order = [detected, 'GB18030', 'Big5', 'Shift_JIS', 'UTF-16LE'].filter(Boolean) as string[]
  for (const enc of order) {
    if (!iconv.encodingExists(enc)) continue
    try {
      const text = iconv.decode(buf, enc)
      if (acceptable(text)) return { text, encoding: enc }
    } catch {
      /* keep trying */
    }
  }
  return { text: asUtf8, encoding: 'utf-8' }
}
