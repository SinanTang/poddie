import { useEffect, useMemo, useState } from 'react'
import {
  buildFeedbackBody,
  buildFeedbackTitle,
  buildFeedbackUrl,
  FEEDBACK_CATEGORIES,
  type FeedbackCategory,
  type FeedbackTechInfo
} from '../../../shared/feedback'
import { errText } from '../lib/errors'

const CATEGORY_ORDER: FeedbackCategory[] = ['bug', 'idea', 'usability']

/**
 * "Send beta feedback" modal: pick a category, describe it, optionally attach
 * version info, preview the EXACT issue text, then open a pre-filled GitHub
 * issue in the browser. The app itself never uploads anything — the preview
 * strings are the same ones handed to the main process verbatim.
 */
export function FeedbackDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [category, setCategory] = useState<FeedbackCategory>('bug')
  const [summary, setSummary] = useState('')
  const [description, setDescription] = useState('')
  const [includeTech, setIncludeTech] = useState(true)
  const [tech, setTech] = useState<FeedbackTechInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // versions + capability flags only; the dialog still works if this fails
    window.poddie
      .getFeedbackTechInfo()
      .then(setTech)
      .catch(() => setTech(null))
  }, [])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const title = buildFeedbackTitle(category, summary)
  const body = buildFeedbackBody(description, includeTech ? tech : null)

  // Same builder the main process uses — catches over-length before submit.
  const urlError = useMemo(() => {
    try {
      buildFeedbackUrl(category, title, body)
      return null
    } catch (err) {
      return errText(err)
    }
  }, [category, title, body])

  const canSubmit = summary.trim() !== '' && description.trim() !== '' && urlError === null

  async function submit(): Promise<void> {
    setError(null)
    try {
      await window.poddie.openFeedbackIssue(category, title, body)
      onClose()
    } catch (err) {
      setError(errText(err))
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Send beta feedback">
        <h2>Send beta feedback</h2>

        <div className="popover-row">
          <span className="popover-label">This is a…</span>
          <div className="segmented" role="radiogroup" aria-label="Feedback type">
            {CATEGORY_ORDER.map((c) => (
              <button
                key={c}
                className="ghost"
                role="radio"
                aria-checked={category === c}
                onClick={() => setCategory(c)}
              >
                {FEEDBACK_CATEGORIES[c].label}
              </button>
            ))}
          </div>
        </div>

        <div className="popover-row">
          <label className="popover-label" htmlFor="feedback-summary">
            Summary
          </label>
          <input
            id="feedback-summary"
            type="text"
            autoFocus
            maxLength={200}
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="One line — e.g. “Waveform selection is off by a word”"
          />
        </div>

        <div className="popover-row">
          <label className="popover-label" htmlFor="feedback-description">
            Details
          </label>
          <textarea
            id="feedback-description"
            rows={5}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={FEEDBACK_CATEGORIES[category].hint}
          />
        </div>

        <label className="feedback-tech">
          <input
            type="checkbox"
            checked={includeTech && tech !== null}
            disabled={tech === null}
            onChange={(e) => setIncludeTech(e.target.checked)}
          />
          Include technical details
        </label>

        <div className="popover-row">
          <span className="popover-label">Exactly what the GitHub issue will contain</span>
          <div className="feedback-preview">
            <div className="feedback-preview-title">{summary.trim() === '' ? `${title} …` : title}</div>
            <pre>{body}</pre>
          </div>
        </div>

        {(error ?? urlError) && (
          <div className="feedback-error" role="alert">
            {error ?? urlError}
          </div>
        )}

        <div className="modal-actions">
          <span className="popover-hint">
            Opens github.com in your browser
          </span>
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button onClick={() => void submit()} disabled={!canSubmit}>
            Open GitHub issue…
          </button>
        </div>
      </div>
    </div>
  )
}
