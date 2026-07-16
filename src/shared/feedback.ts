/**
 * Beta feedback → pre-filled GitHub issue.
 *
 * Everything here is pure string building so the renderer can preview the
 * EXACT title/body that ends up in the issue — the same strings are handed to
 * the main process, which only validates and opens the URL. Nothing is ever
 * uploaded by the app itself: the user reviews and submits on github.com.
 *
 * Privacy invariant: no field in this module carries recordings, transcripts,
 * file names, paths, or log content — FeedbackTechInfo is versions and
 * capability flags only. Keep it that way.
 */

export type FeedbackCategory = 'bug' | 'idea' | 'usability'

export const FEEDBACK_CATEGORIES: Record<
  FeedbackCategory,
  { label: string; titlePrefix: string; ghLabel: string; hint: string }
> = {
  bug: {
    label: 'Bug',
    titlePrefix: '[Bug]',
    ghLabel: 'bug',
    hint: 'What happened, what you expected, and how to reproduce it'
  },
  idea: {
    label: 'Idea',
    titlePrefix: '[Idea]',
    ghLabel: 'enhancement',
    hint: 'What you wish Poddie could do, and why'
  },
  usability: {
    label: 'Usability problem',
    titlePrefix: '[Usability]',
    ghLabel: 'usability',
    hint: 'What was confusing or harder than it should be'
  }
}

/** Category comes over IPC — normalize instead of trusting the wire. */
export function asFeedbackCategory(value: unknown): FeedbackCategory {
  return value === 'idea' || value === 'usability' ? value : 'bug'
}

/** Version info and capability flags only — never paths, media, or logs. */
export interface FeedbackTechInfo {
  appVersion: string
  electronVersion: string
  chromeVersion: string
  /** e.g. "macOS 15.5" */
  osVersion: string
  arch: string
  canBurnCaptions: boolean
  localWhisperAvailable: boolean
}

export function buildFeedbackTitle(category: FeedbackCategory, summary: string): string {
  return `${FEEDBACK_CATEGORIES[category].titlePrefix} ${summary.trim()}`
}

export function buildFeedbackBody(description: string, tech: FeedbackTechInfo | null): string {
  const desc = description.trim() === '' ? '_No details provided._' : description.trim()
  if (!tech) return desc
  return [
    desc,
    '',
    '---',
    '',
    '**Technical details**:',
    '',
    `- Poddie ${tech.appVersion}`,
    `- Electron ${tech.electronVersion} · Chromium ${tech.chromeVersion}`,
    `- ${tech.osVersion} (${tech.arch})`,
    `- Caption burn-in (libass): ${tech.canBurnCaptions ? 'available' : 'unavailable'}`,
    `- Local Whisper: ${tech.localWhisperAvailable ? 'available' : 'unavailable'}`
  ].join('\n')
}

export const FEEDBACK_REPO_URL = 'https://github.com/electronicbrains/poddie'

/** GitHub rejects very long request URLs; leave headroom under its ~8 KB cap. */
export const FEEDBACK_URL_MAX = 7000

/**
 * The `issues/new` URL with title/body/label pre-filled. Throws when the
 * encoded URL would exceed GitHub's limit, so callers fail fast instead of
 * opening a page that silently drops the body.
 */
export function buildFeedbackUrl(category: FeedbackCategory, title: string, body: string): string {
  const query = new URLSearchParams({
    title,
    body,
    labels: FEEDBACK_CATEGORIES[category].ghLabel
  })
  const url = `${FEEDBACK_REPO_URL}/issues/new?${query}`
  if (url.length > FEEDBACK_URL_MAX) {
    throw new Error(
      `Feedback is too long for a pre-filled GitHub issue (${url.length} of ${FEEDBACK_URL_MAX} characters) — please shorten the description`
    )
  }
  return url
}
