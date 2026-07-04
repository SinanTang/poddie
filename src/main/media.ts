import { createHash } from 'node:crypto'
import { mkdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { runTool } from './ffmpeg'
import type { AudioExtractResult, VideoInfo } from '../shared/types'

interface FfprobeStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  avg_frame_rate?: string
  channels?: number
  sample_rate?: string
}

interface FfprobeOutput {
  format?: { duration?: string; size?: string }
  streams?: FfprobeStream[]
}

/** Codecs Chromium's bundled decoders handle; anything else needs a preview proxy. */
const CHROMIUM_PLAYABLE = new Set(['h264', 'vp8', 'vp9', 'av1'])

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

export async function probeVideo(path: string): Promise<VideoInfo> {
  const probe = await ffprobeJson(path)
  const streams = probe.streams ?? []
  const video = streams.find((s) => s.codec_type === 'video')
  if (!video || !video.codec_name) throw new Error(`No video stream found in ${path}`)
  const audio = streams.find((s) => s.codec_type === 'audio')

  return {
    path,
    sizeBytes: Number(probe.format?.size ?? 0),
    durationSec: Number(probe.format?.duration ?? 0),
    width: video.width ?? 0,
    height: video.height ?? 0,
    fps: parseFps(video.avg_frame_rate),
    videoCodec: video.codec_name,
    audioCodec: audio?.codec_name ?? null,
    needsProxy: !CHROMIUM_PLAYABLE.has(video.codec_name)
  }
}

/**
 * Extract mono 16 kHz 64 kbps m4a for Whisper. Cached by (path, mtime, size)
 * so re-opening the same video is instant. Writes to a .part file first so a
 * crashed ffmpeg can never leave a truncated file behind as a valid cache hit.
 */
export async function extractAudio(videoPath: string, cacheDir: string): Promise<AudioExtractResult> {
  await mkdir(cacheDir, { recursive: true })
  const source = await stat(videoPath)
  const key = createHash('sha1')
    .update(`${videoPath}:${source.mtimeMs}:${source.size}`)
    .digest('hex')
    .slice(0, 16)
  const audioPath = join(cacheDir, `${key}.m4a`)

  const cached = await stat(audioPath).catch(() => null)
  if (cached) return { audioPath, sizeBytes: cached.size }

  const partPath = `${audioPath}.part.m4a`
  await runTool('ffmpeg', ['-y', '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', partPath])
  await rename(partPath, audioPath)
  const out = await stat(audioPath)
  return { audioPath, sizeBytes: out.size }
}
