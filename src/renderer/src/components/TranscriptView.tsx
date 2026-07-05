import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { needsSpaceBetween } from '../../../shared/cjk'
import { fmtDuration } from '../../../shared/format'
import { buildParagraphs, findWordAtTime, type MatchRange } from '../lib/transcript'
import type { EditItem } from '../../../shared/edit'
import type { TranscriptSegment } from '../../../shared/types'
import type { SaveStatus } from '../App'

interface TranscriptViewProps {
  items: EditItem[]
  segments: TranscriptSegment[]
  videoEl: HTMLVideoElement | null
  matches: MatchRange[]
  activeMatch: number
  /** Delete-key semantics over an inclusive item range (remove, or restore if all removed). */
  onToggleRange: (from: number, to: number) => void
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  saveStatus: SaveStatus
}

function SaveIndicator({ status }: { status: SaveStatus }): React.JSX.Element | null {
  switch (status.state) {
    case 'clean':
      return null
    case 'pending':
    case 'saving':
      return <span className="save-status">Saving…</span>
    case 'saved':
      return <span className="save-status ok">✓ Saved {status.at}</span>
    case 'failed':
      return <span className="save-status bad">⚠ Save failed — see error above</span>
  }
}

interface ParagraphViewProps {
  items: EditItem[]
  from: number
  to: number
  startSec: number
  activeIdx: number
  hitMap: Map<number, number>
  activeHitFrom: number
  activeHitTo: number
  selFrom: number
  selTo: number
  onTokenMouseDown: (index: number, shiftKey: boolean) => void
  onTokenMouseEnter: (index: number) => void
}

const ParagraphView = memo(function ParagraphView({
  items,
  from,
  to,
  startSec,
  activeIdx,
  hitMap,
  activeHitFrom,
  activeHitTo,
  selFrom,
  selTo,
  onTokenMouseDown,
  onTokenMouseEnter
}: ParagraphViewProps): React.JSX.Element {
  const tokens: React.ReactNode[] = []
  let prevWordText = ''
  for (let i = from; i < to; i++) {
    const item = items[i]
    const classes = [item.kind === 'gap' ? 'gaptok' : 'w']
    if (item.removed) classes.push('cut')
    if (i === activeIdx) classes.push('now')
    if (i >= selFrom && i <= selTo) classes.push('sel')
    if (hitMap.has(i)) classes.push(i >= activeHitFrom && i <= activeHitTo ? 'hit-active' : 'hit')

    if (item.kind === 'word') {
      if (prevWordText && needsSpaceBetween(prevWordText, item.text)) tokens.push(' ')
      prevWordText = item.text
    }
    tokens.push(
      <span
        key={i}
        data-w={i}
        className={classes.join(' ')}
        onMouseDown={(e) => {
          e.preventDefault()
          onTokenMouseDown(i, e.shiftKey)
        }}
        onMouseEnter={() => onTokenMouseEnter(i)}
      >
        {item.kind === 'gap' ? `${(item.end - item.start).toFixed(1)}s` : item.text}
      </span>
    )
  }
  return (
    <p className="para">
      <span className="ptime">{fmtDuration(startSec)}</span>
      {tokens}
    </p>
  )
})

/** Scroll el into view only when it drifts out of the container's middle band. */
function keepInBand(container: HTMLElement, el: HTMLElement): void {
  const c = container.getBoundingClientRect()
  const r = el.getBoundingClientRect()
  const bandTop = c.top + c.height * 0.2
  const bandBottom = c.top + c.height * 0.8
  if (r.top < bandTop || r.bottom > bandBottom) {
    el.scrollIntoView({ block: 'center' })
  }
}

interface Selection {
  anchor: number
  focus: number
}

export function TranscriptView({
  items,
  segments,
  videoEl,
  matches,
  activeMatch,
  onToggleRange,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  saveStatus
}: TranscriptViewProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [activeIdx, setActiveIdx] = useState(-1)
  const [follow, setFollow] = useState(true)

  const paragraphs = useMemo(() => buildParagraphs(items, segments), [items, segments])

  const hitMap = useMemo(() => {
    const map = new Map<number, number>()
    matches.forEach((m, mi) => {
      for (let i = m.startWord; i <= m.endWord; i++) map.set(i, mi)
    })
    return map
  }, [matches])

  const seekTo = useCallback(
    (index: number) => {
      if (videoEl && items[index]) videoEl.currentTime = items[index].start + 0.001
    },
    [videoEl, items]
  )

  const onTokenMouseDown = useCallback((index: number, shiftKey: boolean) => {
    if (shiftKey) {
      setSelection((sel) => (sel ? { anchor: sel.anchor, focus: index } : { anchor: index, focus: index }))
    } else {
      setSelection({ anchor: index, focus: index })
    }
    draggingRef.current = true
  }, [])

  const onTokenMouseEnter = useCallback((index: number) => {
    if (draggingRef.current) {
      setSelection((sel) => (sel ? { anchor: sel.anchor, focus: index } : null))
    }
  }, [])

  // drag end: plain click (no drag movement) doubles as click-to-seek
  useEffect(() => {
    function onMouseUp(): void {
      if (!draggingRef.current) return
      draggingRef.current = false
      setSelection((sel) => {
        if (sel && sel.anchor === sel.focus) seekTo(sel.anchor)
        return sel
      })
    }
    window.addEventListener('mouseup', onMouseUp)
    return () => window.removeEventListener('mouseup', onMouseUp)
  }, [seekTo])

  // Delete/Backspace applies the toggle; Escape clears the selection
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
      if ((e.key === 'Delete' || e.key === 'Backspace') && selection) {
        e.preventDefault()
        onToggleRange(Math.min(selection.anchor, selection.focus), Math.max(selection.anchor, selection.focus))
      } else if (e.key === 'Escape') {
        setSelection(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selection, onToggleRange])

  // Track the item being spoken (state only changes when the index changes)
  useEffect(() => {
    if (!videoEl) return
    let raf = 0
    const tick = (): void => {
      setActiveIdx((prev) => {
        const idx = findWordAtTime(items, videoEl.currentTime)
        return idx === prev ? prev : idx
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [videoEl, items])

  // Follow playback: keep the active token in the readable middle of the pane
  useEffect(() => {
    if (!follow || activeIdx < 0 || !scrollRef.current) return
    const el = scrollRef.current.querySelector<HTMLElement>(`[data-w="${activeIdx}"]`)
    if (el) keepInBand(scrollRef.current, el)
  }, [activeIdx, follow])

  // Navigating search results seeks the video and reveals the match
  useEffect(() => {
    const m = matches[activeMatch]
    if (!m) return
    seekTo(m.startWord)
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-w="${m.startWord}"]`)
    el?.scrollIntoView({ block: 'center' })
  }, [matches, activeMatch, seekTo])

  const active = matches[activeMatch]
  const selLo = selection ? Math.min(selection.anchor, selection.focus) : -1
  const selHi = selection ? Math.max(selection.anchor, selection.focus) : -1

  return (
    <div className="transcript-view">
      <div className="transcript-toolbar">
        <label className="follow">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          Follow playback
        </label>
        <span className="toolbar-hint">
          {selection ? 'drag/⇧click to select · ⌫ delete or restore' : 'click seeks · drag selects'}
        </span>
        <span className="toolbar-actions">
          <SaveIndicator status={saveStatus} />
          <button className="ghost small" onClick={onUndo} disabled={!canUndo} title="Undo (⌘Z)">
            ↩ Undo
          </button>
          <button className="ghost small" onClick={onRedo} disabled={!canRedo} title="Redo (⇧⌘Z)">
            ↪ Redo
          </button>
        </span>
      </div>
      <div
        className="transcript-scroll"
        ref={scrollRef}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) setSelection(null)
        }}
      >
        {paragraphs.map((p) => {
          const paraActive = activeIdx >= p.from && activeIdx < p.to ? activeIdx : -1
          const paraSelFrom = selLo <= p.to - 1 && selHi >= p.from ? Math.max(selLo, p.from) : -1
          const paraSelTo = paraSelFrom >= 0 ? Math.min(selHi, p.to - 1) : -1
          return (
            <ParagraphView
              key={p.from}
              items={items}
              from={p.from}
              to={p.to}
              startSec={p.startSec}
              activeIdx={paraActive}
              hitMap={hitMap}
              activeHitFrom={active?.startWord ?? -1}
              activeHitTo={active?.endWord ?? -1}
              selFrom={paraSelFrom}
              selTo={paraSelTo}
              onTokenMouseDown={onTokenMouseDown}
              onTokenMouseEnter={onTokenMouseEnter}
            />
          )
        })}
      </div>
    </div>
  )
}
