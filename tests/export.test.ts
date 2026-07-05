import { beforeAll, describe, expect, test } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFile } from 'node:fs/promises'
import { buildExportArgs, exportMedia } from '../src/main/export'
import { ffprobeJson } from '../src/main/media'
import { hasFilter, runTool } from '../src/main/ffmpeg'

const tmp = fileURLToPath(new URL('.tmp-export', import.meta.url))
const sample = join(tmp, 'source.mp4')

beforeAll(async () => {
  await rm(tmp, { recursive: true, force: true })
  await mkdir(tmp, { recursive: true })
  // 10 s color bars + 440 Hz sine, H.264/AAC
  await runTool('ffmpeg', [
    '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=10:size=640x360:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-shortest',
    sample
  ])
}, 60_000)

describe('buildExportArgs', () => {
  const ranges = [
    { start: 1, end: 2 },
    { start: 4, end: 5.5 }
  ]

  test('single range uses plain input seeking, no filter graph', () => {
    const args = buildExportArgs('in.mov', [{ start: 1, end: 3 }], 'out.mp4', 'mp4', true, 'libx264')
    expect(args).toContain('-ss')
    expect(args).toContain('1.000')
    expect(args).toContain('-t')
    expect(args).toContain('2.000')
    expect(args.join(' ')).not.toContain('filter_complex')
  })

  test('multi-range builds trim/atrim + concat graph', () => {
    const args = buildExportArgs('in.mov', ranges, 'out.mp4', 'mp4', true)
    const graph = args[args.indexOf('-filter_complex') + 1]
    expect(graph).toContain('[0:v]trim=start=1.000:end=2.000,setpts=PTS-STARTPTS[v0]')
    expect(graph).toContain('[0:a]atrim=start=4.000:end=5.500,asetpts=PTS-STARTPTS[a1]')
    expect(graph).toContain('[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]')
    expect(args).toContain('h264_videotoolbox')
  })

  test('audio-less source builds a video-only graph', () => {
    const args = buildExportArgs('in.mov', ranges, 'out.mp4', 'mp4', false, 'libx264')
    const graph = args[args.indexOf('-filter_complex') + 1]
    expect(graph).not.toContain('atrim')
    expect(graph).toContain('concat=n=2:v=1:a=0[v]')
    expect(args.join(' ')).not.toContain('-c:a')
  })

  test('audio-only m4a: atrim-only graph, no video encode, faststart kept', () => {
    const args = buildExportArgs('in.mov', ranges, 'out.m4a', 'm4a', true)
    const graph = args[args.indexOf('-filter_complex') + 1]
    expect(graph).not.toContain('[0:v]') // no video trim chains…
    expect(graph).toContain('atrim=start') // …only audio ones
    expect(graph).toContain('[a0][a1]concat=n=2:v=0:a=1[a]')
    expect(args).toContain('-vn')
    expect(args.join(' ')).not.toContain('-c:v')
    expect(args.join(' ')).toContain('-c:a aac')
    expect(args).toContain('+faststart')
  })

  test('audio-only mp3 uses libmp3lame and no mp4 flags', () => {
    const args = buildExportArgs('in.mov', [{ start: 1, end: 3 }], 'out.mp3', 'mp3', true)
    expect(args.join(' ')).toContain('-c:a libmp3lame')
    expect(args.join(' ')).not.toContain('faststart')
    expect(args).toContain('-vn')
  })

  test('empty ranges and audio export without an audio stream throw', () => {
    expect(() => buildExportArgs('in.mov', [], 'out.mp4', 'mp4', true)).toThrow(/nothing to export/i)
    expect(() => buildExportArgs('in.mov', ranges, 'out.m4a', 'm4a', false)).toThrow(/no audio stream/i)
  })

  test('burn-in single range: -vf subtitles with quoted path', () => {
    const args = buildExportArgs('in.mov', [{ start: 1, end: 3 }], 'out.mp4', 'mp4', true, 'videotoolbox', '/tmp/some dir/c.srt')
    const vf = args[args.indexOf('-vf') + 1]
    expect(vf).toBe("subtitles=filename='/tmp/some dir/c.srt'")
  })

  test('burn-in multi range: subtitles chained after concat, [vout] mapped', () => {
    const args = buildExportArgs('in.mov', ranges, 'out.mp4', 'mp4', true, 'videotoolbox', '/tmp/c.srt')
    const graph = args[args.indexOf('-filter_complex') + 1]
    expect(graph).toContain("concat=n=2:v=1:a=1[v][a];[v]subtitles=filename='/tmp/c.srt'[vout]")
    expect(args).toContain('[vout]')
    expect(args).not.toContain('-vf')
  })

  test('burn-in is ignored for audio-only formats', () => {
    const args = buildExportArgs('in.mov', ranges, 'out.m4a', 'm4a', true, 'videotoolbox', '/tmp/c.srt')
    expect(args.join(' ')).not.toContain('subtitles')
  })
})

describe('exportMedia (real ffmpeg)', () => {
  test('multi-cut export: correct duration, A/V present and in sync', async () => {
    const out = join(tmp, 'edited.mp4')
    // 3 kept ranges totaling 4 s out of the 10 s source
    const ranges = [
      { start: 1, end: 2 },
      { start: 4, end: 5 },
      { start: 7, end: 9 }
    ]
    const fractions: number[] = []
    await exportMedia(sample, ranges, out, 'mp4', { onProgress: (f) => fractions.push(f) })

    expect(existsSync(out)).toBe(true)
    expect(existsSync(`${out}.part.mp4`)).toBe(false)

    const probe = await ffprobeJson(out)
    const duration = Number(probe.format?.duration)
    expect(duration).toBeGreaterThan(3.8)
    expect(duration).toBeLessThan(4.3)

    const video = probe.streams?.find((s) => s.codec_type === 'video')
    const audio = probe.streams?.find((s) => s.codec_type === 'audio')
    expect(video?.codec_name).toBe('h264')
    expect(audio?.codec_name).toBe('aac')

    // A/V sync proxy: both streams must cover (nearly) the same span
    const vDur = Number((video as { duration?: string })?.duration ?? duration)
    const aDur = Number((audio as { duration?: string })?.duration ?? duration)
    expect(Math.abs(vDur - aDur)).toBeLessThan(0.2)
  }, 120_000)

  test('cancel mid-export rejects and leaves no partial file', async () => {
    const out = join(tmp, 'canceled.mp4')
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 120)
    await expect(
      exportMedia(sample, [{ start: 0, end: 10 }], out, 'mp4', { onProgress: () => {}, signal: controller.signal })
    ).rejects.toThrow(/cancel/i)
    expect(existsSync(out)).toBe(false)
    expect(existsSync(`${out}.part.mp4`)).toBe(false)
  }, 60_000)

  test('audio-only m4a export: audio stream only, cuts applied', async () => {
    const out = join(tmp, 'edited.m4a')
    const ranges = [
      { start: 1, end: 2 },
      { start: 4, end: 5 },
      { start: 7, end: 9 }
    ]
    await exportMedia(sample, ranges, out, 'm4a', { onProgress: () => {} })

    expect(existsSync(out)).toBe(true)
    expect(existsSync(`${out}.part.m4a`)).toBe(false)
    const probe = await ffprobeJson(out)
    const duration = Number(probe.format?.duration)
    expect(duration).toBeGreaterThan(3.8)
    expect(duration).toBeLessThan(4.3)
    expect(probe.streams?.some((s) => s.codec_type === 'video')).toBe(false)
    expect(probe.streams?.find((s) => s.codec_type === 'audio')?.codec_name).toBe('aac')
  }, 60_000)

  test('audio-only mp3 export produces a valid mp3', async () => {
    const out = join(tmp, 'edited.mp3')
    await exportMedia(sample, [{ start: 1, end: 3 }], out, 'mp3', { onProgress: () => {} })

    const probe = await ffprobeJson(out)
    expect(Number(probe.format?.duration)).toBeCloseTo(2, 0)
    expect(probe.streams?.find((s) => s.codec_type === 'audio')?.codec_name).toBe('mp3')
  }, 60_000)

  // Gated on the same runtime capability that gates the UI: homebrew's current
  // ffmpeg bottle lacks libass, so this only runs where burn-in actually can.
  test('burn-in export encodes with the subtitles filter (when ffmpeg has libass)', async (ctx) => {
    if (!(await hasFilter('subtitles'))) return ctx.skip()
    const srtPath = join(tmp, 'cues.srt')
    await writeFile(srtPath, '1\n00:00:00,500 --> 00:00:01,500\nhello 大家好\n', 'utf8')
    const out = join(tmp, 'burned.mp4')
    await exportMedia(sample, [{ start: 1, end: 3 }], out, 'mp4', { onProgress: () => {}, subtitlesPath: srtPath })

    const probe = await ffprobeJson(out)
    expect(Number(probe.format?.duration)).toBeCloseTo(2, 0)
    expect(probe.streams?.find((s) => s.codec_type === 'video')?.codec_name).toBe('h264')
  }, 120_000)
})
