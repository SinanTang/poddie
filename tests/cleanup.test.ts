import { describe, expect, test } from 'vitest'
import {
  findFillerSuggestions,
  mapPunctAnswers,
  punctBatches,
  segmentAnchors,
  serializePunctBatch,
  suggestionChanges,
  type PunctSuggestion
} from '../src/shared/cleanup'
import { applyChanges, deriveItems, keptRanges, removedRanges } from '../src/shared/edit'
import type { TranscriptSegment, TranscriptWord } from '../src/shared/types'

function w(text: string, start: number, end: number): TranscriptWord {
  return { text, start, end }
}

function seg(start: number, end: number): TranscriptSegment {
  return { text: '', start, end }
}

// Contiguous CJK char-tokens (whisper zh shape) + a Latin run, no internal gaps
function zhWords(texts: string[], startAt = 1.0): TranscriptWord[] {
  return texts.map((t, i) => w(t, startAt + i * 0.2, startAt + i * 0.2 + 0.15))
}

describe('findFillerSuggestions', () => {
  test('matches single- and multi-token zh fillers over char tokens', () => {
    const words = zhWords(['嗯', '我', '们', '那', '个', '问', '题'])
    const items = deriveItems(words, 5)
    const found = findFillerSuggestions(items)
    expect(found.map((f) => f.text)).toEqual(['嗯', '那个'])
    const nage = found[1]
    expect(items.slice(nage.index, nage.endIndex + 1).map((i) => i.text)).toEqual(['那', '个'])
  })

  test('longest entry wins (就是说 beats 就是)', () => {
    const items = deriveItems(zhWords(['就', '是', '说', '对']), 5)
    const found = findFillerSuggestions(items)
    expect(found.map((f) => f.text)).toEqual(['就是说'])
  })

  test('matches multi-word Latin fillers case-insensitively, whole tokens only', () => {
    const words = [w('You', 1.0, 1.2), w('know', 1.25, 1.5), w('likes', 1.55, 1.8), w('Um', 1.85, 2.0)]
    const items = deriveItems(words, 5)
    const found = findFillerSuggestions(items)
    expect(found.map((f) => f.text)).toEqual(['You know', 'Um']) // "likes" ≠ "like"
  })

  test('a gap token breaks the run — never match across an audible pause', () => {
    const words = [w('那', 1.0, 1.2), w('个', 2.0, 2.2)] // 0.8 s apart → gap item between
    const items = deriveItems(words, 5)
    expect(items.map((i) => i.kind)).toContain('gap')
    expect(findFillerSuggestions(items).map((f) => f.text)).toEqual([])
  })

  test('removed and blanked words break the run and are never suggested', () => {
    const items = deriveItems(zhWords(['那', '个', '嗯']), 5)
    const naIdx = items.findIndex((i) => i.text === '个')
    const removed = items.map((it, i) => (i === naIdx ? { ...it, removed: true } : it))
    expect(findFillerSuggestions(removed).map((f) => f.text)).toEqual(['嗯'])
    const blanked = items.map((it, i) => (i === naIdx ? { ...it, text: '' } : it))
    expect(findFillerSuggestions(blanked).map((f) => f.text)).toEqual(['嗯'])
  })

  test('matches never overlap and ids are sequential from firstId', () => {
    const items = deriveItems(zhWords(['就', '是', '就', '是']), 5)
    const found = findFillerSuggestions(items, undefined, 10)
    expect(found.map((f) => f.text)).toEqual(['就是', '就是'])
    expect(found.map((f) => f.id)).toEqual([10, 11])
  })

  test('preview brackets the candidate with joined context', () => {
    const items = deriveItems(zhWords(['我', '们', '嗯', '走', '吧']), 5)
    const [found] = findFillerSuggestions(items)
    expect(found.preview).toBe('我们【嗯】走吧')
  })
})

// words: a in seg0; b c in seg1 (assignment is by segment START times)
const ANCHOR_WORDS = [w('a', 1.0, 1.5), w('b', 2.1, 2.5), w('c', 2.6, 3.5)]
const SEGS = [seg(0.9, 2.0), seg(2.05, 3.6)]

describe('segmentAnchors', () => {
  test('last live word per segment, by start-time assignment', () => {
    const items = deriveItems(ANCHOR_WORDS, 5)
    const [a0, a1] = segmentAnchors(items, SEGS)
    expect(items[a0!].text).toBe('a')
    expect(items[a1!].text).toBe('c')
  })

  test('removed/blanked words are skipped; empty segment yields null', () => {
    const items = deriveItems(ANCHOR_WORDS, 5).map((it) => (it.text === 'c' ? { ...it, removed: true } : it))
    const [, a1] = segmentAnchors(items, SEGS)
    expect(items[a1!].text).toBe('b')
    const allDead = items.map((it) => (it.kind === 'word' ? { ...it, removed: true } : it))
    expect(segmentAnchors(allDead, SEGS)).toEqual([null, null])
  })
})

describe('punctBatches', () => {
  test('numbers entries continuously, splits by batch size, serializes as index|text', () => {
    const words = [w('早', 1.0, 1.2), w('上', 1.21, 1.4), w('好', 2.1, 2.3), w('吗', 2.31, 2.5), w('走', 3.0, 3.2)]
    const segs = [seg(0.9, 2.0), seg(2.05, 2.9), seg(2.95, 3.5)]
    const items = deriveItems(words, 5)
    const batches = punctBatches(items, segs, 2)
    expect(batches.map((b) => b.offset)).toEqual([0, 2])
    expect(batches[0].entries.map((e) => e.text)).toEqual(['早上', '好吗'])
    expect(serializePunctBatch(batches[0])).toBe('0|早上\n1|好吗')
    expect(serializePunctBatch(batches[1])).toBe('2|走')
  })

  test('skips empty segments and anchors that already end punctuated; text reflects edits', () => {
    const words = [w('早', 1.0, 1.2), w('好', 2.1, 2.3), w('走', 3.0, 3.2)]
    const segs = [seg(0.9, 2.0), seg(2.05, 2.9), seg(2.95, 3.5)]
    let items = deriveItems(words, 5)
    items = items.map((it) => (it.text === '早' ? { ...it, text: '早。' } : it)) // user already punctuated
    items = items.map((it) => (it.text === '好' ? { ...it, removed: true } : it)) // seg1 now empty
    items = items.map((it) => (it.text === '走' ? { ...it, text: '走了' } : it)) // edited text
    const batches = punctBatches(items, segs, 40)
    expect(batches).toHaveLength(1)
    expect(batches[0].entries.map((e) => e.text)).toEqual(['走了'])
    expect(batches[0].entries[0].anchorText).toBe('走了')
  })
})

describe('mapPunctAnswers', () => {
  const words = [w('早', 1.0, 1.2), w('好', 2.1, 2.3)]
  const segs = [seg(0.9, 2.0), seg(2.05, 2.9)]
  const items = deriveItems(words, 5)
  const [batch] = punctBatches(items, segs, 40)

  test('maps valid answers; drops out-of-range, duplicate, empty, and unknown marks', () => {
    const found = mapPunctAnswers(
      batch,
      [
        { n: 0, add: '，' },
        { n: 0, add: '。' }, // dup — first wins
        { n: 1, add: '' }, // flows on — no suggestion
        { n: 7, add: '。' }, // out of range
        { n: 1, add: '~' } // dup n AND unknown mark
      ],
      items,
      5
    )
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ id: 5, add: '，', anchorText: '早', preview: '早，' })
  })

  test('drops answers whose anchor text changed since enumeration', () => {
    const edited = items.map((it) => (it.text === '早' ? { ...it, text: '晨' } : it))
    expect(mapPunctAnswers(batch, [{ n: 0, add: '。' }], edited)).toEqual([])
  })
})

describe('suggestionChanges', () => {
  const words = [w('早', 1.0, 1.2), w('那', 2.1, 2.3), w('个', 2.31, 2.5), w('走', 3.0, 3.2)]
  const segs = [seg(0.9, 3.5)]
  const items = deriveItems(words, 5)

  function punctSuggestion(): PunctSuggestion {
    const [batch] = punctBatches(items, segs, 40)
    const [s] = mapPunctAnswers(batch, [{ n: 0, add: '。' }], items)
    return s
  }

  test('punct appends to text and NEVER changes keptRanges (byte-identical export)', () => {
    const before = keptRanges(items, 5)
    const after = applyChanges(items, suggestionChanges(items, [punctSuggestion()]), 'next')
    expect(after.find((i) => i.text === '走。')).toBeTruthy()
    expect(keptRanges(after, 5)).toEqual(before)
    expect(after.map((i) => ({ s: i.start, e: i.end, r: i.removed }))).toEqual(
      items.map((i) => ({ s: i.start, e: i.end, r: i.removed }))
    )
  })

  test('filler marks its range removed; applying is one reversible change set', () => {
    const [filler] = findFillerSuggestions(items)
    expect(filler.text).toBe('那个')
    const changes = suggestionChanges(items, [filler])
    const after = applyChanges(items, changes, 'next')
    expect(removedRanges(after)).toEqual([{ start: 2.1, end: 2.5 }])
    expect(applyChanges(after, changes, 'prev')).toEqual(items)
  })

  test('stale suggestions are skipped, never misapplied', () => {
    const punct = punctSuggestion()
    const [filler] = findFillerSuggestions(items)
    const edited = items.map((it) => (it.text === '走' ? { ...it, text: '跑' } : it))
    expect(suggestionChanges(edited, [punct])).toEqual([])
    const cutAlready = items.map((it) => (it.text === '那' || it.text === '个' ? { ...it, removed: true } : it))
    expect(suggestionChanges(cutAlready, [filler])).toEqual([]) // toggle would RESTORE — must skip
    const blanked = items.map((it) => (it.text === '个' ? { ...it, text: '' } : it))
    expect(suggestionChanges(blanked, [filler])).toEqual([])
  })

  test('punct + filler combine into one change list without field conflicts', () => {
    const [filler] = findFillerSuggestions(items)
    const changes = suggestionChanges(items, [punctSuggestion(), filler])
    const after = applyChanges(items, changes, 'next')
    expect(after.find((i) => i.text === '走。')).toBeTruthy()
    expect(removedRanges(after)).toEqual([{ start: 2.1, end: 2.5 }])
    expect(applyChanges(after, changes, 'prev')).toEqual(items)
  })
})
