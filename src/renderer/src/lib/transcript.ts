import { needsSpaceBetween } from '../../../shared/cjk'
import type { TranscriptSegment, TranscriptWord } from '../../../shared/types'

/**
 * Lowercased concatenation of all tokens (same spacing rules as display) plus
 * per-token char offsets, so a query like 审计 or "you know" can match across
 * token boundaries and map back to word indices.
 */
export interface SearchIndex {
  text: string
  starts: number[]
  ends: number[]
}

export function buildSearchIndex(words: TranscriptWord[]): SearchIndex {
  let text = ''
  const starts: number[] = []
  const ends: number[] = []
  let prev = ''
  for (const w of words) {
    const token = w.text.toLowerCase()
    if (text && needsSpaceBetween(prev, w.text)) text += ' '
    starts.push(text.length)
    text += token
    ends.push(text.length)
    prev = w.text
  }
  return { text, starts, ends }
}

export interface MatchRange {
  startWord: number
  endWord: number
}

const MATCH_CAP = 500

export function findMatches(index: SearchIndex, query: string): MatchRange[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const matches: MatchRange[] = []
  let from = 0
  while (matches.length < MATCH_CAP) {
    const at = index.text.indexOf(q, from)
    if (at < 0) break
    const end = at + q.length
    let startWord = greatestLeq(index.starts, at)
    if (index.ends[startWord] <= at) startWord++ // match began in the separator space
    const endWord = greatestLeq(index.starts, end - 1)
    matches.push({ startWord, endWord })
    from = at + q.length
  }
  return matches
}

/** Index of the last word whose start is <= t, or -1 before the first word. */
export function findWordAtTime(words: TranscriptWord[], t: number): number {
  return greatestLeqBy(words, t, (w) => w.start)
}

export interface Paragraph {
  startSec: number
  /** [from, to) range into the words array. */
  from: number
  to: number
}

const MIN_PARAGRAPH_WORDS = 50

/**
 * Group words into paragraphs along Whisper segment boundaries, merging
 * segments until each paragraph has a readable minimum of words.
 */
export function buildParagraphs(words: TranscriptWord[], segments: TranscriptSegment[]): Paragraph[] {
  if (words.length === 0) return []
  if (segments.length === 0) return [{ startSec: words[0].start, from: 0, to: words.length }]

  const paragraphs: Paragraph[] = []
  let w = 0
  let from = 0
  for (const seg of segments) {
    while (w < words.length && words[w].start < seg.end) w++
    if (w - from >= MIN_PARAGRAPH_WORDS) {
      paragraphs.push({ startSec: words[from].start, from, to: w })
      from = w
    }
  }
  if (from < words.length) paragraphs.push({ startSec: words[from].start, from, to: words.length })
  return paragraphs
}

/** Greatest index i with sorted[i] <= target, else -1. */
function greatestLeq(sorted: number[], target: number): number {
  let lo = 0
  let hi = sorted.length - 1
  let best = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] <= target) {
      best = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return best
}

function greatestLeqBy<T>(items: T[], target: number, key: (item: T) => number): number {
  let lo = 0
  let hi = items.length - 1
  let best = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (key(items[mid]) <= target) {
      best = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return best
}
