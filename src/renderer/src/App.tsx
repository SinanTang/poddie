import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fmtBytes, fmtDuration, whisperCostUsd } from '../../shared/format'
import {
  applyChanges,
  deriveItems,
  GAP_MIN_SEC,
  keptRanges,
  mergeWithPrevChanges,
  removedRanges,
  textEditChanges,
  toggleRangeChanges,
  type EditItem,
  type ItemChange
} from '../../shared/edit'
import { buildCues, toSrt } from '../../shared/captions'
import { buildSearchIndex, findMatches } from './lib/transcript'
import { SearchBar } from './components/SearchBar'
import { TranscriptView } from './components/TranscriptView'
import { Waveform } from './components/Waveform'
import type { ApiKeyStatus, AppInfo, PeaksResult, Project, TranscribeProgress, VideoInfo } from '../../shared/types'

function ApiKeyBar({ status, onSaved }: { status: ApiKeyStatus; onSaved: (s: ApiKeyStatus) => void }): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)

  if (status.present) {
    return <span className="key-status ok">key {status.source === 'env' ? 'env' : 'saved'} ✓</span>
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

type ProxyState = { status: 'none' | 'preparing' | 'ready'; path: string | null; fraction: number }

export type SaveStatus =
  | { state: 'clean' }
  | { state: 'pending' }
  | { state: 'saving' }
  | { state: 'saved'; at: string }
  | { state: 'failed' }

interface EditHistory {
  items: EditItem[]
  past: ItemChange[][]
  future: ItemChange[][]
}

export default function App(): React.JSX.Element {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [video, setVideo] = useState<VideoInfo | null>(null)
  const [project, setProject] = useState<Project | null>(null)
  const [editState, setEditState] = useState<EditHistory | null>(null)
  const [keyStatus, setKeyStatus] = useState<ApiKeyStatus | null>(null)
  const [tProgress, setTProgress] = useState<TranscribeProgress | null>(null)
  const [proxy, setProxy] = useState<ProxyState>({ status: 'none', path: null, fraction: 0 })
  const [peaks, setPeaks] = useState<PeaksResult | null>(null)
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null)
  const [query, setQuery] = useState('')
  const [activeMatch, setActiveMatch] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ state: 'clean' })
  const [exporting, setExporting] = useState<{ fraction: number } | null>(null)
  const [exportResult, setExportResult] = useState<string | null>(null)
  const [burnIn, setBurnIn] = useState(false)
  const dirtyRef = useRef(false)

  useEffect(() => {
    window.poddie.getAppInfo().then(setAppInfo).catch(() => setAppInfo(null))
    window.poddie.getApiKeyStatus().then(setKeyStatus).catch(() => setKeyStatus(null))
    const offTranscribe = window.poddie.onTranscribeProgress(setTProgress)
    const offProxy = window.poddie.onProxyProgress((fraction) =>
      setProxy((p) => (p.status === 'preparing' ? { ...p, fraction } : p))
    )
    return () => {
      offTranscribe()
      offProxy()
    }
  }, [])

  // Poll export progress while an export runs. Polling (invoke) survives renderer
  // reloads that would strand a pushed event.sender in the main process.
  const isExporting = exporting !== null
  useEffect(() => {
    if (!isExporting) return
    const id = setInterval(async () => {
      try {
        const fraction = await window.poddie.getExportProgress()
        setExporting((e) => (e ? { fraction } : e))
      } catch {
        // transient; next tick retries
      }
    }, 400)
    return () => clearInterval(id)
  }, [isExporting])

  // (Re)initialize edit state whenever the project changes: saved edits win,
  // otherwise derive words + gap tokens fresh from the transcript
  useEffect(() => {
    if (project?.transcript) {
      const items = project.edit?.items ?? deriveItems(project.transcript.words, project.transcript.durationSec)
      setEditState({ items, past: [], future: [] })
    } else {
      setEditState(null)
    }
    dirtyRef.current = false
    setSaveStatus({ state: 'clean' })
  }, [project])

  const items = editState?.items ?? null

  const applyEdit = useCallback((changes: ItemChange[]) => {
    if (changes.length === 0) return
    dirtyRef.current = true
    setSaveStatus({ state: 'pending' })
    setEditState((s) => s && { items: applyChanges(s.items, changes, 'next'), past: [...s.past, changes], future: [] })
  }, [])

  const undo = useCallback(() => {
    setEditState((s) => {
      if (!s || s.past.length === 0) return s
      dirtyRef.current = true
      setSaveStatus({ state: 'pending' })
      const changes = s.past[s.past.length - 1]
      return { items: applyChanges(s.items, changes, 'prev'), past: s.past.slice(0, -1), future: [changes, ...s.future] }
    })
  }, [])

  const redo = useCallback(() => {
    setEditState((s) => {
      if (!s || s.future.length === 0) return s
      dirtyRef.current = true
      setSaveStatus({ state: 'pending' })
      const changes = s.future[0]
      return { items: applyChanges(s.items, changes, 'next'), past: [...s.past, changes], future: s.future.slice(1) }
    })
  }, [])

  const onToggleRange = useCallback(
    (from: number, to: number) => {
      if (items) applyEdit(toggleRangeChanges(items, from, to))
    },
    [items, applyEdit]
  )

  // In-place text edits change display/caption text only — cut timing and the
  // export are derived from time + removed, never from text (see shared/edit.ts)
  const onEditText = useCallback(
    (index: number, text: string) => {
      if (items) applyEdit(textEditChanges(items, index, text))
    },
    [items, applyEdit]
  )

  // Returns whether a merge happened (a gap token blocks merging) so the
  // editor can keep the user's draft instead of silently dropping it.
  const onMergeWithPrev = useCallback(
    (index: number, draftText: string): boolean => {
      if (!items) return false
      const changes = mergeWithPrevChanges(items, index, draftText)
      applyEdit(changes)
      return changes.length > 0
    },
    [items, applyEdit]
  )

  // waveform drag-selection deletes every item the span meaningfully overlaps
  const onWaveformSelect = useCallback(
    (start: number, end: number) => {
      if (!items) return
      const changes: ItemChange[] = []
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        if (item.removed) continue
        const overlap = Math.min(item.end, end) - Math.max(item.start, start)
        if (overlap > Math.min(0.05, (item.end - item.start) / 2)) {
          changes.push({ index: i, prev: { removed: false }, next: { removed: true } })
        }
      }
      applyEdit(changes)
    },
    [items, applyEdit]
  )

  // debounced autosave of edit state into the project file
  useEffect(() => {
    if (!video || !items || !dirtyRef.current) return
    const timer = setTimeout(() => {
      dirtyRef.current = false
      setSaveStatus({ state: 'saving' })
      window.poddie
        .saveEdit(video.path, { version: 1, gapMinSec: GAP_MIN_SEC, items })
        .then(() => setSaveStatus({ state: 'saved', at: new Date().toLocaleTimeString() }))
        .catch((err) => {
          setSaveStatus({ state: 'failed' })
          setError(`Autosave failed: ${err instanceof Error ? err.message : String(err)}`)
        })
    }, 800)
    return () => clearTimeout(timer)
  }, [items, video])

  const cuts = useMemo(() => (items ? removedRanges(items) : []), [items])
  const kept = useMemo(
    () => (items && video ? keptRanges(items, video.durationSec) : []),
    [items, video]
  )

  // preview controller: while playing, hop over removed ranges
  useEffect(() => {
    if (!videoEl || cuts.length === 0) return
    const duration = video?.durationSec ?? 0
    let raf = 0
    const tick = (): void => {
      if (!videoEl.paused && !videoEl.seeking) {
        const t = videoEl.currentTime
        for (const r of cuts) {
          if (r.start > t) break
          if (t >= r.start && t < r.end - 0.01) {
            if (r.end >= duration - 0.05) {
              videoEl.pause()
              videoEl.currentTime = r.start
            } else {
              videoEl.currentTime = r.end + 0.001
            }
            break
          }
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [videoEl, cuts, video])

  async function openVideo(): Promise<void> {
    setError(null)
    setBusy('Reading video metadata…')
    try {
      const info = await window.poddie.selectVideo()
      if (info) {
        setVideo(info)
        setProject(null)
        setTProgress(null)
        setPeaks(null)
        setQuery('')
        setProxy({ status: info.needsProxy ? 'preparing' : 'none', path: null, fraction: 0 })
        setProject(await window.poddie.loadProject(info.path))

        window.poddie
          .getPeaks(info.path)
          .then(setPeaks)
          .catch((err) => setError(`Waveform unavailable: ${err instanceof Error ? err.message : String(err)}`))
        if (info.needsProxy) {
          window.poddie
            .ensureProxy(info.path)
            .then(({ proxyPath }) => setProxy({ status: 'ready', path: proxyPath, fraction: 1 }))
            .catch((err) => {
              setProxy({ status: 'none', path: null, fraction: 0 })
              setError(`Preview proxy failed: ${err instanceof Error ? err.message : String(err)}`)
            })
        }
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
      const result = await window.poddie.transcribe(video.path)
      if (result) setProject(result) // null = user canceled the cost dialog
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setTProgress(null)
    } finally {
      setBusy(null)
    }
  }

  async function doExport(kind: 'video' | 'audio'): Promise<void> {
    if (!video || kept.length === 0) return
    setError(null)
    setExportResult(null)
    let burnInSrt: string | undefined
    if (kind === 'video' && burnIn && items) {
      burnInSrt = toSrt(buildCues(items, video.durationSec))
      if (!burnInSrt) {
        setError('No captions to burn in: every word is cut or blank')
        return
      }
    }
    setExporting({ fraction: 0 })
    try {
      const result = await window.poddie.exportMedia(video.path, kept, kind, burnInSrt)
      if (result) setExportResult(result.outPath) // null = dialog or mid-export cancel
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setExporting(null)
    }
  }

  async function doExportCaptions(): Promise<void> {
    if (!video || !items) return
    setError(null)
    try {
      const srt = toSrt(buildCues(items, video.durationSec))
      if (!srt) {
        setError('No captions to export: every word is cut or blank')
        return
      }
      const result = await window.poddie.exportCaptions(video.path, srt)
      if (result) setExportResult(result.outPath)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const transcript = project?.transcript ?? null
  const searchIndex = useMemo(() => (items ? buildSearchIndex(items) : null), [items])
  const matches = useMemo(() => (searchIndex ? findMatches(searchIndex, query) : []), [searchIndex, query])

  useEffect(() => {
    setActiveMatch(0)
  }, [query])

  const navigate = useCallback(
    (direction: 1 | -1) => {
      if (matches.length > 0) setActiveMatch((a) => (a + direction + matches.length) % matches.length)
    },
    [matches.length]
  )

  // Global keys: space play/pause, ←/→ nudge 3 s, ⌘F search, ⌘Z/⇧⌘Z undo/redo
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        document.getElementById('transcript-search')?.focus()
        return
      }
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
        return
      }
      if (!videoEl) return
      if (e.code === 'Space') {
        e.preventDefault()
        if (videoEl.paused) void videoEl.play()
        else videoEl.pause()
      } else if (e.key === 'ArrowLeft') {
        videoEl.currentTime = Math.max(0, videoEl.currentTime - 3)
      } else if (e.key === 'ArrowRight') {
        videoEl.currentTime += 3
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [videoEl, undo, redo])

  const playerPath = video ? (video.needsProxy ? proxy.path : video.path) : null
  const playerSrc = playerPath && appInfo ? `${appInfo.mediaBaseUrl}/${encodeURIComponent(playerPath)}` : null
  const costEstimate = video ? whisperCostUsd(video.durationSec).toFixed(2) : null
  const keptSec = kept.reduce((acc, r) => acc + r.end - r.start, 0)
  const cutSec = video ? Math.max(0, video.durationSec - keptSec) : 0

  return (
    <div className="app">
      <header>
        <h1>Poddie</h1>
        {transcript && (
          <SearchBar
            query={query}
            onQueryChange={setQuery}
            matchCount={matches.length}
            activeMatch={activeMatch}
            onNavigate={navigate}
          />
        )}
        <span className="spacer" />
        {keyStatus && <ApiKeyBar status={keyStatus} onSaved={setKeyStatus} />}
        <button onClick={openVideo} disabled={busy !== null}>
          Open Video…
        </button>
      </header>

      {error && (
        <div className="error">
          {error}
          {appInfo && <div className="error-hint">Full details: {appInfo.logPath}</div>}
        </div>
      )}

      {video ? (
        <>
          <div className="workspace">
            <div className="transcript-pane">
              {items ? (
                <TranscriptView
                  items={items}
                  segments={transcript?.segments ?? []}
                  videoEl={videoEl}
                  matches={matches}
                  activeMatch={activeMatch}
                  onToggleRange={onToggleRange}
                  onEditText={onEditText}
                  onMergeWithPrev={onMergeWithPrev}
                  canUndo={(editState?.past.length ?? 0) > 0}
                  canRedo={(editState?.future.length ?? 0) > 0}
                  onUndo={undo}
                  onRedo={redo}
                  saveStatus={saveStatus}
                />
              ) : (
                <div className="empty-state">
                  <p>No transcript yet.</p>
                  <button onClick={transcribe} disabled={busy !== null || !keyStatus?.present || !video.audioCodec}>
                    Transcribe (~${costEstimate})
                  </button>
                  {!keyStatus?.present && <p className="hint">Set an OpenAI API key first (top right).</p>}
                  {tProgress && busy && (
                    <span className="progress">
                      <progress value={tProgress.fraction} max={1} /> {tProgress.message}
                    </span>
                  )}
                </div>
              )}
            </div>

            <aside className="video-pane">
              {playerSrc ? (
                <video ref={setVideoEl} key={playerSrc} className="player" controls src={playerSrc} />
              ) : (
                <div className="proxy-progress">
                  <p>Preparing preview…</p>
                  <progress value={proxy.fraction} max={1} />
                </div>
              )}
              <div className="meta-compact">
                <div>{video.path.split('/').pop()}</div>
                <div>
                  {fmtDuration(video.durationSec)} · {video.width}×{video.height} · {video.videoCodec}
                  {video.needsProxy && ' (proxy preview)'} · {fmtBytes(video.sizeBytes)}
                </div>
                {transcript && (
                  <div>
                    {transcript.words.length.toLocaleString()} tokens · {transcript.language}
                    {transcript.costUsd != null && ` · $${transcript.costUsd.toFixed(2)}`}
                  </div>
                )}
                {cutSec > 0.05 && (
                  <div className="edit-summary">
                    Edited: {fmtDuration(keptSec)} kept · {fmtDuration(cutSec)} cut
                  </div>
                )}
              </div>
              {items && (
                <div className="export-block">
                  {exporting ? (
                    <>
                      <span className="progress">
                        <progress value={exporting.fraction} max={1} /> Exporting…{' '}
                        {Math.round(exporting.fraction * 100)}%
                      </span>
                      <button className="ghost small" onClick={() => void window.poddie.cancelExport()}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <label
                        className="burnin"
                        title={
                          appInfo?.canBurnCaptions
                            ? 'Render the captions into the video frames'
                            : 'Needs an ffmpeg build with libass (subtitles filter) — brew ffmpeg lacks it'
                        }
                      >
                        <input
                          type="checkbox"
                          checked={burnIn && (appInfo?.canBurnCaptions ?? false)}
                          onChange={(e) => setBurnIn(e.target.checked)}
                          disabled={!appInfo?.canBurnCaptions}
                        />
                        Burn captions into video
                      </label>
                      <button onClick={() => void doExport('video')} disabled={kept.length === 0}>
                        Export {fmtDuration(keptSec)} video…
                      </button>
                      <button
                        className="ghost"
                        onClick={() => void doExport('audio')}
                        disabled={kept.length === 0 || !video.audioCodec}
                        title="M4A or MP3 for podcast feeds — same cuts, no video"
                      >
                        Export audio only…
                      </button>
                      <button
                        className="ghost"
                        onClick={() => void doExportCaptions()}
                        disabled={kept.length === 0}
                        title="SRT sidecar on the edited timeline — upload alongside the video"
                      >
                        Export captions (.srt)…
                      </button>
                    </>
                  )}
                  {exportResult && (
                    <div className="export-result">
                      ✓ Exported
                      <button className="ghost small" onClick={() => void window.poddie.revealFile(exportResult)}>
                        Show in Finder
                      </button>
                    </div>
                  )}
                </div>
              )}
              {transcript && (
                <button className="ghost small" onClick={transcribe} disabled={busy !== null || exporting !== null || !keyStatus?.present}>
                  Re-transcribe…
                </button>
              )}
              {tProgress && busy && transcript && (
                <span className="progress">
                  <progress value={tProgress.fraction} max={1} /> {tProgress.message}
                </span>
              )}
            </aside>
          </div>

          <footer className="wave-pane">
            {videoEl && peaks ? (
              <Waveform mediaEl={videoEl} peaks={peaks} removedRanges={cuts} onRangeSelect={onWaveformSelect} />
            ) : (
              <div className="waveform-placeholder" />
            )}
          </footer>
        </>
      ) : (
        !busy && (
          <div className="empty-state">
            <p className="hint">Open an iPhone recording (.mov / .mp4) to get started.</p>
          </div>
        )
      )}
    </div>
  )
}
