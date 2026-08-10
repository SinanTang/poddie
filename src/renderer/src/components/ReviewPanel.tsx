import { useEffect } from 'react'
import { fmtDuration } from '../../../shared/format'
import type { Suggestion } from '../../../shared/cleanup'
import type { EditItem } from '../../../shared/edit'

interface ReviewPanelProps {
  title: string
  suggestions: Suggestion[]
  items: EditItem[]
  onSeek: (itemIndex: number) => void
  onClose: () => void
}

export function ReviewPanel({
  title,
  suggestions,
  items,
  onSeek,
  onClose
}: ReviewPanelProps): React.JSX.Element {
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
        <span className="review-count">{suggestions.length} removed — restore inline or undo all</span>
        <span className="spacer" />
        <button className="ghost small" onClick={onClose} title="Close (Esc)">
          ✕
        </button>
      </div>
      <div className="review-list">
        {suggestions.map((s) => (
          <div key={s.id} className="review-row" onClick={() => onSeek(s.index)}>
            <span className="review-time">{fmtDuration(items[s.index]?.start ?? 0)}</span>
            <span className="review-preview">{s.preview}</span>
          </div>
        ))}
        {suggestions.length === 0 && <div className="review-empty">Nothing found.</div>}
      </div>
    </div>
  )
}
