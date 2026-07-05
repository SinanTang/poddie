import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { needsSpaceBetween } from '../../../shared/cjk'
import { fmtDuration } from '../../../shared/format'
import { buildParagraphs, findWordAtTime, type MatchRange } from '../lib/transcript'
import type { TranscriptSegment, TranscriptWord } from '../../../shared/types'

interface TranscriptViewProps {
  words: TranscriptWord[]
  segments: TranscriptSegment[]
  videoEl: HTMLVideoElement | null
  matches: MatchRange[]
  activeMatch: number
}

interface ParagraphViewProps {
  words: TranscriptWord[]
  from: number
  to: number
  startSec: number
  /** Global index of the word being spoken, or -1 if outside this paragraph. */
  activeWord: number
  hitMap: Map<number, number>
  activeHitFrom: number
  activeHitTo: number
  onWordClick: (index: number) => void
}

const ParagraphView = memo(function ParagraphView({
  words,
  from,
  to,
  startSec,
  activeWord,
  hitMap,
  activeHitFrom,
  activeHitTo,
  onWordClick
}: ParagraphViewProps): React.JSX.Element {
  const tokens: React.ReactNode[] = []
  for (let i = from; i < to; i++) {
    if (i > from && needsSpaceBetween(words[i - 1].text, words[i].text)) tokens.push(' ')
    const classes = ['w']
    if (i === activeWord) classes.push('now')
    if (hitMap.has(i)) classes.push(i >= activeHitFrom && i <= activeHitTo ? 'hit-active' : 'hit')
    tokens.push(
      <span key={i} data-w={i} className={classes.join(' ')} onClick={() => onWordClick(i)}>
        {words[i].text}
      </span>
    )
  }
  return (
    <p className="para">
      <span className="ptime" onClick={() => onWordClick(from)}>
        {fmtDuration(startSec)}
      </span>
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

export function TranscriptView({ words, segments, videoEl, matches, activeMatch }: TranscriptViewProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [activeIdx, setActiveIdx] = useState(-1)
  const [follow, setFollow] = useState(true)

  const paragraphs = useMemo(() => buildParagraphs(words, segments), [words, segments])

  const hitMap = useMemo(() => {
    const map = new Map<number, number>()
    matches.forEach((m, mi) => {
      for (let i = m.startWord; i <= m.endWord; i++) map.set(i, mi)
    })
    return map
  }, [matches])

  const seekTo = useCallback(
    (index: number) => {
      if (videoEl && words[index]) videoEl.currentTime = words[index].start + 0.001
    },
    [videoEl, words]
  )

  // Track the word being spoken (state only changes when the index changes)
  useEffect(() => {
    if (!videoEl) return
    let raf = 0
    const tick = (): void => {
      setActiveIdx((prev) => {
        const idx = findWordAtTime(words, videoEl.currentTime)
        return idx === prev ? prev : idx
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [videoEl, words])

  // Follow playback: keep the active word in the readable middle of the pane
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

  return (
    <div className="transcript-view">
      <div className="transcript-toolbar">
        <label className="follow">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          Follow playback
        </label>
      </div>
      <div className="transcript-scroll" ref={scrollRef}>
        {paragraphs.map((p) => {
          const activeWord = activeIdx >= p.from && activeIdx < p.to ? activeIdx : -1
          return (
            <ParagraphView
              key={p.from}
              words={words}
              from={p.from}
              to={p.to}
              startSec={p.startSec}
              activeWord={activeWord}
              hitMap={hitMap}
              activeHitFrom={active?.startWord ?? -1}
              activeHitTo={active?.endWord ?? -1}
              onWordClick={seekTo}
            />
          )
        })}
      </div>
    </div>
  )
}
