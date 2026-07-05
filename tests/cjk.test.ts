import { describe, expect, test } from 'vitest'
import { joinTokens, needsSpaceBetween } from '../src/shared/cjk'

describe('needsSpaceBetween', () => {
  test('CJK–CJK joins directly', () => {
    expect(needsSpaceBetween('大', '家')).toBe(false)
    expect(needsSpaceBetween('播客', '节目')).toBe(false)
  })

  test('Latin–Latin gets a space', () => {
    expect(needsSpaceBetween('hello', 'world')).toBe(true)
  })

  test('CJK–Latin boundaries get a space (mixed zh/en convention)', () => {
    expect(needsSpaceBetween('叫', 'OK')).toBe(true)
    expect(needsSpaceBetween('OK', '大')).toBe(true)
  })

  test('no space before attaching punctuation or after openers', () => {
    expect(needsSpaceBetween('hello', ',')).toBe(false)
    expect(needsSpaceBetween('好', '，')).toBe(false)
    expect(needsSpaceBetween('(', 'hello')).toBe(false)
  })
})

describe('joinTokens', () => {
  test('renders mixed zh/en transcript naturally', () => {
    expect(joinTokens(['OK', '大', '家', '好', 'welcome', 'to', 'the', 'show'])).toBe('OK 大家好 welcome to the show')
  })
})
