import { describe, expect, it } from 'vitest'
import { normalizeChapters } from '../src/shared/chapters'
import type { Chapter, Subchapter } from '../src/shared/types'

const sub = (title: string, startTime: number, endTime: number): Subchapter => ({
  title,
  startTime,
  endTime,
  summary: '',
  editorialVerdict: '',
  kept: true
})

const chapter = (title: string, subs: Subchapter[]): Chapter => ({
  title,
  startTime: subs.length > 0 ? subs[0].startTime : 0,
  endTime: subs.length > 0 ? subs[subs.length - 1].endTime : 0,
  summary: '',
  subchapters: subs
})

/** Every second of the media belongs to exactly one chapter and one subchapter. */
function assertTiles(chapters: Chapter[], durationSec: number): void {
  const subs = chapters.flatMap((c) => c.subchapters)
  expect(subs[0].startTime).toBe(0)
  expect(subs[subs.length - 1].endTime).toBe(durationSec)
  for (let i = 1; i < subs.length; i++) {
    expect(subs[i].startTime).toBe(subs[i - 1].endTime)
  }
  for (const ch of chapters) {
    expect(ch.startTime).toBe(ch.subchapters[0].startTime)
    expect(ch.endTime).toBe(ch.subchapters[ch.subchapters.length - 1].endTime)
  }
}

describe('normalizeChapters', () => {
  it('closes the gap the model leaves between chapters', () => {
    // The real qwen3:8b run: 5:04 -> 16:40 belonged to no chapter at all.
    const out = normalizeChapters(
      [
        chapter('起点', [sub('a', 0, 83), sub('b', 83, 205), sub('c', 205, 304)]),
        chapter('挑战', [sub('d', 1000, 1400), sub('e', 1400, 1600)]),
        chapter('反思', [sub('f', 1600, 2000), sub('g', 2000, 2674)])
      ],
      2674
    )

    assertTiles(out, 2674)
    // the orphaned 11m36s now belongs to the section that was playing
    expect(out[0].endTime).toBe(1000)
    expect(out[0].subchapters[2].endTime).toBe(1000)
  })

  it('extends the final chapter to the end of the media', () => {
    const out = normalizeChapters([chapter('only', [sub('a', 0, 10)])], 600)
    expect(out[0].endTime).toBe(600)
  })

  it('anchors the first subchapter at zero', () => {
    const out = normalizeChapters([chapter('late', [sub('a', 42, 90)])], 300)
    expect(out[0].startTime).toBe(0)
  })

  it('resolves overlapping sections without losing time', () => {
    const out = normalizeChapters(
      [chapter('one', [sub('a', 0, 500), sub('b', 100, 200)]), chapter('two', [sub('c', 150, 900)])],
      900
    )
    assertTiles(out, 900)
  })

  it('reorders chapters the model emitted out of sequence', () => {
    const out = normalizeChapters(
      [chapter('second', [sub('b', 100, 200)]), chapter('first', [sub('a', 0, 100)])],
      200
    )
    expect(out.map((c) => c.title)).toEqual(['first', 'second'])
    assertTiles(out, 200)
  })

  it('drops chapters with no usable timings instead of emitting Infinity', () => {
    const out = normalizeChapters(
      [
        chapter('empty', []),
        chapter('bad', [sub('x', Number.NaN, 5)]),
        chapter('good', [sub('a', 0, 10)])
      ],
      100
    )
    expect(out.map((c) => c.title)).toEqual(['good'])
    assertTiles(out, 100)
  })

  it('clamps times beyond the media duration', () => {
    const out = normalizeChapters([chapter('over', [sub('a', 0, 10), sub('b', 9999, 10500)])], 300)
    assertTiles(out, 300)
    for (const s of out.flatMap((c) => c.subchapters)) {
      expect(s.endTime).toBeLessThanOrEqual(300)
    }
  })

  it('returns nothing for empty input or unknown duration', () => {
    expect(normalizeChapters([], 100)).toEqual([])
    expect(normalizeChapters([chapter('a', [sub('a', 0, 10)])], 0)).toEqual([])
  })
})
