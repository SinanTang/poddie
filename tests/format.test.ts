import { describe, expect, test } from 'vitest'
import { fmtDuration, whisperCostUsd } from '../src/shared/format'

describe('fmtDuration', () => {
  test('formats minutes and hours', () => {
    expect(fmtDuration(65)).toBe('1:05')
    expect(fmtDuration(2674.1)).toBe('44:34')
    expect(fmtDuration(3725)).toBe('1:02:05')
  })
})

describe('whisperCostUsd', () => {
  test('charges $0.006 per minute', () => {
    expect(whisperCostUsd(60)).toBe(0.006)
    expect(whisperCostUsd(2674.1)).toBeCloseTo(0.2674, 4)
    expect(whisperCostUsd(0)).toBe(0)
  })
})
