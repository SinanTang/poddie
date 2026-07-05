import { describe, expect, test } from 'vitest'
import {
  applyChanges,
  deriveItems,
  keptRanges,
  removedRanges,
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
      { index: 2, prev: false, next: true },
      { index: 3, prev: false, next: true }
    ])
  })

  test('fully-removed selection → restore everything', () => {
    const items = derive().map((i) => ({ ...i, removed: true }))
    const changes = toggleRangeChanges(items, 0, 5)
    expect(changes).toHaveLength(6)
    expect(changes.every((c) => !c.next)).toBe(true)
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
