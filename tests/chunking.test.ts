import { describe, expect, test } from 'vitest'
import { CHUNK_TARGET_BYTES, parseSilences, planChunks, stitchWords } from '../src/main/chunking'

describe('parseSilences', () => {
  test('parses silencedetect stderr pairs', () => {
    const stderr = [
      'Input #0, mov,mp4,m4a, from cache.m4a:',
      '[silencedetect @ 0x600] silence_start: 12.5',
      '[silencedetect @ 0x600] silence_end: 13.4 | silence_duration: 0.9',
      'frame= 100',
      '[silencedetect @ 0x600] silence_start: 600.25',
      '[silencedetect @ 0x600] silence_end: 601.0 | silence_duration: 0.75'
    ].join('\n')
    expect(parseSilences(stderr)).toEqual([
      { start: 12.5, end: 13.4 },
      { start: 600.25, end: 601.0 }
    ])
  })

  test('ignores an unmatched trailing silence_start', () => {
    expect(parseSilences('[silencedetect] silence_start: 5.0')).toEqual([])
  })
})

describe('planChunks', () => {
  test('single chunk when under the size cap', () => {
    expect(planChunks(3600, CHUNK_TARGET_BYTES - 1, [])).toEqual([{ start: 0, end: 3600 }])
  })

  test('splits oversized audio and snaps cuts to nearby silence midpoints', () => {
    // 2× the cap → 2 chunks, ideal cut at 1800 s; silence at 1790–1794 (mid 1792) is within ±30 s
    const silences = [
      { start: 100, end: 101 },
      { start: 1790, end: 1794 }
    ]
    const ranges = planChunks(3600, CHUNK_TARGET_BYTES * 2, silences)
    expect(ranges).toEqual([
      { start: 0, end: 1792 },
      { start: 1792, end: 3600 }
    ])
  })

  test('falls back to equal splits when no silence is near the boundary', () => {
    const ranges = planChunks(3000, CHUNK_TARGET_BYTES * 3, [])
    expect(ranges).toEqual([
      { start: 0, end: 1000 },
      { start: 1000, end: 2000 },
      { start: 2000, end: 3000 }
    ])
  })

  test('chunks are contiguous and cover the full duration', () => {
    const ranges = planChunks(7200, CHUNK_TARGET_BYTES * 4.5, [{ start: 1600, end: 1601 }])
    expect(ranges[0].start).toBe(0)
    expect(ranges[ranges.length - 1].end).toBe(7200)
    for (let i = 1; i < ranges.length; i++) expect(ranges[i].start).toBe(ranges[i - 1].end)
  })
})

describe('stitchWords', () => {
  test('offsets chunk-local times to absolute times', () => {
    const out = stitchWords([
      { offset: 0, words: [{ word: ' Hello', start: 0.5, end: 0.9 }] },
      { offset: 100, words: [{ word: ' world', start: 1.0, end: 1.4 }] }
    ])
    expect(out).toEqual([
      { text: 'Hello', start: 0.5, end: 0.9 },
      { text: 'world', start: 101.0, end: 101.4 }
    ])
  })

  test('drops words overlapping the previous chunk tail and whitespace tokens', () => {
    const out = stitchWords([
      { offset: 0, words: [{ word: 'end', start: 99.5, end: 100.2 }] },
      {
        offset: 100,
        words: [
          { word: 'end', start: 0.0, end: 0.2 }, // duplicate straddling the seam
          { word: '  ', start: 0.3, end: 0.4 }, // whitespace-only
          { word: 'next', start: 0.5, end: 0.8 }
        ]
      }
    ])
    expect(out.map((w) => w.text)).toEqual(['end', 'next'])
  })

  test('clamps inverted word timestamps instead of producing negative spans', () => {
    const out = stitchWords([{ offset: 10, words: [{ word: 'x', start: 2.0, end: 1.9 }] }])
    expect(out[0].end).toBeGreaterThanOrEqual(out[0].start)
  })
})
