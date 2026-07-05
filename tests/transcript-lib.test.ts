import { describe, expect, test } from 'vitest'
import { buildParagraphs, buildSearchIndex, findMatches, findWordAtTime } from '../src/renderer/src/lib/transcript'
import type { TranscriptWord } from '../src/shared/types'

function w(text: string, start: number, end?: number): TranscriptWord {
  return { text, start, end: end ?? start + 0.2 }
}

describe('search across token boundaries', () => {
  const cjkWords = [w('给', 0), w('审', 0.2), w('计', 0.4), w('机', 0.6), w('构', 0.8), w('审', 1.0), w('计', 1.2)]

  test('multi-character CJK query maps to the word range', () => {
    const index = buildSearchIndex(cjkWords)
    const matches = findMatches(index, '审计')
    expect(matches).toEqual([
      { startWord: 1, endWord: 2 },
      { startWord: 5, endWord: 6 }
    ])
  })

  test('multi-word English query with spaces matches joined text', () => {
    const enWords = [w('so', 0), w('you', 0.3), w('know', 0.6), w('right', 0.9)]
    const matches = findMatches(buildSearchIndex(enWords), 'You Know')
    expect(matches).toEqual([{ startWord: 1, endWord: 2 }])
  })

  test('mixed zh/en query spanning the language boundary', () => {
    const mixed = [w('叫', 0), w('思', 0.2), w('楠', 0.4), w('OK', 0.6), w('大', 0.8)]
    const matches = findMatches(buildSearchIndex(mixed), '楠 ok')
    expect(matches).toEqual([{ startWord: 2, endWord: 3 }])
  })

  test('empty query matches nothing', () => {
    expect(findMatches(buildSearchIndex(cjkWords), '  ')).toEqual([])
  })
})

describe('findWordAtTime', () => {
  const words = [w('a', 1.0, 1.4), w('b', 2.0, 2.4), w('c', 3.0, 3.4)]

  test('before the first word → -1', () => {
    expect(findWordAtTime(words, 0.5)).toBe(-1)
  })

  test('inside and between words → last started word', () => {
    expect(findWordAtTime(words, 1.2)).toBe(0)
    expect(findWordAtTime(words, 1.7)).toBe(0)
    expect(findWordAtTime(words, 2.0)).toBe(1)
  })

  test('after the last word → last index', () => {
    expect(findWordAtTime(words, 99)).toBe(2)
  })
})

describe('buildParagraphs', () => {
  test('merges short segments up to a readable minimum and keeps leftovers', () => {
    const words = Array.from({ length: 120 }, (_, i) => w(`w${i}`, i))
    const segments = [
      { text: 's1', start: 0, end: 30 },
      { text: 's2', start: 30, end: 60 },
      { text: 's3', start: 60, end: 115 },
      { text: 's4', start: 115, end: 120 }
    ]
    const paras = buildParagraphs(words, segments)
    // s1 (30 words) is under the minimum → merged with s2 (60 total), s3 flushes at 55, s4 leftovers
    expect(paras.map((p) => [p.from, p.to])).toEqual([
      [0, 60],
      [60, 115],
      [115, 120]
    ])
    // full coverage, no overlaps
    expect(paras[0].from).toBe(0)
    expect(paras[paras.length - 1].to).toBe(words.length)
  })

  test('no segments → one paragraph', () => {
    const words = [w('a', 0), w('b', 1)]
    expect(buildParagraphs(words, [])).toEqual([{ startSec: 0, from: 0, to: 2 }])
  })
})
