import type { TranscriptWord } from './types'

/** Inter-word silences at or above this length become visible, deletable gap tokens. */
export const GAP_MIN_SEC = 0.35

export type EditItemKind = 'word' | 'gap'

export interface EditItem {
  kind: EditItemKind
  /** Display text for words; '' for gaps. */
  text: string
  start: number
  end: number
  removed: boolean
}

export interface EditState {
  version: 1
  gapMinSec: number
  items: EditItem[]
}

export interface TimeRange {
  start: number
  end: number
}

/**
 * Build the editable item sequence: words interleaved with gap tokens for
 * every silence ≥ gapMinSec (including lead-in and tail). Words, silences,
 * fillers — every edit is just "mark items removed", one code path.
 */
export function deriveItems(words: TranscriptWord[], durationSec: number, gapMinSec = GAP_MIN_SEC): EditItem[] {
  const items: EditItem[] = []
  const pushGap = (start: number, end: number): void => {
    if (end - start >= gapMinSec) items.push({ kind: 'gap', text: '', start, end, removed: false })
  }

  if (words.length === 0) {
    pushGap(0, durationSec)
    return items
  }

  pushGap(0, words[0].start)
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    items.push({ kind: 'word', text: w.text, start: w.start, end: Math.max(w.end, w.start), removed: false })
    const nextStart = i + 1 < words.length ? words[i + 1].start : durationSec
    pushGap(w.end, nextStart)
  }
  return items
}

/**
 * Merged removed time ranges. Micro-holes between adjacent removed items
 * (sub-threshold word spacing that never became a gap token) are absorbed —
 * removing both neighboring words shouldn't leave a 0.2 s silence orphan.
 */
export function removedRanges(items: EditItem[], gapMinSec = GAP_MIN_SEC): TimeRange[] {
  const ranges: TimeRange[] = []
  for (const item of items) {
    if (!item.removed) continue
    const last = ranges[ranges.length - 1]
    if (last && item.start - last.end < gapMinSec) {
      last.end = Math.max(last.end, item.end)
    } else {
      ranges.push({ start: item.start, end: item.end })
    }
  }
  return ranges
}

const MIN_KEPT_SLIVER_SEC = 0.05

/**
 * The single derived artifact everything consumes (preview skipping, waveform
 * shading, export graph, caption remapping): complement of the removed ranges
 * over [0, durationSec], with unplayable slivers dropped.
 */
export function keptRanges(items: EditItem[], durationSec: number, gapMinSec = GAP_MIN_SEC): TimeRange[] {
  const kept: TimeRange[] = []
  let cursor = 0
  for (const cut of removedRanges(items, gapMinSec)) {
    if (cut.start - cursor >= MIN_KEPT_SLIVER_SEC) kept.push({ start: cursor, end: cut.start })
    cursor = Math.max(cursor, cut.end)
  }
  if (durationSec - cursor >= MIN_KEPT_SLIVER_SEC) kept.push({ start: cursor, end: durationSec })
  return kept
}

/**
 * A reversible field patch on one item. Cut/restore, text edits, and token
 * merges are all the same operation: "these fields change on this index" —
 * one undo/redo code path, and the item COUNT never changes so indices in
 * history stay valid forever.
 */
export type ItemPatch = Partial<Omit<EditItem, 'kind'>>

export interface ItemChange {
  index: number
  prev: ItemPatch
  next: ItemPatch
}

/**
 * Delete-key semantics for a selection [from, to]: if anything in it is still
 * kept → remove everything; if it's already fully removed → restore everything.
 */
export function toggleRangeChanges(items: EditItem[], from: number, to: number): ItemChange[] {
  const lo = Math.max(0, Math.min(from, to))
  const hi = Math.min(items.length - 1, Math.max(from, to))
  let anyKept = false
  for (let i = lo; i <= hi; i++) {
    if (!items[i].removed) {
      anyKept = true
      break
    }
  }
  const next = anyKept
  const changes: ItemChange[] = []
  for (let i = lo; i <= hi; i++) {
    if (items[i].removed !== next) {
      changes.push({ index: i, prev: { removed: items[i].removed }, next: { removed: next } })
    }
  }
  return changes
}

/**
 * INVARIANT: text is decorative. Cuts, keptRanges, and the export graph derive
 * from time spans + `removed` only — a text edit or token merge must never
 * shift audio (export stays byte-identical). Enforced by tests.
 */
export function textEditChanges(items: EditItem[], index: number, text: string): ItemChange[] {
  const item = items[index]
  if (!item || item.kind !== 'word' || item.text === text) return []
  return [{ index, prev: { text: item.text }, next: { text } }]
}

/**
 * Fix Whisper mis-splits ("cons"+"ult" → "consult"): concatenate this word's
 * text into the previous word and blank this one's display text. Both items
 * KEEP their time spans (audio untouched); the merged word's end extends over
 * this one so click-to-seek and caption timing cover the union. Blanked words
 * (already merged away) are skipped over; a gap token blocks merging — don't
 * silently join words across an audible silence.
 */
export function mergeWithPrevChanges(items: EditItem[], index: number, textOverride?: string): ItemChange[] {
  const item = items[index]
  const text = textOverride ?? item?.text
  if (!item || item.kind !== 'word' || !text) return []
  let p = index - 1
  while (p >= 0 && items[p].kind === 'word' && items[p].text === '') p--
  if (p < 0 || items[p].kind !== 'word') return []
  const prev = items[p]
  return [
    { index: p, prev: { text: prev.text, end: prev.end }, next: { text: prev.text + text, end: Math.max(prev.end, item.end) } },
    { index, prev: { text: item.text }, next: { text: '' } }
  ]
}

export function applyChanges(items: EditItem[], changes: ItemChange[], direction: 'next' | 'prev'): EditItem[] {
  if (changes.length === 0) return items
  const out = items.slice()
  for (const c of changes) {
    out[c.index] = { ...out[c.index], ...(direction === 'next' ? c.next : c.prev) }
  }
  return out
}
