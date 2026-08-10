import { joinTokens } from './cjk'
import type { EditItem, ItemChange } from './edit'
import { textEditChanges, toggleRangeChanges } from './edit'
import type { TranscriptSegment } from './types'

/**
 * Transcript cleanup: filler detection + LLM punctuation, both as reviewable
 * Suggestions that apply through the existing ItemChange model.
 *
 * Control is inverted relative to the naive "ask the LLM for edits" design —
 * the Phase 0 spike (docs/development/07072026-llm-transcript-cleanup/) showed
 * local models cannot produce token positions (index drift) nor place
 * punctuation freely (~30% placement quality). So the app ENUMERATES units
 * (numbered segments, list-detected filler candidates) and the model only
 * CLASSIFIES each number. Positions never come from the model; application is
 * deterministic here. Timing stays untouchable: punct edits text only, filler
 * marks items removed — the same fields manual editing already patches.
 */

export interface SuggestionBase {
  id: number
  source: 'list' | 'llm'
  /** Ready-to-render review row text (candidate bracketed 【…】 / punctuated segment). */
  preview: string
}

export interface PunctSuggestion extends SuggestionBase {
  kind: 'punct'
  /** Item index of the segment's last word — the mark is appended to its text. */
  index: number
  /** The word's text at enumeration time; a mismatch at apply time means stale → drop. */
  anchorText: string
  add: string
}

export interface FillerSuggestion extends SuggestionBase {
  kind: 'filler'
  /** Inclusive item range to mark removed. */
  index: number
  endIndex: number
  /** Joined text of the range at enumeration time (staleness check). */
  text: string
}

export type Suggestion = PunctSuggestion | FillerSuggestion

/**
 * Filler entries are DATA, not language logic: one flat list, every entry
 * always active (mixed-language transcripts are normal), users can extend or
 * replace it. Matching is a script-blind token-sequence comparison.
 */
export const DEFAULT_FILLER_LIST = [
  '嗯', '呃', '啊', '那个', '就是说', '就是', '然后', '这个', '所以说', '反正',
  'um', 'uh', 'erm', 'like', 'you know', 'i mean', 'sort of', 'kind of', 'basically', 'actually'
]

/** Marks the punct pass may emit (schema-enforced) — and that end already-punctuated text. */
export const PUNCT_MARKS = ['。', '，', '？', '！', '、', '；', '：', '.', ',', '?', '!', ';', ':', '…'] as const

export const PUNCT_BATCH_SIZE = 40

const normToken = (s: string): string => s.replace(/\s+/g, '').toLowerCase()

/** Word item with visible text that is still part of the cut (eligible for suggestions). */
function isLiveWord(item: EditItem): boolean {
  return item.kind === 'word' && item.text !== '' && !item.removed
}

// ---------------------------------------------------------------------------
// Filler detection (list-based, instant, offline)
// ---------------------------------------------------------------------------

const PREVIEW_CONTEXT_WORDS = 8

function contextPreview(items: EditItem[], from: number, to: number, core: string): string {
  const texts = (lo: number, hi: number, cap: number, fromEnd: boolean): string[] => {
    const out: string[] = []
    for (let i = lo; i <= hi; i++) {
      if (items[i]?.kind === 'word' && items[i].text) out.push(items[i].text)
    }
    return fromEnd ? out.slice(-cap) : out.slice(0, cap)
  }
  const left = joinTokens(texts(Math.max(0, from - 2 * PREVIEW_CONTEXT_WORDS), from - 1, PREVIEW_CONTEXT_WORDS, true))
  const right = joinTokens(texts(to + 1, Math.min(items.length - 1, to + 2 * PREVIEW_CONTEXT_WORDS), PREVIEW_CONTEXT_WORDS, false))
  return `${left}【${core}】${right}`
}

/**
 * Scan for filler-list matches over runs of consecutive live words. A gap
 * token, a removed item, or a blanked (merged-away) word ends the run — never
 * suggest cutting "one word" that actually spans an audible pause or a region
 * the user already edited. Longest entry wins at each position; matches never
 * overlap. Case-insensitive, whitespace-insensitive, script-blind.
 */
export function findFillerSuggestions(
  items: EditItem[],
  list: string[] = DEFAULT_FILLER_LIST,
  firstId = 0
): FillerSuggestion[] {
  const entries = list.map(normToken).filter(Boolean)
  const byLength = [...new Set(entries)].sort((a, b) => b.length - a.length)
  const out: FillerSuggestion[] = []
  for (let i = 0; i < items.length; i++) {
    if (!isLiveWord(items[i])) continue
    for (const entry of byLength) {
      let text = ''
      let j = i
      while (j < items.length && isLiveWord(items[j]) && text.length < entry.length) {
        text += normToken(items[j].text)
        j++
      }
      if (text !== entry) continue
      const endIndex = j - 1
      const spanText = joinTokens(items.slice(i, j).map((it) => it.text))
      out.push({
        kind: 'filler',
        id: firstId + out.length,
        source: 'list',
        index: i,
        endIndex,
        text: spanText,
        preview: contextPreview(items, i, endIndex, spanText)
      })
      i = endIndex
      break
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Punctuation pass (segments enumerated by the app, marks chosen by the LLM)
// ---------------------------------------------------------------------------

/**
 * Assign every word item to a segment by start time (single forward pass over
 * both, so each word belongs to exactly one segment) and return, per segment,
 * the item index of its last live word — the token a mark can be appended to.
 * Segments with no live word yield null.
 */
export function segmentAnchors(items: EditItem[], segments: TranscriptSegment[]): (number | null)[] {
  const anchors: (number | null)[] = segments.map(() => null)
  let seg = 0
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.kind !== 'word') continue
    while (seg + 1 < segments.length && item.start >= segments[seg + 1].start) seg++
    if (isLiveWord(item)) anchors[seg] = i
  }
  return anchors
}

export interface PunctBatchEntry {
  segIndex: number
  /** Item index the mark would append to. */
  anchor: number
  /** items[anchor].text at enumeration — apply-time mismatch means stale. */
  anchorText: string
  /** Segment text rebuilt from current items (reflects the user's text edits). */
  text: string
}

export interface PunctBatch {
  /** Global number of the first entry; entry k is numbered offset + k. */
  offset: number
  entries: PunctBatchEntry[]
}

/**
 * Enumerate segments into numbered batches for the punct prompt. Segments with
 * no live word are skipped; so are segments whose anchor already ends with a
 * punctuation mark (the user or an earlier run punctuated it — re-asking is
 * noise). Numbering is continuous across batches so answers map back uniquely.
 */
export function punctBatches(
  items: EditItem[],
  segments: TranscriptSegment[],
  batchSize = PUNCT_BATCH_SIZE
): PunctBatch[] {
  const anchors = segmentAnchors(items, segments)
  const wordsBySeg: string[][] = segments.map(() => [])
  let seg = 0
  for (const item of items) {
    if (item.kind !== 'word') continue
    while (seg + 1 < segments.length && item.start >= segments[seg + 1].start) seg++
    if (isLiveWord(item)) wordsBySeg[seg].push(item.text)
  }
  const batches: PunctBatch[] = []
  let current: PunctBatchEntry[] = []
  let offset = 0
  for (let s = 0; s < segments.length; s++) {
    const anchor = anchors[s]
    if (anchor === null) continue
    const anchorText = items[anchor].text
    if ((PUNCT_MARKS as readonly string[]).includes(anchorText.slice(-1))) continue
    current.push({ segIndex: s, anchor, anchorText, text: joinTokens(wordsBySeg[s]) })
    if (current.length === batchSize) {
      batches.push({ offset, entries: current })
      offset += current.length
      current = []
    }
  }
  if (current.length > 0) batches.push({ offset, entries: current })
  return batches
}

export function serializePunctBatch(batch: PunctBatch): string {
  return batch.entries.map((e, k) => `${batch.offset + k}|${e.text}`).join('\n')
}

/** What the model returns per segment number. */
export interface PunctAnswer {
  n: number
  add: string
}

/**
 * Map model answers back to suggestions. Everything suspicious is dropped, not
 * repaired: numbers outside the batch, duplicate numbers (first wins), marks
 * outside the enum, and anchors whose text changed since enumeration (the user
 * edited mid-run). An empty mark means "flows on" — no suggestion.
 */
export function mapPunctAnswers(
  batch: PunctBatch,
  answers: PunctAnswer[],
  items: EditItem[],
  firstId = 0
): PunctSuggestion[] {
  const seen = new Set<number>()
  const out: PunctSuggestion[] = []
  for (const a of answers) {
    if (!Number.isInteger(a.n) || a.n < batch.offset || a.n >= batch.offset + batch.entries.length) continue
    if (seen.has(a.n)) continue
    seen.add(a.n)
    if (a.add === '') continue
    if (!(PUNCT_MARKS as readonly string[]).includes(a.add)) continue
    const entry = batch.entries[a.n - batch.offset]
    const item = items[entry.anchor]
    if (!item || item.kind !== 'word' || item.text !== entry.anchorText) continue
    out.push({
      kind: 'punct',
      id: firstId + out.length,
      source: 'llm',
      index: entry.anchor,
      anchorText: entry.anchorText,
      add: a.add,
      preview: `${entry.text}${a.add}`
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Apply — one ItemChange[] (= one undo step) through the existing helpers
// ---------------------------------------------------------------------------

/**
 * Turn accepted suggestions into a single reversible change set. Stale
 * suggestions (text changed underneath, or filler range already cut) are
 * skipped — the caller can diff counts to tell the user. Punct edits text only
 * and filler edits removed only, so changes never conflict on a field and
 * keptRanges is provably unaffected by punct (invariant-tested).
 */
export function suggestionChanges(items: EditItem[], accepted: Suggestion[]): ItemChange[] {
  const changes: ItemChange[] = []
  for (const s of accepted) {
    if (s.kind === 'punct') {
      const item = items[s.index]
      if (!item || item.kind !== 'word' || item.text !== s.anchorText) continue
      changes.push(...textEditChanges(items, s.index, s.anchorText + s.add))
    } else {
      const span = items.slice(s.index, s.endIndex + 1)
      if (span.length === 0 || joinTokens(span.map((it) => it.text)) !== s.text) continue
      if (span.every((it) => it.removed)) continue // already cut — toggle would restore
      changes.push(...toggleRangeChanges(items, s.index, s.endIndex))
    }
  }
  return changes
}

// ---------------------------------------------------------------------------
// LLM contract (spike-validated prompt + schema, consumed by main/llm.ts)
// ---------------------------------------------------------------------------

/** Spike v6 prompt — measured ~80–85% acceptable placement on real footage. */
export const PUNCT_SYSTEM = `You punctuate a verbatim speech transcript for captions. Input lines are consecutive transcript segments, "number|text", in speaking order. The segment boundaries follow the speaker's pauses.

For EVERY segment number, decide what punctuation mark belongs at the END of that segment:
- "。" the sentence ends here (use "？" for questions, "！" for exclamations)
- "，" the sentence continues into the next segment, with a natural pause
- ""  (empty) the text flows into the next segment mid-phrase — no mark

Return JSON: {"marks":[{"n":<segment number>,"add":"。"|"？"|"！"|"，"|""}, ...]} with ONE entry per input segment, in order. Use the transcript's own language conventions (for Latin-script text use . ? ! ,). Do not translate, do not rewrite.`

/** Ollama structured-output schema: `add` is REQUIRED and enum'd (v4 lesson — optional fields get omitted). */
export const PUNCT_FORMAT = {
  type: 'object',
  properties: {
    marks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          n: { type: 'integer' },
          add: { type: 'string', enum: [...PUNCT_MARKS, ''] }
        },
        required: ['n', 'add']
      }
    }
  },
  required: ['marks']
} as const
