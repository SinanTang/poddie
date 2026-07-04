import { useState } from 'react'
import type { AudioExtractResult, VideoInfo } from '../../shared/types'

function mediaUrl(path: string): string {
  return `media://${path.split('/').map(encodeURIComponent).join('/')}`
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${Math.round(n / 1024)} KB`
}

function fmtDuration(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

export default function App(): React.JSX.Element {
  const [video, setVideo] = useState<VideoInfo | null>(null)
  const [audio, setAudio] = useState<AudioExtractResult | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function openVideo(): Promise<void> {
    setError(null)
    setBusy('Reading video metadata…')
    try {
      const info = await window.poddie.selectVideo()
      if (info) {
        setVideo(info)
        setAudio(null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  async function extract(): Promise<void> {
    if (!video) return
    setError(null)
    setBusy('Extracting audio…')
    try {
      setAudio(await window.poddie.extractAudio(video.path))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="app">
      <header>
        <h1>Poddie</h1>
        <button onClick={openVideo} disabled={busy !== null}>
          Open Video…
        </button>
        {busy && <span className="busy">{busy}</span>}
      </header>

      {error && <div className="error">{error}</div>}

      {video && (
        <main>
          {video.needsProxy ? (
            <div className="warning">
              Codec “{video.videoCodec}” can’t be previewed directly (iPhone HEVC). An H.264
              preview proxy will handle this in Phase 3 — metadata and audio extraction still work.
            </div>
          ) : (
            <video className="player" controls src={mediaUrl(video.path)} />
          )}

          <dl className="meta">
            <dt>File</dt>
            <dd>{video.path}</dd>
            <dt>Duration</dt>
            <dd>{fmtDuration(video.durationSec)}</dd>
            <dt>Resolution</dt>
            <dd>
              {video.width}×{video.height} @ {video.fps.toFixed(2)} fps
            </dd>
            <dt>Codecs</dt>
            <dd>
              {video.videoCodec} / {video.audioCodec ?? 'no audio'}
            </dd>
            <dt>Size</dt>
            <dd>{fmtBytes(video.sizeBytes)}</dd>
          </dl>

          <div className="actions">
            <button onClick={extract} disabled={busy !== null || !video.audioCodec}>
              Extract Audio (Whisper prep)
            </button>
            {audio && (
              <span className="audio-result">
                → {audio.audioPath} ({fmtBytes(audio.sizeBytes)})
              </span>
            )}
          </div>
        </main>
      )}

      {!video && !busy && <p className="hint">Open an iPhone recording (.mov / .mp4) to get started.</p>}
    </div>
  )
}
