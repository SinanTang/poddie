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
  /** Export one chapter as its own file, edits preserved. */
  onExportClip: (chapterIdx: number) => void
  onExportAll: () => void
  /** Playable seconds per chapter after edits — 0 means fully cut. */
  clipSeconds: number[]
  exporting: boolean
  /** Shared with the Export card — clips burn captions on the same setting. */
  burnIn: boolean
  canBurnCaptions: boolean
  hasVideo: boolean
  onBurnInChange: (value: boolean) => void
  /** Set by App while the panel is being resized. */
  style?: React.CSSProperties
  panelRef?: React.Ref<HTMLDivElement>
}

function cutCount(chapters: Chapter[]): number {
  let n = 0
  for (const ch of chapters) for (const sub of ch.subchapters) if (!sub.kept) n++
  return n
}

/** What the next export will do about captions, in words, for tooltips. */
function captionState(hasVideo: boolean, burnIn: boolean, canBurnCaptions: boolean): string {
  return hasVideo && burnIn && canBurnCaptions ? 'captions burned in' : 'no burned-in captions'
}

/**
 * Burn-in is a modifier of the export you are about to run, not a mode of the
 * panel, so it sits attached to the export button rather than beside
 * Regenerate. One shared setting (the Export card's) rendered wherever an
 * export can start — never a second copy that can drift out of sync.
 */
function CaptionToggle({
  burnIn,
  canBurnCaptions,
  hasVideo,
  exporting,
  onChange
}: {
  burnIn: boolean
  canBurnCaptions: boolean
  hasVideo: boolean
  exporting: boolean
  onChange: (value: boolean) => void
}): React.JSX.Element | null {
  if (!hasVideo) return null
  const on = burnIn && canBurnCaptions
  return (
    <button
      className={`ghost small caption-toggle ${on ? 'on' : ''}`}
      aria-pressed={on}
      disabled={!canBurnCaptions || exporting}
      onClick={(e) => { e.stopPropagation(); onChange(!burnIn) }}
      title={
        canBurnCaptions
          ? `${on ? 'Captions are burned into the exported clip' : 'No captions in the exported clip'} — click to ${on ? 'turn off' : 'turn on'} (shared with the Export card)`
          : 'Needs an ffmpeg build with libass (subtitles filter) — brew ffmpeg lacks it'
      }
    >
      CC
    </button>
  )
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
  onClose,
  onExportClip,
  onExportAll,
  clipSeconds,
  exporting,
  burnIn,
  canBurnCaptions,
  hasVideo,
  onBurnInChange,
  style,
  panelRef
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
    <div className="chapter-panel" ref={panelRef} style={style}>
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
        <span className="export-group">
          <CaptionToggle
            burnIn={burnIn}
            canBurnCaptions={canBurnCaptions}
            hasVideo={hasVideo}
            exporting={exporting}
            onChange={onBurnInChange}
          />
          <button
            className="ghost small"
            onClick={onExportAll}
            disabled={exporting || clipSeconds.every((sec) => sec <= 0)}
            title={`Export every chapter as its own file, with your edits applied — ${captionState(hasVideo, burnIn, canBurnCaptions)}`}
          >
            ⧉ Export all
          </button>
        </span>
        <button className="ghost small" onClick={onClose} title="Close (Esc)">✕</button>
      </div>
      <div className="chapter-list">
        {chapters.chapters.map((ch, ci) => (
          <div key={ci} className="chapter-group">
            <div className="chapter-main" onClick={() => seekTo(ch.startTime)}>
              <span className="chapter-main-time">
                {fmtDuration(ch.startTime)} – {fmtDuration(ch.endTime)}
              </span>
              <span className="chapter-main-title">{ch.title}</span>
              <span className="chapter-main-summary">{ch.summary}</span>
              <span className="chapter-clip-group" onClick={(e) => e.stopPropagation()}>
                <CaptionToggle
                  burnIn={burnIn}
                  canBurnCaptions={canBurnCaptions}
                  hasVideo={hasVideo}
                  exporting={exporting}
                  onChange={onBurnInChange}
                />
                <button
                  className="ghost small chapter-clip"
                  onClick={() => onExportClip(ci)}
                  disabled={exporting || (clipSeconds[ci] ?? 0) <= 0}
                  title={
                    (clipSeconds[ci] ?? 0) <= 0
                      ? 'Nothing left in this chapter after your edits'
                      : `Export this chapter as its own file — ${fmtDuration(clipSeconds[ci])} after edits, ${captionState(hasVideo, burnIn, canBurnCaptions)}`
                  }
                >
                  ✂ Clip{(clipSeconds[ci] ?? 0) > 0 && ` · ${fmtDuration(clipSeconds[ci])}`}
                </button>
              </span>
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
