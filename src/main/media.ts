import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runTool, runToolBuffer, runToolProgress } from './ffmpeg'
import type { AudioExtractResult, MediaInfo, PeaksResult } from '../shared/types'

interface FfprobeStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  avg_frame_rate?: string
  channels?: number
  sample_rate?: string
  side_data_list?: Array<{ rotation?: number }>
}

interface FfprobeOutput {
  format?: { duration?: string; size?: string }
  streams?: FfprobeStream[]
}

/** Codecs Chromium's bundled decoders handle; anything else needs a preview proxy. */
const CHROMIUM_PLAYABLE = new Set(['h264', 'vp8', 'vp9', 'av1'])
/** Audio codecs Chromium plays natively (pcm_* covers every wav flavor). Notably absent: alac. */
const CHROMIUM_PLAYABLE_AUDIO = new Set(['aac', 'mp3', 'flac', 'opus', 'vorbis'])
const isPlayableAudio = (codec: string): boolean =>
  CHROMIUM_PLAYABLE_AUDIO.has(codec) || codec.startsWith('pcm_')

function parseFps(rate: string | undefined): number {
  if (!rate) return 0
  const [num, den] = rate.split('/').map(Number)
  if (!num || Number.isNaN(num)) return 0
  return den ? num / den : num
}

export async function ffprobeJson(path: string): Promise<FfprobeOutput> {
  const { stdout } = await runTool('ffprobe', [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    path
  ])
  return JSON.parse(stdout) as FfprobeOutput
}

export async function probeMedia(path: string): Promise<MediaInfo> {
  const probe = await ffprobeJson(path)
  const streams = probe.streams ?? []
  const video = streams.find((s) => s.codec_type === 'video' && s.codec_name)
  const audio = streams.find((s) => s.codec_type === 'audio' && s.codec_name)
  if (!video && !audio) throw new Error(`No audio or video stream found in ${path}`)

  // iPhone stores coded dims + a rotation flag; report DISPLAY dims (what the
  // viewer sees, and what ffmpeg's auto-rotation produces on transcode)
  const rotation = video?.side_data_list?.find((d) => d.rotation != null)?.rotation ?? 0
  const swapped = Math.abs(rotation) % 180 === 90

  return {
    path,
    sizeBytes: Number(probe.format?.size ?? 0),
    durationSec: Number(probe.format?.duration ?? 0),
    hasVideo: video != null,
    width: (swapped ? video?.height : video?.width) ?? 0,
    height: (swapped ? video?.width : video?.height) ?? 0,
    fps: parseFps(video?.avg_frame_rate),
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    needsProxy: video
      ? !CHROMIUM_PLAYABLE.has(video.codec_name!)
      : !isPlayableAudio(audio!.codec_name!)
  }
}

function cacheKeyFor(videoPath: string, source: { mtimeMs: number; size: number }): string {
  return createHash('sha1').update(`${videoPath}:${source.mtimeMs}:${source.size}`).digest('hex').slice(0, 16)
}

/**
 * Extract mono 16 kHz audio for Whisper — m4a (64 kbps, small enough to
 * upload) for the API, wav (pcm_s16le) for whisper-cli, which can't read m4a.
 * Cached by (path, mtime, size) so re-opening the same video is instant.
 * Writes to a .part file first so a crashed ffmpeg can never leave a
 * truncated file behind as a valid cache hit.
 */
export async function extractAudio(
  videoPath: string,
  cacheDir: string,
  format: 'm4a' | 'wav' = 'm4a'
): Promise<AudioExtractResult> {
  await mkdir(cacheDir, { recursive: true })
  const source = await stat(videoPath)
  const audioPath = join(cacheDir, `${cacheKeyFor(videoPath, source)}.${format}`)

  const cached = await stat(audioPath).catch(() => null)
  if (cached) return { audioPath, sizeBytes: cached.size }

  const codecArgs = format === 'wav' ? ['-c:a', 'pcm_s16le'] : ['-b:a', '64k']
  const partPath = `${audioPath}.part.${format}`
  await runTool('ffmpeg', ['-y', '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', ...codecArgs, partPath])
  await rename(partPath, audioPath)
  const out = await stat(audioPath)
  return { audioPath, sizeBytes: out.size }
}

/**
 * Create (or return the cached) preview proxy for codecs Chromium can't decode.
 * Video sources (iPhone HEVC) → H.264 mp4, 540px short side — plenty for
 * preview, hardware encoder first with libx264 fallback. Audio-only sources
 * (e.g. ALAC m4a) → AAC m4a. Export always cuts the original, never the proxy.
 */
export async function ensurePreviewProxy(
  videoPath: string,
  cacheDir: string,
  onProgress: (fraction: number) => void
): Promise<{ proxyPath: string }> {
  await mkdir(cacheDir, { recursive: true })
  const source = await stat(videoPath)
  const probe = await ffprobeJson(videoPath)
  const durationSec = Number(probe.format?.duration ?? 0)
  const hasVideo = (probe.streams ?? []).some((s) => s.codec_type === 'video' && s.codec_name)

  if (!hasVideo) {
    const proxyPath = join(cacheDir, `${cacheKeyFor(videoPath, source)}.proxy.m4a`)
    if (await stat(proxyPath).catch(() => null)) return { proxyPath }
    const partPath = `${proxyPath}.part.m4a`
    await runToolProgress(
      'ffmpeg',
      ['-y', '-i', videoPath, '-vn', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', partPath],
      durationSec,
      onProgress
    )
    await rename(partPath, proxyPath)
    return { proxyPath }
  }

  const proxyPath = join(cacheDir, `${cacheKeyFor(videoPath, source)}.proxy.mp4`)
  if (await stat(proxyPath).catch(() => null)) return { proxyPath }
  const partPath = `${proxyPath}.part.mp4`
  const argsFor = (encoder: string[]): string[] => [
    '-y',
    '-i', videoPath,
    '-vf', 'scale=-2:540',
    ...encoder,
    '-c:a', 'aac',
    '-b:a', '96k',
    '-movflags', '+faststart',
    partPath
  ]
  try {
    await runToolProgress('ffmpeg', argsFor(['-c:v', 'h264_videotoolbox', '-b:v', '1500k']), durationSec, onProgress)
  } catch {
    await runToolProgress('ffmpeg', argsFor(['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26']), durationSec, onProgress)
  }
  await rename(partPath, proxyPath)
  return { proxyPath }
}

const PEAKS_SAMPLE_RATE = 8000
/** Bucket density: enough detail for zoomed-in waveforms (~50 ms/bucket); 44 min ≈ 53k floats ≈ 300 KB JSON. */
const PEAKS_PER_SEC = 20
const PEAK_BUCKETS_MIN = 4000
/** Bump when bucket density/shape changes so stale cached peaks regenerate. */
const PEAKS_VERSION = 2

/**
 * Waveform peaks (max-abs per bucket, normalized 0..1) from the extracted
 * audio — precomputed so wavesurfer never has to decode an hour of audio in
 * the renderer. Cached as JSON beside the audio cache entry.
 */
export async function computePeaks(audioPath: string): Promise<PeaksResult> {
  const peaksPath = `${audioPath}.peaks.json`
  const cached = await readFile(peaksPath, 'utf8').catch(() => null)
  if (cached) {
    const parsed = JSON.parse(cached) as PeaksResult & { version?: number }
    if (parsed.version === PEAKS_VERSION) return { peaks: parsed.peaks, duration: parsed.duration }
  }

  const raw = await runToolBuffer('ffmpeg', [
    '-v', 'error',
    '-i', audioPath,
    '-ac', '1',
    '-ar', String(PEAKS_SAMPLE_RATE),
    '-f', 's16le',
    '-'
  ])
  // copy to an aligned buffer — Buffer slices from the pool can be odd-offset
  const aligned = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length - (raw.length % 2))
  const samples = new Int16Array(aligned)
  if (samples.length === 0) throw new Error(`No audio samples decoded from ${audioPath}`)

  const buckets = Math.max(PEAK_BUCKETS_MIN, Math.ceil((samples.length / PEAKS_SAMPLE_RATE) * PEAKS_PER_SEC))
  const bucketSize = Math.max(1, Math.floor(samples.length / buckets))
  const peaks: number[] = []
  for (let b = 0; b < samples.length; b += bucketSize) {
    let max = 0
    const end = Math.min(b + bucketSize, samples.length)
    for (let i = b; i < end; i++) {
      const abs = Math.abs(samples[i])
      if (abs > max) max = abs
    }
    peaks.push(Math.round((max / 32768) * 1000) / 1000)
  }

  const result: PeaksResult = { peaks, duration: samples.length / PEAKS_SAMPLE_RATE }
  await writeFile(peaksPath, JSON.stringify({ version: PEAKS_VERSION, ...result }))
  return result
}
