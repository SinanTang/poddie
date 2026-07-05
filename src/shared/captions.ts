import { isCjk, needsSpaceBetween } from './cjk'
import { keptRanges, type EditItem } from './edit'

/**
 * Caption cue on the OUTPUT timeline (post-cut). Built from kept words only —
 * cut words vanish, and times shift left by the removed time before them, so
 * cues line up with the exported file, not the source.
 */
export interface CaptionCue {
  start: number
  end: number
  text: string
}

/** Line-width budget in units: CJK chars count 2, Latin 1 (≈21 zh chars / 42 latin). */
const MAX_CUE_UNITS = 42
/** Sentence-ending punctuation may break the cue once it is at least this wide. */
const SOFT_BREAK_UNITS = 20
const MAX_CUE_SEC = 5
/** A source-time pause this long between words starts a new cue (cut or kept). */
const PAUSE_BREAK_SEC = 0.6
const MIN_CUE_SEC = 0.05
const SENTENCE_END = /[。！？.!?…]['"’”]?$/

function textUnits(text: string): number {
  let units = 0
  for (const ch of text) units += isCjk(ch) ? 2 : 1
  return units
}

/**
 * Map a source-timeline second onto the output timeline: inside a kept range
 * it shifts left by the removed time before it; inside a cut it collapses to
 * the cut point. Monotonic by construction.
 */
function buildRemap(items: EditItem[], durationSec: number): (t: number) => number {
  const segs: { start: number; end: number; out: number }[] = []
  let acc = 0
  for (const r of keptRanges(items, durationSec)) {
    segs.push({ start: r.start, end: r.end, out: acc })
    acc += r.end - r.start
  }
  return (t) => {
    let lo = 0
    let hi = segs.length - 1
    let best = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (segs[mid].start <= t) {
        best = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    if (best < 0) return 0
    const s = segs[best]
    return s.out + Math.min(Math.max(t - s.start, 0), s.end - s.start)
  }
}

/**
 * Group the kept words into readable caption cues. Breaks on pauses, width,
 * duration, and (softly) sentence punctuation — which 5.1a text edits can add,
 * so cleaning the transcript directly improves the captions.
 */
export function buildCues(items: EditItem[], durationSec: number): CaptionCue[] {
  const remap = buildRemap(items, durationSec)
  const cues: CaptionCue[] = []

  let text = ''
  let units = 0
  let startSrc = 0
  let endSrc = 0
  let outStart = 0

  const flush = (): void => {
    const start = remap(startSrc)
    const end = remap(endSrc)
    if (text !== '' && end - start >= MIN_CUE_SEC) cues.push({ start, end, text })
    text = ''
    units = 0
  }

  for (const item of items) {
    if (item.kind !== 'word' || item.removed || item.text === '') continue
    if (text !== '') {
      const pause = item.start - endSrc > PAUSE_BREAK_SEC
      const tooWide = units + textUnits(item.text) > MAX_CUE_UNITS
      const tooLong = remap(item.end) - outStart > MAX_CUE_SEC
      if (pause || tooWide || tooLong) flush()
    }
    if (text === '') {
      startSrc = item.start
      outStart = remap(item.start)
    } else if (needsSpaceBetween(text, item.text)) {
      text += ' '
      units += 1
    }
    text += item.text
    units += textUnits(item.text)
    endSrc = Math.max(endSrc, item.end)
    if (units >= SOFT_BREAK_UNITS && SENTENCE_END.test(item.text)) flush()
  }
  flush()
  return cues
}

export function srtTimestamp(sec: number): string {
  const total = Math.max(0, Math.round(sec * 1000))
  const h = Math.floor(total / 3_600_000)
  const m = Math.floor((total % 3_600_000) / 60_000)
  const s = Math.floor((total % 60_000) / 1000)
  const ms = total % 1000
  const p = (n: number, w: number): string => String(n).padStart(w, '0')
  return `${p(h, 2)}:${p(m, 2)}:${p(s, 2)},${p(ms, 3)}`
}

export function toSrt(cues: CaptionCue[]): string {
  return cues
    .map((c, i) => `${i + 1}\n${srtTimestamp(c.start)} --> ${srtTimestamp(c.end)}\n${c.text}\n`)
    .join('\n')
}
