import { beforeAll, describe, expect, test } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractAudio, ffprobeJson, probeVideo } from '../src/main/media'
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

describe('probeVideo', () => {
  test('reads metadata from an H.264/AAC file', async () => {
    const info = await probeVideo(sample)
    expect(info.durationSec).toBeGreaterThan(1.8)
    expect(info.durationSec).toBeLessThan(2.3)
    expect(info.width).toBe(640)
    expect(info.height).toBe(360)
    expect(info.fps).toBeCloseTo(30, 1)
    expect(info.videoCodec).toBe('h264')
    expect(info.audioCodec).toBe('aac')
    expect(info.needsProxy).toBe(false)
    expect(info.sizeBytes).toBeGreaterThan(0)
  })

  test('rejects a file with no video stream', async () => {
    const audioOnly = join(tmp, 'audio-only.m4a')
    await runTool('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'aac', audioOnly])
    await expect(probeVideo(audioOnly)).rejects.toThrow(/no video stream/i)
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
