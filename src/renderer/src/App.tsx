import { useEffect, useState } from 'react'
import type { ApiKeyStatus, Project, TranscribeProgress, VideoInfo } from '../../shared/types'

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

function ApiKeyBar({ status, onSaved }: { status: ApiKeyStatus; onSaved: (s: ApiKeyStatus) => void }): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)

  if (status.present) {
    return <span className="key-status ok">API key: {status.source === 'env' ? 'from env' : 'saved'} ✓</span>
  }

  async function save(): Promise<void> {
    setError(null)
    try {
      onSaved(await window.poddie.setApiKey(draft))
      setDraft('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <span className="key-entry">
      <input
        type="password"
        placeholder="OpenAI API key (sk-…)"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <button onClick={save} disabled={draft.trim() === ''}>
        Save key
      </button>
      {error && <span className="key-error">{error}</span>}
    </span>
  )
}

function TranscriptPreview({ project }: { project: Project }): React.JSX.Element | null {
  const t = project.transcript
  if (!t) return null
  return (
    <section className="transcript">
      <h2>
        Transcript · {t.words.length.toLocaleString()} words · {t.language} ·{' '}
        {new Date(t.createdAt).toLocaleString()}
      </h2>
      <div className="transcript-body">
        {t.segments.length > 0
          ? t.segments.map((s, i) => <p key={i}>{s.text}</p>)
          : t.words.map((w) => w.text).join(' ')}
      </div>
    </section>
  )
}

export default function App(): React.JSX.Element {
  const [video, setVideo] = useState<VideoInfo | null>(null)
  const [project, setProject] = useState<Project | null>(null)
  const [keyStatus, setKeyStatus] = useState<ApiKeyStatus | null>(null)
  const [progress, setProgress] = useState<TranscribeProgress | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.poddie.getApiKeyStatus().then(setKeyStatus).catch(() => setKeyStatus(null))
    return window.poddie.onTranscribeProgress(setProgress)
  }, [])

  async function openVideo(): Promise<void> {
    setError(null)
    setBusy('Reading video metadata…')
    try {
      const info = await window.poddie.selectVideo()
      if (info) {
        setVideo(info)
        setProgress(null)
        setProject(await window.poddie.loadProject(info.path))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  async function transcribe(): Promise<void> {
    if (!video) return
    setError(null)
    setBusy('Transcribing…')
    try {
      setProject(await window.poddie.transcribe(video.path))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setProgress(null)
    } finally {
      setBusy(null)
    }
  }

  const hasTranscript = project?.transcript != null
  const costEstimate = video ? ((video.durationSec / 60) * 0.006).toFixed(2) : null

  return (
    <div className="app">
      <header>
        <h1>Poddie</h1>
        {keyStatus && <ApiKeyBar status={keyStatus} onSaved={setKeyStatus} />}
        <button onClick={openVideo} disabled={busy !== null}>
          Open Video…
        </button>
        {busy && !progress && <span className="busy">{busy}</span>}
      </header>

      {error && <div className="error">{error}</div>}

      {video && (
        <main>
          {video.needsProxy ? (
            <div className="warning">
              Codec “{video.videoCodec}” can’t be previewed directly (iPhone HEVC). An H.264
              preview proxy will handle this in Phase 3 — transcription works regardless.
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
            <button
              onClick={transcribe}
              disabled={busy !== null || !keyStatus?.present || !video.audioCodec}
              title={keyStatus?.present ? '' : 'Set an OpenAI API key first'}
            >
              {hasTranscript ? 'Re-transcribe' : 'Transcribe'} (~${costEstimate})
            </button>
            {progress && busy && (
              <span className="progress">
                <progress value={progress.fraction} max={1} /> {progress.message}
              </span>
            )}
          </div>

          {project && <TranscriptPreview project={project} />}
        </main>
      )}

      {!video && !busy && <p className="hint">Open an iPhone recording (.mov / .mp4) to get started.</p>}
    </div>
  )
}
