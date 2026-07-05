import { useEffect, useRef } from 'react'
import WaveSurfer from 'wavesurfer.js'
import type { PeaksResult } from '../../../shared/types'

interface WaveformProps {
  /** The app's <video> element — wavesurfer binds to it for time/seek sync. */
  mediaEl: HTMLVideoElement
  peaks: PeaksResult
}

export function Waveform({ mediaEl, peaks }: WaveformProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)

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
    return () => ws.destroy()
  }, [mediaEl, peaks])

  return <div className="waveform" ref={containerRef} />
}
