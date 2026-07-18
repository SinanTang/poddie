import { useCallback, useEffect, useRef, useState } from 'react'
import WaveSurfer from 'wavesurfer.js'
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js'
import type { PeaksResult } from '../../../shared/types'
import type { TimeRange } from '../../../shared/edit'

const CUT_ID = 'cut-'
const CUT_COLOR = 'rgba(239, 68, 68, 0.28)'
const SELECT_COLOR = 'rgba(59, 130, 246, 0.35)'
/** ~4 ms/px at max zoom — far finer than Whisper's ±50–100 ms timestamps. */
const MAX_PX_PER_SEC = 250
const WHEEL_ZOOM_SPEED = 0.008

interface WaveformProps {
  /** The app's <video> or <audio> element — wavesurfer binds to it for time/seek sync. */
  mediaEl: HTMLMediaElement
  peaks: PeaksResult
  /** Removed spans, shaded red on the waveform. */
  removedRanges: TimeRange[]
  /** User dragged a selection on the waveform → delete that time span. */
  onRangeSelect: (start: number, end: number) => void
}

export function Waveform({ mediaEl, peaks, removedRanges, onRangeSelect }: WaveformProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WaveSurfer | null>(null)
  const regionsRef = useRef<RegionsPlugin | null>(null)
  const onRangeSelectRef = useRef(onRangeSelect)
  onRangeSelectRef.current = onRangeSelect
  const [ready, setReady] = useState(false)
  /** Current zoom in px/s; 0 = fit whole file to the container (resize-proof). */
  const [pxPerSec, setPxPerSec] = useState(0)

  const fitPxPerSec = useCallback(
    () => (containerRef.current ? containerRef.current.clientWidth / peaks.duration : 0),
    [peaks.duration]
  )

  /** Zoom to `next` px/s (clamped to [fit, max]); returns the effective value. */
  const applyZoom = useCallback(
    (next: number): number => {
      const ws = wsRef.current
      const fit = fitPxPerSec()
      if (!ws || fit === 0) return 0
      const clamped = Math.min(MAX_PX_PER_SEC, Math.max(fit, next))
      const atFit = clamped <= fit * 1.01
      ws.zoom(atFit ? 0 : clamped) // 0 lets fillParent own the width, so window resizes re-fit
      setPxPerSec(atFit ? 0 : clamped)
      return atFit ? fit : clamped
    },
    [fitPxPerSec]
  )

  useEffect(() => {
    if (!containerRef.current) return
    const ws = WaveSurfer.create({
      container: containerRef.current,
      media: mediaEl,
      peaks: [peaks.peaks],
      duration: peaks.duration,
      height: 56,
      waveColor: '#4b5563',
      progressColor: '#3b82f6',
      cursorColor: '#e5e7eb',
      barWidth: 2,
      barGap: 1,
      autoScroll: true,
      autoCenter: true
    })
    // zoom() needs decodedData, which wavesurfer builds from the provided peaks
    ws.on('decode', () => setReady(true))
    const regions = ws.registerPlugin(RegionsPlugin.create())
    regions.enableDragSelection({ color: SELECT_COLOR })
    regions.on('region-created', (region) => {
      if (region.id.startsWith(CUT_ID)) return
      // a drag-selection: hand the span to the editor, drop the visual artifact
      // (the resulting cut comes back as shading via removedRanges)
      const { start, end } = region
      region.remove()
      if (end - start > 0.05) onRangeSelectRef.current(start, end)
    })
    regionsRef.current = regions
    wsRef.current = ws
    return () => {
      regionsRef.current = null
      wsRef.current = null
      setReady(false)
      setPxPerSec(0)
      ws.destroy()
    }
  }, [mediaEl, peaks])

  // shade removed ranges (recreated on every edit — counts are small)
  useEffect(() => {
    const regions = regionsRef.current
    if (!regions) return
    for (const r of regions.getRegions()) {
      if (r.id.startsWith(CUT_ID)) r.remove()
    }
    removedRanges.forEach((r, i) => {
      regions.addRegion({
        id: `${CUT_ID}${i}`,
        start: r.start,
        end: r.end,
        color: CUT_COLOR,
        drag: false,
        resize: false
      })
    })
  }, [removedRanges, mediaEl, peaks])

  // ⌘/ctrl-scroll (or trackpad pinch) zooms around the time under the cursor
  useEffect(() => {
    const el = containerRef.current
    if (!el || !ready) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const ws = wsRef.current
      if (!ws) return
      const x = e.clientX - el.getBoundingClientRect().left
      const cur = ws.getWrapper().clientWidth / peaks.duration
      const timeAtCursor = (ws.getScroll() + x) / cur
      const next = applyZoom(cur * Math.exp(-e.deltaY * WHEEL_ZOOM_SPEED))
      ws.setScroll(timeAtCursor * next - x)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [ready, peaks.duration, applyZoom])

  // log-scale slider position ∈ [0, 1] over [fit, MAX_PX_PER_SEC]
  const fit = fitPxPerSec()
  const sliderPos =
    pxPerSec > 0 && fit > 0 ? Math.log(pxPerSec / fit) / Math.log(MAX_PX_PER_SEC / fit) : 0

  return (
    <div className="waveform-block">
      <div className="waveform" ref={containerRef} />
      <div className="wave-toolbar">
        <span className="wave-zoom-label">Zoom</span>
        <input
          type="range"
          aria-label="Waveform zoom"
          min={0}
          max={1}
          step={0.001}
          value={sliderPos}
          disabled={!ready}
          onChange={(e) => {
            const f = fitPxPerSec()
            if (f > 0) applyZoom(f * Math.pow(MAX_PX_PER_SEC / f, Number(e.target.value)))
          }}
        />
        <button
          className="ghost small"
          title="Zoom out to fit the whole file"
          onClick={() => applyZoom(0)}
          disabled={!ready || pxPerSec === 0}
        >
          Fit
        </button>
        <span className="wave-hint">⌘-scroll to zoom · drag selects a cut</span>
      </div>
    </div>
  )
}
