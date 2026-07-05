import { rename, unlink } from 'node:fs/promises'
import { ffprobeJson } from './media'
import { runToolProgress } from './ffmpeg'
import { log } from './logger'
import type { TimeRange } from '../shared/edit'

export type ExportEncoder = 'videotoolbox' | 'libx264'

const ENCODER_ARGS: Record<ExportEncoder, string[]> = {
  videotoolbox: ['-c:v', 'h264_videotoolbox', '-b:v', '10M'],
  libx264: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18']
}

const fmt = (n: number): string => n.toFixed(3)

/**
 * ffmpeg args cutting `ranges` out of the source and concatenating them,
 * frame-accurately, with one re-encode. Single range uses plain input seeking
 * (equally accurate under re-encode, no filter graph). ffmpeg's autorotation
 * bakes iPhone display-matrix rotation into the output.
 */
export function buildExportArgs(
  sourcePath: string,
  ranges: TimeRange[],
  outPath: string,
  encoder: ExportEncoder,
  hasAudio: boolean
): string[] {
  if (ranges.length === 0) throw new Error('Nothing to export: every range was cut')

  const common = [...ENCODER_ARGS[encoder], '-pix_fmt', 'yuv420p', ...(hasAudio ? ['-c:a', 'aac', '-b:a', '192k'] : []), '-movflags', '+faststart', outPath]

  if (ranges.length === 1) {
    const r = ranges[0]
    return ['-y', '-ss', fmt(r.start), '-i', sourcePath, '-t', fmt(r.end - r.start), ...common]
  }

  const parts: string[] = []
  ranges.forEach((r, i) => {
    parts.push(`[0:v]trim=start=${fmt(r.start)}:end=${fmt(r.end)},setpts=PTS-STARTPTS[v${i}]`)
    if (hasAudio) parts.push(`[0:a]atrim=start=${fmt(r.start)}:end=${fmt(r.end)},asetpts=PTS-STARTPTS[a${i}]`)
  })
  const concatInputs = ranges.map((_, i) => (hasAudio ? `[v${i}][a${i}]` : `[v${i}]`)).join('')
  parts.push(`${concatInputs}concat=n=${ranges.length}:v=1:a=${hasAudio ? 1 : 0}[v]${hasAudio ? '[a]' : ''}`)

  return [
    '-y',
    '-i', sourcePath,
    '-filter_complex', parts.join(';'),
    '-map', '[v]',
    ...(hasAudio ? ['-map', '[a]'] : []),
    ...common
  ]
}

export interface ExportOptions {
  onProgress: (fraction: number) => void
  signal?: AbortSignal
}

/**
 * Export the kept ranges of the source into outPath. Hardware encoder first,
 * libx264 fallback. Writes to a .part file (renamed on success, deleted on
 * failure/cancel) so a broken run never leaves a plausible-looking output.
 */
export async function exportVideo(
  sourcePath: string,
  ranges: TimeRange[],
  outPath: string,
  { onProgress, signal }: ExportOptions
): Promise<void> {
  const probe = await ffprobeJson(sourcePath)
  const hasAudio = (probe.streams ?? []).some((s) => s.codec_type === 'audio')
  const keptDuration = ranges.reduce((acc, r) => acc + (r.end - r.start), 0)
  const partPath = `${outPath}.part.mp4`

  try {
    try {
      await runToolProgress('ffmpeg', buildExportArgs(sourcePath, ranges, partPath, 'videotoolbox', hasAudio), keptDuration, onProgress, signal)
    } catch (err) {
      if (signal?.aborted) throw err
      log('warn', 'export', `videotoolbox failed, falling back to libx264: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`)
      await runToolProgress('ffmpeg', buildExportArgs(sourcePath, ranges, partPath, 'libx264', hasAudio), keptDuration, onProgress, signal)
    }
    await rename(partPath, outPath)
    log('info', 'export', `done: ${outPath} (${ranges.length} ranges, ${keptDuration.toFixed(1)} s)`)
  } catch (err) {
    await unlink(partPath).catch(() => {})
    if (signal?.aborted) {
      log('info', 'export', 'canceled by user')
      throw new Error('Export canceled')
    }
    throw err
  }
}
