import { createReadStream, existsSync, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { protocol } from 'electron'
import { join } from 'node:path'
import { coversDir } from './paths'
import type { LibraryService } from './library/scanner'

export const COVER_SCHEME = 'amcover'
export const SONG_SCHEME = 'amsong'

export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: COVER_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        bypassCSP: false
      }
    },
    {
      scheme: SONG_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true
      }
    }
  ])
}

function mimeFor(path: string): string {
  if (path.endsWith('.png')) return 'image/png'
  if (path.endsWith('.webp')) return 'image/webp'
  if (path.endsWith('.gif')) return 'image/gif'
  return 'image/jpeg'
}

export function registerProtocols(library: LibraryService): void {
  protocol.handle(COVER_SCHEME, async (request) => {
    const url = new URL(request.url)
    const parts = url.pathname.split('/').filter(Boolean)
    const id = parts[0] ?? ''
    const size = Number(parts[1] ?? '240')
    if (!/^[a-f0-9]{6,40}$/.test(id) || ![80, 240, 640].includes(size)) {
      return new Response('bad cover request', { status: 400 })
    }
    const file = join(coversDir(), id.slice(0, 2), `${id}_${size}.jpg`)
    if (!existsSync(file)) return new Response('not found', { status: 404 })
    const data = await import('node:fs/promises').then((m) => m.readFile(file))
    return new Response(new Uint8Array(data), {
      status: 200,
      headers: {
        'content-type': mimeFor(file),
        'cache-control': 'max-age=31536000, immutable',
        // The renderer is file:// in production, so every custom-protocol read is cross-origin.
        'access-control-allow-origin': '*'
      }
    })
  })

  protocol.handle(SONG_SCHEME, async (request) => {
    const url = new URL(request.url)
    const id = url.pathname.split('/').filter(Boolean)[0] ?? ''
    const song = library.get(id)
    if (!song) return new Response('not found', { status: 404 })
    if (!existsSync(song.path)) return new Response('missing file', { status: 410 })

    const stat = statSync(song.path)
    const total = stat.size
    const range = request.headers.get('Range') ?? request.headers.get('range')
    const common = {
      'content-type': guessAudioMime(song.path),
      'accept-ranges': 'bytes',
      'cache-control': 'no-cache',
      'access-control-allow-origin': '*',
      'access-control-expose-headers': 'content-range, accept-ranges, content-length'
    }

    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range)
      if (match) {
        const start = match[1] ? Number(match[1]) : 0
        const end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1
        if (Number.isNaN(start) || start >= total || end < start) {
          return new Response('bad range', {
            status: 416,
            headers: { 'content-range': `bytes */${total}` }
          })
        }
        const stream = createReadStream(song.path, { start, end })
        return new Response(Readable.toWeb(stream) as ReadableStream, {
          status: 206,
          headers: {
            ...common,
            'content-length': String(end - start + 1),
            'content-range': `bytes ${start}-${end}/${total}`
          }
        })
      }
    }

    const stream = createReadStream(song.path)
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 200,
      headers: { ...common, 'content-length': String(total) }
    })
  })
}

function guessAudioMime(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  switch (ext) {
    case 'mp3':
      return 'audio/mpeg'
    case 'flac':
      return 'audio/flac'
    case 'm4a':
    case 'aac':
      return 'audio/mp4'
    case 'ogg':
      return 'audio/ogg'
    case 'opus':
      return 'audio/opus'
    case 'wav':
      return 'audio/wav'
    case 'ape':
      return 'audio/x-ape'
    default:
      return 'application/octet-stream'
  }
}
