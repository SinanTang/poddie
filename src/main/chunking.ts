import type { TranscriptSegment, TranscriptWord } from '../shared/types'
import type { WhisperSegment, WhisperWord } from './whisper'

export interface TimeRange {
  start: number
  end: number
}

/** Whisper rejects uploads over 25 MB; stay under it with a safety margin. */
export const CHUNK_TARGET_BYTES = 24 * 1024 * 1024

/** Parse `silencedetect` filter output (ffmpeg logs it to stderr). */
export function parseSilences(ffmpegStderr: string): TimeRange[] {
  const silences: TimeRange[] = []
  let pendingStart: number | null = null
  for (const line of ffmpegStderr.split('\n')) {
    const startMatch = line.match(/silence_start:\s*([\d.]+)/)
    const endMatch = line.match(/silence_end:\s*([\d.]+)/)
    if (startMatch) {
      pendingStart = parseFloat(startMatch[1])
    } else if (endMatch && pendingStart !== null) {
      silences.push({ start: pendingStart, end: parseFloat(endMatch[1]) })
      pendingStart = null
    }
  }
  return silences
}

function nearestSilenceMidpoint(silences: TimeRange[], target: number, windowSec: number): number | null {
  let best: number | null = null
  for (const s of silences) {
    const mid = (s.start + s.end) / 2
    if (Math.abs(mid - target) > windowSec) continue
    if (best === null || Math.abs(mid - target) < Math.abs(best - target)) best = mid
  }
  return best
}

/**
 * Split the audio into ranges that each fit under the Whisper upload cap,
 * preferring cut points in the middle of detected silences (within ±30 s of
 * the equal-split boundary) so no word is ever split across chunks.
 */
export function planChunks(
  durationSec: number,
  sizeBytes: number,
  silences: TimeRange[],
  maxBytes: number = CHUNK_TARGET_BYTES
): TimeRange[] {
  if (sizeBytes <= maxBytes || durationSec <= 0) return [{ start: 0, end: durationSec }]

  const chunkCount = Math.ceil(sizeBytes / maxBytes)
  const targetDuration = durationSec / chunkCount

  const cuts: number[] = []
  for (let i = 1; i < chunkCount; i++) {
    const ideal = i * targetDuration
    const cut = nearestSilenceMidpoint(silences, ideal, 30) ?? ideal
    // silence snapping could reorder or collapse boundaries on pathological input
    if (cuts.length === 0 || cut > cuts[cuts.length - 1] + 1) cuts.push(cut)
  }

  const edges = [0, ...cuts, durationSec]
  const ranges: TimeRange[] = []
  for (let i = 0; i < edges.length - 1; i++) {
    if (edges[i + 1] - edges[i] > 0.1) ranges.push({ start: edges[i], end: edges[i + 1] })
  }
  return ranges
}

/**
 * Merge per-chunk Whisper words into one absolute-time word list.
 * Words that overlap the previous chunk's tail (imprecise chunk cuts) are
 * dropped; whitespace-only tokens are discarded.
 */
export function stitchWords(chunks: Array<{ offset: number; words: WhisperWord[] }>): TranscriptWord[] {
  const out: TranscriptWord[] = []
  for (const chunk of chunks) {
    for (const w of chunk.words) {
      const text = w.word.trim()
      if (!text) continue
      const start = w.start + chunk.offset
      const end = Math.max(w.end + chunk.offset, start)
      const last = out[out.length - 1]
      if (last && start < last.end - 0.05) continue
      out.push({ text, start, end })
    }
  }
  return out
}

export function stitchSegments(chunks: Array<{ offset: number; segments: WhisperSegment[] }>): TranscriptSegment[] {
  const out: TranscriptSegment[] = []
  for (const chunk of chunks) {
    for (const s of chunk.segments) {
      if (!s.text) continue
      out.push({ text: s.text, start: s.start + chunk.offset, end: s.end + chunk.offset })
    }
  }
  return out
}
