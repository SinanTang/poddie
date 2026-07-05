import { describe, expect, test } from 'vitest'
import {
  applyChanges,
  deriveItems,
  keptRanges,
  mergeWithPrevChanges,
  removedRanges,
  textEditChanges,
  toggleRangeChanges,
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
