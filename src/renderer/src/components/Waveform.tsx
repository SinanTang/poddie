import { useEffect, useRef } from 'react'
import WaveSurfer from 'wavesurfer.js'
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js'
import type { PeaksResult } from '../../../shared/types'
import type { TimeRange } from '../../../shared/edit'

const CUT_ID = 'cut-'
const CUT_COLOR = 'rgba(239, 68, 68, 0.28)'
const SELECT_COLOR = 'rgba(59, 130, 246, 0.35)'

interface WaveformProps {
  /** The app's <video> element — wavesurfer binds to it for time/seek sync. */
  mediaEl: HTMLVideoElement
  peaks: PeaksResult
  /** Removed spans, shaded red on the waveform. */
  removedRanges: TimeRange[]
  /** User dragged a selection on the waveform → delete that time span. */
  onRangeSelect: (start: number, end: number) => void
}

export function Waveform({ mediaEl, peaks, removedRanges, onRangeSelect }: WaveformProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const regionsRef = useRef<RegionsPlugin | null>(null)
  const onRangeSelectRef = useRef(onRangeSelect)
  onRangeSelectRef.current = onRangeSelect

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
      barGap: 1
    })
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
    return () => {
      regionsRef.current = null
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

  return <div className="waveform" ref={containerRef} />
}
