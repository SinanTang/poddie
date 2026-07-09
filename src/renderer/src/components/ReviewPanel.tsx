import { useEffect } from 'react'
import { fmtDuration } from '../../../shared/format'
import type { Suggestion } from '../../../shared/cleanup'
import type { EditItem } from '../../../shared/edit'

export type Decision = 'accepted' | 'rejected'

interface ReviewPanelProps {
  title: string
  suggestions: Suggestion[]
  /** id → decision; absent = pending. Owned by App so decisions survive re-renders. */
  decisions: ReadonlyMap<number, Decision>
  items: EditItem[]
  /** Toggle semantics: deciding the same way again reverts to pending. */
  onDecide: (ids: number[], decision: Decision) => void
  onSeek: (itemIndex: number) => void
  onApply: () => void
  onClose: () => void
}

/**
 * Review-before-apply list shared by every suggestion producer (filler list
 * now, LLM punctuation in Phase 4). Nothing is applied until the user says so —
 * precision on ambiguous candidates (那个/就是 are usually real words) comes
 * from the human, not the detector. Rows seek the video so the user can HEAR
 * the candidate before deciding.
 */
export function ReviewPanel({
  title,
  suggestions,
  decisions,
  items,
  onDecide,
  onSeek,
  onApply,
  onClose
}: ReviewPanelProps): React.JSX.Element {
  const acceptedCount = suggestions.filter((s) => decisions.get(s.id) === 'accepted').length

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="review-panel">
      <div className="review-header">
        <strong>{title}</strong>
        <span className="review-count">
          {suggestions.length} found · {acceptedCount} to apply
        </span>
        <span className="spacer" />
        <button
          className="ghost small"
          onClick={() => onDecide(suggestions.map((s) => s.id), 'accepted')}
          disabled={suggestions.length === 0}
        >
          Accept all
        </button>
        <button
          className="ghost small"
          onClick={() => onDecide(suggestions.map((s) => s.id), 'rejected')}
          disabled={suggestions.length === 0}
        >
          Reject all
        </button>
        <button onClick={onApply} disabled={acceptedCount === 0} title="Apply accepted suggestions as one undo step">
          Apply {acceptedCount}
        </button>
        <button className="ghost small" onClick={onClose} title="Close without applying (Esc)">
          ✕
        </button>
      </div>
      <div className="review-list">
        {suggestions.map((s) => {
          const decision = decisions.get(s.id)
          const classes = ['review-row']
          if (decision) classes.push(decision)
          return (
            <div key={s.id} className={classes.join(' ')} onClick={() => onSeek(s.index)}>
              <span className="review-time">{fmtDuration(items[s.index]?.start ?? 0)}</span>
              <span className="review-preview">{s.preview}</span>
              <span className="review-actions" onClick={(e) => e.stopPropagation()}>
                <button
                  className={decision === 'accepted' ? 'accept on' : 'accept'}
                  onClick={() => onDecide([s.id], 'accepted')}
                  title={s.kind === 'filler' ? 'Cut this from the audio' : 'Apply this suggestion'}
                >
                  ✓
                </button>
                <button
                  className={decision === 'rejected' ? 'reject on' : 'reject'}
                  onClick={() => onDecide([s.id], 'rejected')}
                  title="Keep as is"
                >
                  ✗
                </button>
              </span>
            </div>
          )
        })}
        {suggestions.length === 0 && <div className="review-empty">Nothing found.</div>}
      </div>
    </div>
  )
}
