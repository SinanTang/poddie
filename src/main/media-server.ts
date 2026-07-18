import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { basename, extname } from 'node:path'
import { log, logError } from './logger'

// Electron's protocol.handle cannot serve seekable media: streamed 206 bodies
// die with PIPELINE_ERROR_READ on mid-file seeks, and buffered short-206s stop
// Chromium from issuing follow-up range requests at all (verified 2026-07-05
// with a headless repro). A localhost HTTP server uses Chromium's real HTTP
// stack, where range semantics just work.

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.aac': 'audio/aac'
}

export type ByteRange = { start: number; end: number } | 'unsatisfiable' | null

/** Parse an HTTP Range header against a file size. null → serve the full file. */
export function parseRange(header: string | null, totalBytes: number): ByteRange {
  if (!header) return null
  const m = header.match(/^bytes=(\d*)-(\d*)$/)
  if (!m || (m[1] === '' && m[2] === '')) return null
  if (m[1] === '') {
    // suffix range: last N bytes
    const n = Number(m[2])
    if (n === 0) return 'unsatisfiable'
    return { start: Math.max(0, totalBytes - n), end: totalBytes - 1 }
  }
  const start = Number(m[1])
  const end = m[2] === '' ? totalBytes - 1 : Math.min(Number(m[2]), totalBytes - 1)
  if (start >= totalBytes || start > end) return 'unsatisfiable'
  return { start, end }
}

export interface MediaServer {
  /** Prefix media URLs with this: `${baseUrl}/${encodeURIComponent(absPath)}` */
  baseUrl: string
  close(): void
}

/**
 * Loopback-only media file server. URLs carry a per-session random token so no
 * other local process can read files through it.
 */
export function startMediaServer(): Promise<MediaServer> {
  const token = randomBytes(16).toString('hex')

  async function serve(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const [, reqToken, encodedPath] = url.pathname.split('/')
    if (reqToken !== token || !encodedPath) {
      res.writeHead(403).end()
      return
    }
    const filePath = decodeURIComponent(encodedPath)
    const s = await stat(filePath).catch(() => null)
    if (!s?.isFile()) {
      log('warn', 'media', `404 ${filePath}`)
      res.writeHead(404).end()
      return
    }

    const range = parseRange(req.headers.range ?? null, s.size)
    if (range === 'unsatisfiable') {
      log('warn', 'media', `416 "${req.headers.range}" ${basename(filePath)}`)
      res.writeHead(416, { 'Content-Range': `bytes */${s.size}` }).end()
      return
    }

    const { start, end } = range ?? { start: 0, end: s.size - 1 }
    res.writeHead(range ? 206 : 200, {
      'Content-Type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${s.size}` } : {})
    })
    log('info', 'media', `${range ? 206 : 200} ${req.headers.range ?? 'full'} ${basename(filePath)}`)
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    const stream = createReadStream(filePath, { start, end })
    stream.pipe(res)
    stream.on('error', (err) => {
      logError('media', err)
      res.destroy(err)
    })
    // client aborts (constant during seeking) must release the file handle
    res.on('close', () => stream.destroy())
  }

  const server = http.createServer((req, res) => {
    serve(req, res).catch((err) => {
      logError('media', err)
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })

  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      const baseUrl = `http://127.0.0.1:${port}/${token}`
      log('info', 'media', `media server on ${baseUrl}`)
      resolve({ baseUrl, close: () => server.close() })
    })
  })
}
