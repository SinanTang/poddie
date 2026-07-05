import { needsSpaceBetween } from '../../../shared/cjk'
import type { TranscriptSegment } from '../../../shared/types'

/** Anything with text and a time span: transcript words or edit items (gaps have text ''). */
export interface TimedToken {
  text: string
  start: number
  end: number
}

/**
 * Lowercased concatenation of all tokens (same spacing rules as display) plus
 * per-token char offsets, so a query like 审计 or "you know" can match across
 * token boundaries and map back to token indices. Zero-width tokens (gaps)
 * keep the offset arrays index-aligned but contribute no text.
 */
export interface SearchIndex {
  text: string
  starts: number[]
  ends: number[]
}

export function buildSearchIndex(tokens: readonly TimedToken[]): SearchIndex {
  let text = ''
  const starts: number[] = []
  const ends: number[] = []
  let prev = ''
  for (const t of tokens) {
    const lower = t.text.toLowerCase()
    if (lower && text && needsSpaceBetween(prev, t.text)) text += ' '
    starts.push(text.length)
    text += lower
    ends.push(text.length)
    if (lower) prev = t.text
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
    // skip zero-width tokens and separator-space landings
    while (startWord < index.ends.length - 1 && index.ends[startWord] <= at) startWord++
    let endWord = greatestLeq(index.starts, end - 1)
    while (endWord > startWord && index.starts[endWord] === index.ends[endWord]) endWord--
    matches.push({ startWord, endWord })
    from = at + q.length
  }
  return matches
}

/** Index of the last token whose start is <= t, or -1 before the first. */
export function findWordAtTime(tokens: readonly TimedToken[], t: number): number {
  let lo = 0
  let hi = tokens.length - 1
  let best = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (tokens[mid].start <= t) {
      best = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return best
}

export interface Paragraph {
  startSec: number
  /** [from, to) range into the token array. */
  from: number
  to: number
}

const MIN_PARAGRAPH_WORDS = 50

/**
 * Group tokens into paragraphs along Whisper segment boundaries, merging
 * segments until each paragraph has a readable minimum of tokens.
 */
export function buildParagraphs(tokens: readonly TimedToken[], segments: TranscriptSegment[]): Paragraph[] {
  if (tokens.length === 0) return []
  if (segments.length === 0) return [{ startSec: tokens[0].start, from: 0, to: tokens.length }]

  const paragraphs: Paragraph[] = []
  let w = 0
  let from = 0
  for (const seg of segments) {
    while (w < tokens.length && tokens[w].start < seg.end) w++
    if (w - from >= MIN_PARAGRAPH_WORDS) {
      paragraphs.push({ startSec: tokens[from].start, from, to: w })
      from = w
    }
  }
  if (from < tokens.length) paragraphs.push({ startSec: tokens[from].start, from, to: tokens.length })
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
