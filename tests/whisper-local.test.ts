import { describe, expect, test } from 'vitest'
import { dtwPresetFor, parseWhisperCppJson, type CppJson } from '../src/main/whisper-local'
import type { TimeRange } from '../src/main/chunking'

// whisper-cli -ojf shapes: offsets in ms, t_dtw in CENTIseconds (-1 = no DTW)
function tok(text: string, fromMs: number, toMs: number, tDtwCs = -1): {
  text: string
  offsets: { from: number; to: number }
  t_dtw: number
} {
  return { text, offsets: { from: fromMs, to: toMs }, t_dtw: tDtwCs }
}

function cpp(segments: CppJson['transcription'], language = 'zh'): CppJson {
  return { result: { language }, transcription: segments }
}

const NO_SILENCE: TimeRange[] = []

describe('parseWhisperCppJson: word reconstruction', () => {
  test('CJK tokens become standalone words; DTW centiseconds win over coarse offsets', () => {
    const json = cpp([
      {
        text: '大家好',
        offsets: { from: 0, to: 1500 },
        tokens: [tok('大家', 0, 800, 42), tok('好', 800, 1500, 90), tok('[_TT_75]', 1500, 1500)]
      }
    ])
    const { words } = parseWhisperCppJson(json, NO_SILENCE)
    expect(words.map((w) => w.word)).toEqual(['大家', '好'])
    expect(words[0].start).toBeCloseTo(0.42, 10) // 42 cs, not 0 ms
    expect(words[1].start).toBeCloseTo(0.9, 10)
  })

  test('Latin BPE pieces merge on missing leading space, split on space', () => {
    const json = cpp([
      {
        text: ' Hello wor ld',
        offsets: { from: 0, to: 2000 },
        tokens: [tok(' Hello', 0, 500, 10), tok(' wor', 500, 900, 55), tok('ld', 900, 1400, 100)]
      }
    ])
    const { words } = parseWhisperCppJson(json, NO_SILENCE)
    expect(words.map((w) => w.word)).toEqual(['Hello', 'world'])
    expect(words[1].start).toBeCloseTo(0.55, 10)
    expect(words[1].end).toBeCloseTo(1.4, 10)
  })

  test('CJK–Latin boundaries split without spaces (mixed zh/en)', () => {
    const json = cpp([
      {
        text: '我们用OK的',
        offsets: { from: 0, to: 2000 },
        tokens: [tok('我们', 0, 400, 5), tok('用', 400, 700, 45), tok('OK', 700, 1200, 75), tok('的', 1200, 1400, 125)]
      }
    ])
    const { words } = parseWhisperCppJson(json, NO_SILENCE)
    expect(words.map((w) => w.word)).toEqual(['我们', '用', 'OK', '的'])
  })

  test('timestamp markers are dropped; bare punctuation attaches to the previous word', () => {
    const json = cpp([
      {
        text: '好,',
        offsets: { from: 0, to: 1000 },
        tokens: [tok('[_BEG_]', 0, 0), tok('好', 0, 500, 10), tok(',', 500, 600, 55), tok('[_TT_50]', 1000, 1000)]
      }
    ])
    const { words } = parseWhisperCppJson(json, NO_SILENCE)
    expect(words.map((w) => w.word)).toEqual(['好,'])
  })

  test("t_dtw = -1 falls back to the coarse offset; '�' byte fragments merge", () => {
    const json = cpp([
      {
        text: '你�好',
        offsets: { from: 0, to: 1200 },
        tokens: [tok('你', 100, 400), tok('�', 400, 600), tok('好', 600, 900, 70)]
      }
    ])
    const { words } = parseWhisperCppJson(json, NO_SILENCE)
    expect(words[0].word).toBe('你�')
    expect(words[0].start).toBeCloseTo(0.1, 10) // coarse ms fallback
    expect(words.map((w) => w.word)).toEqual(['你�', '好'])
  })

  test('a word never overlaps its successor', () => {
    const json = cpp([
      {
        text: '一二',
        offsets: { from: 0, to: 1000 },
        tokens: [tok('一', 0, 900, 10), tok('二', 300, 1000, 30)] // coarse end overshoots into 二
      }
    ])
    const { words } = parseWhisperCppJson(json, NO_SILENCE)
    expect(words[0].end).toBeLessThanOrEqual(words[1].start)
  })

  test('segments and language come through; duration is the last segment end', () => {
    const json = cpp([
      { text: ' 第一句 ', offsets: { from: 0, to: 3000 }, tokens: [tok('第一句', 0, 3000, 0)] },
      { text: '第二句', offsets: { from: 3000, to: 5500 }, tokens: [tok('第二句', 3000, 5500, 300)] }
    ])
    const result = parseWhisperCppJson(json, NO_SILENCE)
    expect(result.language).toBe('zh')
    expect(result.segments).toEqual([
      { text: '第一句', start: 0, end: 3 },
      { text: '第二句', start: 3, end: 5.5 }
    ])
    expect(result.duration).toBe(5.5)
  })
})

describe('parseWhisperCppJson: silence-snapped word ends', () => {
  // Coarse token ends truncate words early → fake inter-word gaps mid-speech.
  // Detected silences arbitrate: no silence → bridge; silence → snap to it.
  const twoWords = (endA: number, startB: number): CppJson =>
    cpp([
      {
        text: '甲乙',
        offsets: { from: 0, to: 5000 },
        tokens: [
          { text: '甲', offsets: { from: 0, to: endA * 1000 }, t_dtw: 0 },
          { text: '乙', offsets: { from: startB * 1000, to: 5000 }, t_dtw: startB * 100 }
        ]
      }
    ])

  test('a gap with no real silence inside is bridged away', () => {
    const { words } = parseWhisperCppJson(twoWords(1.0, 2.5), NO_SILENCE)
    expect(words[0].end).toBe(words[1].start) // contiguous speech, no fake gap
  })

  test('a gap backed by real silence snaps to the measured silence bounds', () => {
    const silences: TimeRange[] = [{ start: 1.4, end: 2.2 }]
    const { words } = parseWhisperCppJson(twoWords(1.0, 2.5), silences)
    expect(words[0].end).toBeCloseTo(1.4, 10) // word extends to where silence begins
    expect(words[1].start).toBeCloseTo(2.2, 10) // next word starts where silence ends
  })

  test('snapping never inverts a word span', () => {
    const silences: TimeRange[] = [{ start: 0.005, end: 2.4 }] // silence swallows word 甲
    const { words } = parseWhisperCppJson(twoWords(1.0, 2.5), silences)
    for (const w of words) expect(w.end).toBeGreaterThan(w.start)
    expect(words[1].start).toBeGreaterThanOrEqual(words[0].end)
  })
})

describe('dtwPresetFor', () => {
  test('maps ggml model filenames to whisper.cpp DTW presets', () => {
    expect(dtwPresetFor('/models/ggml-large-v3-turbo.bin')).toBe('large.v3.turbo')
    expect(dtwPresetFor('ggml-large-v3.bin')).toBe('large.v3')
    expect(dtwPresetFor('ggml-medium.bin')).toBe('medium')
    expect(dtwPresetFor('ggml-tiny.en.bin')).toBe('tiny.en')
  })

  test('unknown models get no preset (coarse timestamps, not a crash)', () => {
    expect(dtwPresetFor('ggml-large-v3-turbo-q5_0.bin')).toBe('large.v3.turbo')
    expect(dtwPresetFor('my-finetune.bin')).toBeNull()
  })
})
