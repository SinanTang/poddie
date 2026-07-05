import { describe, expect, test } from 'vitest'
import { buildCues, srtTimestamp, toSrt } from '../src/shared/captions'
import type { EditItem } from '../src/shared/edit'

function word(text: string, start: number, end: number, removed = false): EditItem {
  return { kind: 'word', text, start, end, removed }
}

function gap(start: number, end: number, removed = false): EditItem {
  return { kind: 'gap', text: '', start, end, removed }
}

describe('buildCues remapping', () => {
  test('no cuts → cue times equal source times', () => {
    const cues = buildCues([word('hello', 1.0, 1.4), word('world', 1.5, 2.0)], 10)
    expect(cues).toEqual([{ start: 1.0, end: 2.0, text: 'hello world' }])
  })

  test('words after a cut shift left by the cut length', () => {
    // gap [2, 4] removed → 2 s vanish; word at 5 lands at 3 in the output
    const items = [word('before', 1.0, 2.0), gap(2.0, 4.0, true), word('after', 5.0, 6.0)]
    const cues = buildCues(items, 10)
    expect(cues).toHaveLength(2) // 3 s source pause splits the cue (1 s of it kept)
    expect(cues[1].start).toBeCloseTo(3.0, 5)
    expect(cues[1].end).toBeCloseTo(4.0, 5)
  })

  test('removed and blanked (merged-away) words are excluded', () => {
    const items = [word('keep', 1.0, 1.5), word('cut', 1.5, 2.0, true), word('', 2.0, 2.5)]
    const cues = buildCues(items, 10)
    expect(cues).toHaveLength(1)
    expect(cues[0].text).toBe('keep')
  })

  test('everything cut → no cues', () => {
    expect(buildCues([word('gone', 1, 2, true)], 10)).toEqual([])
  })
})

describe('buildCues grouping', () => {
  test('a long source pause starts a new cue', () => {
    const items = [word('one', 1.0, 1.3), word('two', 2.5, 2.8)]
    const cues = buildCues(items, 10)
    expect(cues.map((c) => c.text)).toEqual(['one', 'two'])
  })

  test('width budget breaks the cue; CJK chars count double', () => {
    // 22 CJK chars = 44 units > 42 → must split; same 22 latin chars would fit
    const zh = Array.from({ length: 22 }, (_, i) => word('中', 1 + i * 0.2, 1.1 + i * 0.2))
    expect(buildCues(zh, 10).length).toBeGreaterThan(1)

    const en = Array.from({ length: 11 }, (_, i) => word('a', 1 + i * 0.2, 1.1 + i * 0.2))
    expect(buildCues(en, 10)).toHaveLength(1) // 11 chars + 10 spaces = 21 units
  })

  test('sentence punctuation soft-breaks a wide-enough cue', () => {
    const items = [
      ...Array.from({ length: 10 }, (_, i) => word('中', 1 + i * 0.1, 1.1 + i * 0.1)),
      word('。', 2.0, 2.1), // 21 units incl. the fullwidth stop ≥ soft threshold
      word('新', 2.2, 2.3)
    ]
    const cues = buildCues(items, 10)
    expect(cues).toHaveLength(2)
    expect(cues[0].text.endsWith('。')).toBe(true)
    expect(cues[1].text).toBe('新')
  })

  test('CJK joins without spaces, latin with spaces', () => {
    const cues = buildCues([word('大', 1, 1.2), word('家', 1.2, 1.4), word('ok', 1.5, 1.8)], 10)
    expect(cues[0].text).toBe('大家 ok')
  })
})

describe('srt serialization', () => {
  test('srtTimestamp formats hh:mm:ss,mmm', () => {
    expect(srtTimestamp(0)).toBe('00:00:00,000')
    expect(srtTimestamp(3661.5)).toBe('01:01:01,500')
    expect(srtTimestamp(59.9996)).toBe('00:01:00,000') // rounds, carries cleanly
  })

  test('toSrt emits numbered, blank-line-separated cues', () => {
    const srt = toSrt([
      { start: 1, end: 2.5, text: '大家好' },
      { start: 3, end: 4, text: 'hello' }
    ])
    expect(srt).toBe('1\n00:00:01,000 --> 00:00:02,500\n大家好\n\n2\n00:00:03,000 --> 00:00:04,000\nhello\n')
  })
})
