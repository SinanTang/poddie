import { rename, unlink } from 'node:fs/promises'
import { ffprobeJson } from './media'
import { runToolProgress } from './ffmpeg'
import { log } from './logger'
import type { TimeRange } from '../shared/edit'

/** mp4 = video+audio for SNS platforms; m4a/mp3 = audio-only for podcast RSS feeds. */
export type ExportFormat = 'mp4' | 'm4a' | 'mp3'

export type ExportEncoder = 'videotoolbox' | 'libx264'

const ENCODER_ARGS: Record<ExportEncoder, string[]> = {
  videotoolbox: ['-c:v', 'h264_videotoolbox', '-b:v', '10M'],
  libx264: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18']
}

const AUDIO_ARGS: Record<ExportFormat, string[]> = {
  mp4: ['-c:a', 'aac', '-b:a', '192k'],
  m4a: ['-c:a', 'aac', '-b:a', '192k'],
  mp3: ['-c:a', 'libmp3lame', '-b:a', '192k']
}

const fmt = (n: number): string => n.toFixed(3)

/**
 * The subtitles (libass) filter arg. Filtergraph quoting: wrap in single
 * quotes, escape embedded quotes — the path is app-controlled (cache dir),
 * so this covers everything that can actually appear in it.
 */
function subtitlesFilter(srtPath: string): string {
  return `subtitles=filename='${srtPath.replace(/'/g, "'\\''")}'`
}

/**
 * ffmpeg args cutting `ranges` out of the source and concatenating them,
 * frame/sample-accurately, with one re-encode. Whether the output carries a
 * video stream falls out of the format — audio-only exports are the same
 * graph minus the video chains, not a separate code path. Single range uses
 * plain input seeking (equally accurate under re-encode, no filter graph).
 * ffmpeg's autorotation bakes iPhone display-matrix rotation into mp4 output.
 * `subtitlesPath` burns captions in AFTER the cuts — the SRT is on the output
 * timeline, which both paths produce (input seeking and concat reset PTS to 0).
 */
export function buildExportArgs(
  sourcePath: string,
  ranges: TimeRange[],
  outPath: string,
  format: ExportFormat,
  hasVideo: boolean,
  hasAudio: boolean,
  encoder: ExportEncoder = 'videotoolbox',
  subtitlesPath?: string
): string[] {
  if (ranges.length === 0) throw new Error('Nothing to export: every range was cut')
  const video = format === 'mp4'
  if (video && !hasVideo) throw new Error('Cannot export video: the source has no video stream')
  if (!video && !hasAudio) throw new Error(`Cannot export ${format}: the source has no audio stream`)
  const burnIn = video && subtitlesPath ? subtitlesFilter(subtitlesPath) : null

  const outputArgs = [
    ...(video ? [...ENCODER_ARGS[encoder], '-pix_fmt', 'yuv420p'] : ['-vn']),
    ...(hasAudio ? AUDIO_ARGS[format] : []),
    ...(format === 'mp3' ? [] : ['-movflags', '+faststart']),
    outPath
  ]

  if (ranges.length === 1) {
    const r = ranges[0]
    return [
      '-y',
      '-ss', fmt(r.start),
      '-i', sourcePath,
      '-t', fmt(r.end - r.start),
      ...(burnIn ? ['-vf', burnIn] : []),
      ...outputArgs
    ]
  }

  const parts: string[] = []
  ranges.forEach((r, i) => {
    if (video) parts.push(`[0:v]trim=start=${fmt(r.start)}:end=${fmt(r.end)},setpts=PTS-STARTPTS[v${i}]`)
    if (hasAudio) parts.push(`[0:a]atrim=start=${fmt(r.start)}:end=${fmt(r.end)},asetpts=PTS-STARTPTS[a${i}]`)
  })
  const concatInputs = ranges.map((_, i) => `${video ? `[v${i}]` : ''}${hasAudio ? `[a${i}]` : ''}`).join('')
  parts.push(
    `${concatInputs}concat=n=${ranges.length}:v=${video ? 1 : 0}:a=${hasAudio ? 1 : 0}${video ? '[v]' : ''}${hasAudio ? '[a]' : ''}`
  )
  if (burnIn) parts.push(`[v]${burnIn}[vout]`)

  return [
    '-y',
    '-i', sourcePath,
    '-filter_complex', parts.join(';'),
    ...(video ? ['-map', burnIn ? '[vout]' : '[v]'] : []),
    ...(hasAudio ? ['-map', '[a]'] : []),
    ...outputArgs
  ]
}

export interface ExportOptions {
  onProgress: (fraction: number) => void
  signal?: AbortSignal
  /** SRT file (output-timeline times) to burn into the video. mp4 only. */
  subtitlesPath?: string
}

/**
 * Export the kept ranges of the source into outPath. mp4 tries the hardware
 * encoder first with libx264 fallback; audio-only formats encode in software
 * directly (seconds, not minutes — no fallback needed). Writes to a .part
 * file (renamed on success, deleted on failure/cancel) so a broken run never
 * leaves a plausible-looking output.
 */
export async function exportMedia(
  sourcePath: string,
  ranges: TimeRange[],
  outPath: string,
  format: ExportFormat,
  { onProgress, signal, subtitlesPath }: ExportOptions
): Promise<void> {
  const probe = await ffprobeJson(sourcePath)
  const hasVideo = (probe.streams ?? []).some((s) => s.codec_type === 'video')
  const hasAudio = (probe.streams ?? []).some((s) => s.codec_type === 'audio')
  const keptDuration = ranges.reduce((acc, r) => acc + (r.end - r.start), 0)
  // the .part suffix keeps the real extension last so ffmpeg infers the container
  const partPath = `${outPath}.part.${format}`

  const argsFor = (encoder: ExportEncoder): string[] =>
    buildExportArgs(sourcePath, ranges, partPath, format, hasVideo, hasAudio, encoder, subtitlesPath)

  try {
    // built outside the fallback try: a validation error (bad format/stream
    // combination) must reject immediately, not trigger an encoder "fallback"
    const primaryArgs = argsFor('videotoolbox')
    try {
      await runToolProgress('ffmpeg', primaryArgs, keptDuration, onProgress, signal)
    } catch (err) {
      if (signal?.aborted || format !== 'mp4') throw err
      log('warn', 'export', `videotoolbox failed, falling back to libx264: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`)
      await runToolProgress('ffmpeg', argsFor('libx264'), keptDuration, onProgress, signal)
    }
    await rename(partPath, outPath)
    log('info', 'export', `done: ${outPath} (${format}, ${ranges.length} ranges, ${keptDuration.toFixed(1)} s)`)
  } catch (err) {
    await unlink(partPath).catch(() => {})
    if (signal?.aborted) {
      log('info', 'export', 'canceled by user')
      throw new Error('Export canceled')
    }
    throw err
  }
}
