import { describe, expect, test } from 'vitest'
import {
  asFeedbackCategory,
  buildFeedbackBody,
  buildFeedbackTitle,
  buildFeedbackUrl,
  FEEDBACK_REPO_URL,
  FEEDBACK_URL_MAX,
  type FeedbackTechInfo
} from '../src/shared/feedback'

const tech: FeedbackTechInfo = {
  appVersion: '0.1.0',
  electronVersion: '31.7.7',
  chromeVersion: '126.0.6478.234',
  osVersion: 'macOS 15.5',
  arch: 'arm64',
  canBurnCaptions: true,
  localWhisperAvailable: false
}

describe('asFeedbackCategory', () => {
  test('passes valid categories through and defaults junk to bug', () => {
    expect(asFeedbackCategory('idea')).toBe('idea')
    expect(asFeedbackCategory('usability')).toBe('usability')
    expect(asFeedbackCategory('bug')).toBe('bug')
    expect(asFeedbackCategory('DROP TABLE')).toBe('bug')
    expect(asFeedbackCategory(undefined)).toBe('bug')
  })
})

describe('buildFeedbackTitle', () => {
  test('prefixes the category and trims the summary', () => {
    expect(buildFeedbackTitle('bug', '  export hangs ')).toBe('[Bug] export hangs')
    expect(buildFeedbackTitle('idea', 'chapters')).toBe('[Idea] chapters')
    expect(buildFeedbackTitle('usability', 'lost the cut')).toBe('[Usability] lost the cut')
  })
})

describe('buildFeedbackBody', () => {
  test('without tech info is just the trimmed description', () => {
    expect(buildFeedbackBody('  it broke  ', null)).toBe('it broke')
  })

  test('with tech info appends versions and the privacy note', () => {
    const body = buildFeedbackBody('it broke', tech)
    expect(body).toContain('it broke')
    expect(body).toContain('- Poddie 0.1.0')
    expect(body).toContain('- Electron 31.7.7 · Chromium 126.0.6478.234')
    expect(body).toContain('- macOS 15.5 (arm64)')
    expect(body).toContain('- Caption burn-in (libass): available')
    expect(body).toContain('- Local Whisper: unavailable')
    expect(body).toContain('no recordings, transcripts, file names, or logs')
  })

  test('empty description gets a placeholder so the issue is never blank', () => {
    expect(buildFeedbackBody('   ', null)).toBe('_No details provided._')
  })
})

describe('buildFeedbackUrl', () => {
  test('pre-fills title, body and label on the repo new-issue page', () => {
    const url = buildFeedbackUrl('idea', '[Idea] chapters', 'chapter markers please')
    expect(url.startsWith(`${FEEDBACK_REPO_URL}/issues/new?`)).toBe(true)
    const params = new URL(url).searchParams
    expect(params.get('title')).toBe('[Idea] chapters')
    expect(params.get('body')).toBe('chapter markers please')
    expect(params.get('labels')).toBe('enhancement')
  })

  test('round-trips CJK and markdown through URL encoding', () => {
    const body = buildFeedbackBody('导出**很慢**\n\n- 第一步', tech)
    const url = buildFeedbackUrl('bug', '[Bug] 导出很慢', body)
    const params = new URL(url).searchParams
    expect(params.get('title')).toBe('[Bug] 导出很慢')
    expect(params.get('body')).toBe(body)
  })

  test('throws when the encoded URL exceeds the GitHub limit', () => {
    // CJK inflates ~9x when percent-encoded — the cap must catch that too
    expect(() => buildFeedbackUrl('bug', '[Bug] t', '很'.repeat(1000))).toThrow(/too long/)
    expect(buildFeedbackUrl('bug', '[Bug] t', 'a'.repeat(FEEDBACK_URL_MAX - 200)).length).toBeLessThanOrEqual(
      FEEDBACK_URL_MAX
    )
  })
})
