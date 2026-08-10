import { useCallback, useEffect } from 'react'
import { fmtDuration } from '../../../shared/format'
import type { Chapter, ChapterAnalysis, Subchapter } from '../../../shared/types'

interface ChapterPanelProps {
  chapters: ChapterAnalysis
  onToggleKept: (chapterIdx: number, subIdx: number) => void
  onSeek: (timeSec: number) => void
  onApply: () => void
  onRegenerate: () => void
  regenerating: boolean
  onClose: () => void
}

function cutCount(chapters: Chapter[]): number {
  let n = 0
  for (const ch of chapters) for (const sub of ch.subchapters) if (!sub.kept) n++
  return n
}

function SubchapterRow({
  sub,
  onToggle,
  onSeek
}: {
  sub: Subchapter
  onToggle: () => void
  onSeek: () => void
}): React.JSX.Element {
  return (
    <div className={`chapter-sub ${sub.kept ? '' : 'cut'}`} onClick={onSeek}>
      <button
        className={`chapter-toggle ${sub.kept ? 'kept' : 'cut'}`}
        onClick={(e) => { e.stopPropagation(); onToggle() }}
        title={sub.kept ? 'Mark for removal' : 'Keep this section'}
      >
        {sub.kept ? '✓' : '✗'}
      </button>
      <span className="chapter-sub-time">{fmtDuration(sub.startTime)}</span>
      <span className="chapter-sub-body">
        <span className="chapter-sub-title">{sub.title}</span>
        <span className="chapter-sub-summary">{sub.summary}</span>
        <span className="chapter-sub-note">AI note: {sub.editorialVerdict}</span>
      </span>
    </div>
  )
}

export function ChapterPanel({
  chapters,
  onToggleKept,
  onSeek,
  onApply,
  onRegenerate,
  regenerating,
  onClose
}: ChapterPanelProps): React.JSX.Element {
  const cuts = cutCount(chapters.chapters)

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const seekTo = useCallback((sec: number) => onSeek(sec + 0.001), [onSeek])

  return (
    <div className="chapter-panel">
      <div className="chapter-header">
        <strong>Chapters</strong>
        <span className="chapter-count">
          {chapters.chapters.reduce((n, ch) => n + ch.subchapters.length, 0)} sections
          {cuts > 0 && ` · ${cuts} marked for removal`}
        </span>
        <span className="spacer" />
        <button
          className="ghost small"
          onClick={onRegenerate}
          disabled={regenerating}
          title="Re-run AI chapter analysis"
        >
          {regenerating ? '⏳ Regenerating…' : '↻ Regenerate'}
        </button>
        {cuts > 0 && (
          <button className="small" onClick={onApply} title="Remove all cut-marked sections as one undo step">
            Apply {cuts} cuts
          </button>
        )}
        <button className="ghost small" onClick={onClose} title="Close (Esc)">✕</button>
      </div>
      <div className="chapter-list">
        {chapters.chapters.map((ch, ci) => (
          <div key={ci} className="chapter-group">
            <div className="chapter-main" onClick={() => seekTo(ch.subchapters[0]?.startTime ?? ch.startTime)}>
              <span className="chapter-main-time">
                {fmtDuration(Math.min(...ch.subchapters.map(s => s.startTime)))} – {fmtDuration(Math.max(...ch.subchapters.map(s => s.endTime)))}
              </span>
              <span className="chapter-main-title">{ch.title}</span>
              <span className="chapter-main-summary">{ch.summary}</span>
            </div>
            {ch.subchapters.map((sub, si) => (
              <SubchapterRow
                key={si}
                sub={sub}
                onToggle={() => onToggleKept(ci, si)}
                onSeek={() => seekTo(sub.startTime)}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
