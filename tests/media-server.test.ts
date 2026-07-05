import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseRange, startMediaServer, type MediaServer } from '../src/main/media-server'

const tmp = fileURLToPath(new URL('.tmp-server', import.meta.url))
const file = join(tmp, 'clip.mp4')
const CONTENT = '0123456789ABCDEF' // 16 bytes, position == recognizable char

let server: MediaServer
const urlFor = (p: string): string => `${server.baseUrl}/${encodeURIComponent(p)}`

beforeAll(async () => {
  await rm(tmp, { recursive: true, force: true })
  await mkdir(tmp, { recursive: true })
  await writeFile(file, CONTENT)
  server = await startMediaServer()
})

afterAll(() => server.close())

describe('parseRange', () => {
  test('no header → full file', () => {
    expect(parseRange(null, 16)).toBeNull()
  })

  test('open-ended, bounded, and suffix ranges', () => {
    expect(parseRange('bytes=4-', 16)).toEqual({ start: 4, end: 15 })
    expect(parseRange('bytes=4-9', 16)).toEqual({ start: 4, end: 9 })
    expect(parseRange('bytes=4-999', 16)).toEqual({ start: 4, end: 15 }) // clamped
    expect(parseRange('bytes=-4', 16)).toEqual({ start: 12, end: 15 })
  })

  test('start beyond EOF is unsatisfiable; malformed → full file', () => {
    expect(parseRange('bytes=16-', 16)).toBe('unsatisfiable')
    expect(parseRange('bytes=abc', 16)).toBeNull()
  })
})

describe('media server over real HTTP', () => {
  test('full request → 200 with Accept-Ranges advertised', async () => {
    const res = await fetch(urlFor(file))
    expect(res.status).toBe(200)
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('content-type')).toBe('video/mp4')
    expect(await res.text()).toBe(CONTENT)
  })

  test('range request → 206 with the exact byte slice (seek support)', async () => {
    const res = await fetch(urlFor(file), { headers: { Range: 'bytes=4-9' } })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 4-9/16')
    expect(res.headers.get('content-length')).toBe('6')
    expect(await res.text()).toBe('456789')
  })

  test('open-ended range from a mid-file offset (what Chromium sends on seek)', async () => {
    const res = await fetch(urlFor(file), { headers: { Range: 'bytes=10-' } })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 10-15/16')
    expect(await res.text()).toBe('ABCDEF')
  })

  test('multi-megabyte slice is byte-exact', async () => {
    const big = join(tmp, 'big.mp4')
    const pattern = Buffer.alloc(3 * 1024 * 1024)
    for (let i = 0; i < pattern.length; i++) pattern[i] = i % 251
    await writeFile(big, pattern)

    const start = 500_000
    const end = 2_700_000
    const res = await fetch(urlFor(big), { headers: { Range: `bytes=${start}-${end}` } })
    expect(res.status).toBe(206)
    const body = Buffer.from(await res.arrayBuffer())
    expect(body.length).toBe(end - start + 1)
    expect(body.equals(pattern.subarray(start, end + 1))).toBe(true)
  })

  test('unsatisfiable range → 416', async () => {
    const res = await fetch(urlFor(file), { headers: { Range: 'bytes=99-' } })
    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe('bytes */16')
  })

  test('missing file → 404', async () => {
    expect((await fetch(urlFor(join(tmp, 'nope.mp4')))).status).toBe(404)
  })

  test('wrong or missing token → 403 (no local-process file oracle)', async () => {
    const origin = new URL(server.baseUrl).origin
    expect((await fetch(`${origin}/wrongtoken/${encodeURIComponent(file)}`)).status).toBe(403)
    expect((await fetch(`${origin}/`)).status).toBe(403)
  })
})
