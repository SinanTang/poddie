import { beforeAll, describe, expect, test } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computePeaks, ensurePreviewProxy, extractAudio, ffprobeJson, probeMedia } from '../src/main/media'
import { runTool } from '../src/main/ffmpeg'

const tmp = fileURLToPath(new URL('.tmp', import.meta.url))
const sample = join(tmp, 'sample.mp4')

beforeAll(async () => {
  await rm(tmp, { recursive: true, force: true })
  await mkdir(tmp, { recursive: true })
  // 2 s of color bars + 440 Hz sine — a real H.264/AAC file, no fixture to check in
  await runTool('ffmpeg', [
    '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=2:size=640x360:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-shortest',
    sample
  ])
}, 30_000)

describe('probeMedia', () => {
  test('reads metadata from an H.264/AAC file', async () => {
    const info = await probeMedia(sample)
    expect(info.durationSec).toBeGreaterThan(1.8)
    expect(info.durationSec).toBeLessThan(2.3)
    expect(info.hasVideo).toBe(true)
    expect(info.width).toBe(640)
    expect(info.height).toBe(360)
    expect(info.fps).toBeCloseTo(30, 1)
    expect(info.videoCodec).toBe('h264')
    expect(info.audioCodec).toBe('aac')
    expect(info.needsProxy).toBe(false)
    expect(info.sizeBytes).toBeGreaterThan(0)
  })

  test('reports display dimensions for rotated (iPhone-style) video', async () => {
    const rotated = join(tmp, 'rotated.mp4')
    await runTool('ffmpeg', ['-y', '-display_rotation', '-90', '-i', sample, '-c', 'copy', rotated])
    const info = await probeMedia(rotated)
    // coded 640x360 + 90° rotation flag → displays as 360x640
    expect(info.width).toBe(360)
    expect(info.height).toBe(640)
  })

  test('audio-only file (aac): hasVideo false, playable without proxy', async () => {
    const audioOnly = join(tmp, 'audio-only.m4a')
    await runTool('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'aac', audioOnly])
    const info = await probeMedia(audioOnly)
    expect(info.hasVideo).toBe(false)
    expect(info.videoCodec).toBeNull()
    expect(info.width).toBe(0)
    expect(info.audioCodec).toBe('aac')
    expect(info.needsProxy).toBe(false)
    expect(info.durationSec).toBeGreaterThan(0.8)
  })

  test('audio-only ALAC needs a proxy (Chromium cannot play it)', async () => {
    const alac = join(tmp, 'audio-alac.m4a')
    await runTool('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'alac', alac])
    const info = await probeMedia(alac)
    expect(info.hasVideo).toBe(false)
    expect(info.audioCodec).toBe('alac')
    expect(info.needsProxy).toBe(true)
  })

  test('rejects a file with no media streams at all', async () => {
    const bogus = join(tmp, 'not-media.txt')
    await writeFile(bogus, 'plain text')
    await expect(probeMedia(bogus)).rejects.toThrow()
  })
})

describe('extractAudio', () => {
  test('produces mono 16 kHz m4a suitable for Whisper', async () => {
    const cacheDir = join(tmp, 'cache')
    const result = await extractAudio(sample, cacheDir)
    expect(result.audioPath).toMatch(/\.m4a$/)
    expect(result.sizeBytes).toBeGreaterThan(0)

    const probe = await ffprobeJson(result.audioPath)
    const audio = probe.streams?.find((s) => s.codec_type === 'audio')
    expect(audio?.channels).toBe(1)
    expect(audio?.sample_rate).toBe('16000')
  })

  test('returns the cached file on a second call', async () => {
    const cacheDir = join(tmp, 'cache')
    const first = await extractAudio(sample, cacheDir)
    const second = await extractAudio(sample, cacheDir)
    expect(second.audioPath).toBe(first.audioPath)
    expect(second.sizeBytes).toBe(first.sizeBytes)
  })
})

describe('computePeaks', () => {
  test('produces normalized non-silent peaks for a sine wave', async () => {
    const cacheDir = join(tmp, 'cache')
    const { audioPath } = await extractAudio(sample, cacheDir)
    const result = await computePeaks(audioPath)
    expect(result.duration).toBeGreaterThan(1.8)
    expect(result.duration).toBeLessThan(2.3)
    expect(result.peaks.length).toBeGreaterThan(100)
    const max = Math.max(...result.peaks)
    expect(max).toBeGreaterThan(0.1) // sine is audible
    expect(max).toBeLessThanOrEqual(1)
  })

  test('stale cache (old version / no version marker) is recomputed, then reused', async () => {
    const cacheDir = join(tmp, 'cache')
    const { audioPath } = await extractAudio(sample, cacheDir)
    const peaksPath = `${audioPath}.peaks.json`
    await writeFile(peaksPath, JSON.stringify({ peaks: [0.5], duration: 999 })) // pre-versioning shape
    const recomputed = await computePeaks(audioPath)
    expect(recomputed.duration).toBeLessThan(3)
    expect(recomputed.peaks.length).toBeGreaterThan(100)

    const cached = await computePeaks(audioPath)
    expect(cached).toEqual(recomputed)
  })
})

describe('ensurePreviewProxy', () => {
  test('re-encodes an HEVC source to a playable H.264 proxy', async () => {
    const hevcSample = join(tmp, 'sample-hevc.mp4')
    await runTool('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x640:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1',
      '-c:a', 'aac',
      '-shortest',
      hevcSample
    ])
    expect((await probeMedia(hevcSample)).needsProxy).toBe(true)

    const fractions: number[] = []
    const { proxyPath } = await ensurePreviewProxy(hevcSample, join(tmp, 'cache'), (f) => fractions.push(f))
    const proxyInfo = await probeMedia(proxyPath)
    expect(proxyInfo.videoCodec).toBe('h264')
    expect(proxyInfo.needsProxy).toBe(false)
    expect(proxyInfo.height).toBeLessThanOrEqual(540)

    // cached second call: same path, no new progress events
    const before = fractions.length
    const again = await ensurePreviewProxy(hevcSample, join(tmp, 'cache'), (f) => fractions.push(f))
    expect(again.proxyPath).toBe(proxyPath)
    expect(fractions.length).toBe(before)
  }, 60_000)

  test('audio-only ALAC source gets an AAC m4a proxy', async () => {
    const alac = join(tmp, 'proxy-alac.m4a')
    await runTool('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'alac', alac])

    const { proxyPath } = await ensurePreviewProxy(alac, join(tmp, 'cache'), () => {})
    expect(proxyPath).toMatch(/\.proxy\.m4a$/)
    const info = await probeMedia(proxyPath)
    expect(info.hasVideo).toBe(false)
    expect(info.audioCodec).toBe('aac')
    expect(info.needsProxy).toBe(false)
  }, 30_000)
})
