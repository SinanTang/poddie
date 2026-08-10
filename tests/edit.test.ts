import { describe, expect, test } from 'vitest'
import {
  applyChanges,
  deriveItems,
  keptRanges,
  mergeWithPrevChanges,
  removedRanges,
  setCutSpanChanges,
  textEditChanges,
  toggleRangeChanges,
  trimSilenceChanges,
  type EditItem
} from '../src/shared/edit'
import type { TranscriptWord } from '../src/shared/types'

function w(text: string, start: number, end: number): TranscriptWord {
  return { text, start, end }
}

// leading silence [0, 1.0], words with a 0.6 s mid gap and a 0.1 s micro-gap, tail [3.5, 5.0]
const WORDS = [w('a', 1.0, 1.5), w('b', 2.1, 2.5), w('c', 2.6, 3.5)]
const DURATION = 5.0

function derive(): EditItem[] {
  return deriveItems(WORDS, DURATION)
}

describe('deriveItems', () => {
  test('interleaves gap tokens for silences ≥ threshold, skips micro-gaps', () => {
    const items = derive()
    expect(items.map((i) => i.kind)).toEqual(['gap', 'word', 'gap', 'word', 'word', 'gap'])
    expect(items[0]).toMatchObject({ start: 0, end: 1.0 }) // lead-in
    expect(items[2]).toMatchObject({ start: 1.5, end: 2.1 }) // 0.6 s mid gap
    expect(items[5]).toMatchObject({ start: 3.5, end: 5.0 }) // tail
    // 0.1 s between b and c → no gap token
  })

  test('empty transcript → one deletable gap covering everything', () => {
    expect(deriveItems([], 10)).toEqual([{ kind: 'gap', text: '', start: 0, end: 10, removed: false }])
  })

  test('everything starts kept', () => {
    expect(derive().every((i) => !i.removed)).toBe(true)
  })
})

describe('removedRanges / keptRanges', () => {
  test('no edits → nothing removed, one full kept range', () => {
    const items = derive()
    expect(removedRanges(items)).toEqual([])
    expect(keptRanges(items, DURATION)).toEqual([{ start: 0, end: DURATION }])
  })

  test('everything removed → no kept ranges', () => {
    const items = derive().map((i) => ({ ...i, removed: true }))
    expect(keptRanges(items, DURATION)).toEqual([])
  })

  test('adjacent removed items merge into one range', () => {
    const items = derive()
    items[1] = { ...items[1], removed: true } // word a [1.0, 1.5]
    items[2] = { ...items[2], removed: true } // gap [1.5, 2.1]
    expect(removedRanges(items)).toEqual([{ start: 1.0, end: 2.1 }])
    expect(keptRanges(items, DURATION)).toEqual([
      { start: 0, end: 1.0 },
      { start: 2.1, end: DURATION }
    ])
  })

  test('micro-hole between removed neighbors is absorbed, kept sliver dropped', () => {
    const items = derive()
    items[3] = { ...items[3], removed: true } // word b [2.1, 2.5]
    items[4] = { ...items[4], removed: true } // word c [2.6, 3.5] — 0.1 s hole between them
    expect(removedRanges(items)).toEqual([{ start: 2.1, end: 3.5 }])
    expect(keptRanges(items, DURATION)).toEqual([
      { start: 0, end: 2.1 },
      { start: 3.5, end: DURATION }
    ])
  })

  test('non-adjacent removals stay separate ranges', () => {
    const items = derive()
    items[0] = { ...items[0], removed: true } // lead-in [0, 1.0]
    items[5] = { ...items[5], removed: true } // tail [3.5, 5.0]
    expect(removedRanges(items)).toEqual([
      { start: 0, end: 1.0 },
      { start: 3.5, end: 5.0 }
    ])
    expect(keptRanges(items, DURATION)).toEqual([{ start: 1.0, end: 3.5 }])
  })
})

describe('toggleRangeChanges (delete-key semantics)', () => {
  test('mixed selection → remove everything still kept', () => {
    const items = derive()
    items[1] = { ...items[1], removed: true }
    const changes = toggleRangeChanges(items, 1, 3)
    expect(changes).toEqual([
      { index: 2, prev: { removed: false }, next: { removed: true } },
      { index: 3, prev: { removed: false }, next: { removed: true } }
    ])
  })

  test('fully-removed selection → restore everything', () => {
    const items = derive().map((i) => ({ ...i, removed: true }))
    const changes = toggleRangeChanges(items, 0, 5)
    expect(changes).toHaveLength(6)
    expect(changes.every((c) => c.next.removed === false)).toBe(true)
  })

  test('reversed and out-of-bounds selections are clamped', () => {
    const items = derive()
    expect(toggleRangeChanges(items, 99, -5)).toHaveLength(items.length)
  })
})

describe('applyChanges', () => {
  test('next applies, prev reverts (undo), original array untouched', () => {
    const items = derive()
    const changes = toggleRangeChanges(items, 1, 2)
    const applied = applyChanges(items, changes, 'next')
    expect(applied[1].removed).toBe(true)
    expect(applied[2].removed).toBe(true)
    expect(items[1].removed).toBe(false) // immutability

    const reverted = applyChanges(applied, changes, 'prev')
    expect(reverted.map((i) => i.removed)).toEqual(items.map((i) => i.removed))
  })
})

describe('textEditChanges', () => {
  test('changing a word produces one reversible text patch', () => {
    const items = derive()
    const changes = textEditChanges(items, 1, 'a,')
    expect(changes).toEqual([{ index: 1, prev: { text: 'a' }, next: { text: 'a,' } }])
    const applied = applyChanges(items, changes, 'next')
    expect(applied[1].text).toBe('a,')
    expect(applyChanges(applied, changes, 'prev')[1].text).toBe('a')
  })

  test('no-op text and gap tokens produce no changes', () => {
    const items = derive()
    expect(textEditChanges(items, 1, 'a')).toEqual([])
    expect(textEditChanges(items, 0, 'x')).toEqual([]) // gap
    expect(textEditChanges(items, 99, 'x')).toEqual([])
  })
})

describe('mergeWithPrevChanges', () => {
  // words b [2.1, 2.5] and c [2.6, 3.5] are adjacent items (indices 3, 4)
  test('merges into previous word: text concat, end = union, current blanked', () => {
    const items = derive()
    const merged = applyChanges(items, mergeWithPrevChanges(items, 4), 'next')
    expect(merged[3]).toMatchObject({ text: 'bc', start: 2.1, end: 3.5 })
    expect(merged[4]).toMatchObject({ text: '', start: 2.6, end: 3.5 }) // span kept, display blanked
  })

  test('undo restores both tokens exactly', () => {
    const items = derive()
    const changes = mergeWithPrevChanges(items, 4)
    const roundTrip = applyChanges(applyChanges(items, changes, 'next'), changes, 'prev')
    expect(roundTrip).toEqual(items)
  })

  test('skips blanked words from earlier merges (chain "cons ult ing")', () => {
    const words = [w('cons', 1.0, 1.2), w('ult', 1.2, 1.4), w('ing', 1.4, 1.6)]
    let items = deriveItems(words, 2.0)
    const wordAt = (text: string): number => items.findIndex((i) => i.text === text)
    items = applyChanges(items, mergeWithPrevChanges(items, wordAt('ult')), 'next')
    items = applyChanges(items, mergeWithPrevChanges(items, wordAt('ing')), 'next')
    expect(items.filter((i) => i.kind === 'word' && i.text !== '')).toEqual([
      { kind: 'word', text: 'consulting', start: 1.0, end: 1.6, removed: false }
    ])
  })

  test('refuses to merge across a gap token, at the first word, or on gaps', () => {
    const items = derive()
    expect(mergeWithPrevChanges(items, 3)).toEqual([]) // word b — previous item is the 0.6 s gap
    expect(mergeWithPrevChanges(items, 1)).toEqual([]) // first word — nothing before but a gap
    expect(mergeWithPrevChanges(items, 2)).toEqual([]) // gap token itself
  })

  test('textOverride merges the in-flight draft, not the stale token text', () => {
    const items = derive()
    const merged = applyChanges(items, mergeWithPrevChanges(items, 4, 'C!'), 'next')
    expect(merged[3].text).toBe('bC!')
  })
})

describe('trimSilenceChanges', () => {
  // derived items: gap[0,1.0] lead-in, a, gap[1.5,2.1], b, c, gap[3.5,5.0] tail
  test('trims long gaps with padding on speech-adjacent sides only', () => {
    const items = derive()
    const changes = trimSilenceChanges(items)
    expect(changes.map((c) => c.index)).toEqual([0, 5]) // lead-in + tail; the 0.6 s mid gap is below 0.75
    // lead-in: no pad at the file start, pad before word a
    expect(changes[0].next).toEqual({ removed: true, start: 0, end: 0.85 })
    // tail: pad after word c, no pad at the file end
    expect(changes[1].next).toEqual({ removed: true, start: 3.65, end: 5.0 })
  })

  test('cuts land mid-silence, never on word edges', () => {
    const items = derive()
    const trimmed = applyChanges(items, trimSilenceChanges(items), 'next')
    // word a spans [1.0, 1.5]; the lead-in cut ends 0.15 before it
    expect(keptRanges(trimmed, DURATION)[0]).toEqual({ start: 0.85, end: 3.65 })
  })

  test('skips short, already-removed, and word items', () => {
    const items = derive()
    items[5] = { ...items[5], removed: true } // tail already cut by hand
    const changes = trimSilenceChanges(items)
    expect(changes.map((c) => c.index)).toEqual([0])
  })

  test('lower threshold catches the mid gap too', () => {
    const items = derive()
    const changes = trimSilenceChanges(items, 0.5)
    expect(changes.map((c) => c.index)).toEqual([0, 2, 5])
    expect(changes[1].next.removed).toBe(true)
    expect(changes[1].next.start).toBeCloseTo(1.65, 10) // padded both sides
    expect(changes[1].next.end).toBeCloseTo(1.95, 10)
  })

  test('skips a gap the padding would fully consume', () => {
    const gapOnly: EditItem[] = [
      { kind: 'word', text: 'a', start: 0, end: 1, removed: false },
      { kind: 'gap', text: '', start: 1, end: 1.8, removed: false },
      { kind: 'word', text: 'b', start: 1.8, end: 2, removed: false }
    ]
    expect(trimSilenceChanges(gapOnly, 0.75, 0.4)).toEqual([]) // 0.8 s gap − 2×0.4 pad → nothing left
  })

  test('one undo restores the original silences exactly', () => {
    const items = derive()
    const changes = trimSilenceChanges(items)
    const roundTrip = applyChanges(applyChanges(items, changes, 'next'), changes, 'prev')
    expect(roundTrip).toEqual(items)
  })
})

describe('setCutSpanChanges (draggable cut edges)', () => {
  // four contiguous words, no gap tokens; a cut over B+C reads as one region [1,3]
  const base = (): EditItem[] => [
    { kind: 'word', text: 'A', start: 0, end: 1, removed: false },
    { kind: 'word', text: 'B', start: 1, end: 2, removed: true },
    { kind: 'word', text: 'C', start: 2, end: 3, removed: true },
    { kind: 'word', text: 'D', start: 3, end: 4, removed: false }
  ]
  const resized = (items: EditItem[], os: number, oe: number, ns: number, ne: number): EditItem[] =>
    applyChanges(items, setCutSpanChanges(items, os, oe, ns, ne), 'next')

  test('removedRanges honours cutStart/cutEnd overrides', () => {
    const items = base()
    items[1] = { ...items[1], cutStart: 1.4 }
    items[2] = { ...items[2], cutEnd: 2.6 }
    expect(removedRanges(items)).toEqual([{ start: 1.4, end: 2.6 }])
  })

  test('shrinking a boundary edge writes a partial cut on that token only', () => {
    const items = resized(base(), 1, 3, 1.4, 3)
    expect(items[1].cutStart).toBe(1.4)
    expect(items[2].cutStart).toBeUndefined()
    expect(removedRanges(items)).toEqual([{ start: 1.4, end: 3 }])
  })

  test('extending an edge into a kept neighbour removes it with a partial boundary', () => {
    const items = resized(base(), 1, 3, 0.5, 3)
    expect(items[0]).toMatchObject({ removed: true, cutStart: 0.5 })
    expect(removedRanges(items)).toEqual([{ start: 0.5, end: 3 }])
  })

  test('shrinking past a token restores it and clears its override', () => {
    let items = resized(base(), 1, 3, 1, 2.4) // C now partial [2,2.4]
    expect(items[2]).toMatchObject({ removed: true, cutEnd: 2.4 })
    items = resized(items, 1, 2.4, 1, 1.8) // pull inside B → C fully exposed
    expect(items[2]).toMatchObject({ removed: false })
    expect(items[2].cutEnd).toBeUndefined()
    expect(removedRanges(items)).toEqual([{ start: 1, end: 1.8 }])
  })

  test('interior cut: both edges inside one token keep the ends, drop the middle', () => {
    const gap: EditItem[] = [{ kind: 'gap', text: '', start: 0, end: 10, removed: true }]
    const items = resized(gap, 0, 10, 3, 7)
    expect(items[0]).toMatchObject({ cutStart: 3, cutEnd: 7 })
    expect(keptRanges(items, 10)).toEqual([{ start: 0, end: 3 }, { start: 7, end: 10 }])
  })

  test('undo restores the exact prior state including cleared overrides', () => {
    const items = base()
    const changes = setCutSpanChanges(items, 1, 3, 0.5, 2.4)
    const forward = applyChanges(items, changes, 'next')
    const back = applyChanges(forward, changes, 'prev')
    expect(back).toEqual(items)
  })
})

describe('invariant: text edits never move audio', () => {
  test('keptRanges identical before and after edits + merges (export stays byte-identical)', () => {
    const items = derive()
    items[2] = { ...items[2], removed: true } // a real cut, so kept ranges are non-trivial
    const before = keptRanges(items, DURATION)

    let edited = applyChanges(items, textEditChanges(items, 1, 'A, rewritten'), 'next')
    edited = applyChanges(edited, mergeWithPrevChanges(edited, 4), 'next')
    expect(keptRanges(edited, DURATION)).toEqual(before)
    expect(removedRanges(edited)).toEqual(removedRanges(items))
  })
})
