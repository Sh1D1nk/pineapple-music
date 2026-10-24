import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, extname, basename } from 'node:path'
import { nativeImage } from 'electron'
import { coversDir } from '../paths'

export const COVER_SIZES = [80, 240, 640] as const
export type CoverSize = (typeof COVER_SIZES)[number]

const SIDECAR_NAMES = ['cover', 'folder', 'front', 'albumart', 'album', 'artwork']
const SIDECAR_EXT = ['.jpg', '.jpeg', '.png', '.webp']

export function coverFile(id: string, size: number): string {
  return join(coversDir(), id.slice(0, 2), `${id}_${size}.jpg`)
}

export function coverExists(id: string): boolean {
  return existsSync(coverFile(id, 640)) || existsSync(coverFile(id, 240))
}

/** Writes the three thumbnail sizes and returns the content hash. */
export function storeCover(data: Buffer): { id: string; sizes: number[] } {
  const id = createHash('sha1').update(data).digest('hex').slice(0, 20)
  const sizes: number[] = []
  const dir = join(coversDir(), id.slice(0, 2))
  mkdirSync(dir, { recursive: true })
  const prepared = nativeImage.createFromBuffer(data)
  for (const size of COVER_SIZES) {
    const target = coverFile(id, size)
    if (existsSync(target)) {
      sizes.push(size)
      continue
    }
    if (prepared.isEmpty()) break
    const resized = prepared.resize({ width: size, height: size, quality: 'best' })
    const jpeg = resized.toJPEG(size <= 80 ? 80 : size <= 240 ? 84 : 90)
    writeFileSync(target, jpeg)
    sizes.push(size)
  }
  if (sizes.length === 0 && data.length > 0) {
    // nativeImage could not decode it (e.g. WebP); serve the original bytes for every size.
    for (const size of COVER_SIZES) {
      const target = coverFile(id, size)
      if (!existsSync(target)) writeFileSync(target, data)
      sizes.push(size)
    }
  }
  return { id, sizes }
}

export function findSidecarCover(audioPath: string): string | null {
  const dir = dirname(audioPath)
  const audioBase = basename(audioPath, extname(audioPath)).toLowerCase()
  for (const ext of SIDECAR_EXT) {
    // Same-name art first ("Song.jpg"), then the conventional album names.
    for (const name of [audioBase, ...SIDECAR_NAMES]) {
      const candidate = join(dir, name + ext)
      if (existsSync(candidate)) {
        try {
          if (statSync(candidate).size > 64) return candidate
        } catch {
          /* ignore */
        }
      }
    }
  }
  return null
}

export function readCoverFile(path: string): Buffer | null {
  try {
    return readFileSync(path)
  } catch {
    return null
  }
}
