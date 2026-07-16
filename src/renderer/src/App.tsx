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
  trimSilenceChanges,
  type EditItem,
  type ItemChange
} from '../../shared/edit'
import { buildCues, toSrt } from '../../shared/captions'
import { buildSearchIndex, findMatches } from './lib/transcript'
import { errText } from './lib/errors'
import { FeedbackDialog } from './components/FeedbackDialog'
import { SearchBar } from './components/SearchBar'
import { TranscriptView } from './components/TranscriptView'
import { Waveform } from './components/Waveform'
import type {
  ApiKeyStatus,
  AppInfo,
  PeaksResult,
  Project,
  TranscribeEngine,
  TranscribeProgress,
  VideoInfo
} from '../../shared/types'

function ApiKeyBar({ status, onSaved }: { status: ApiKeyStatus; onSaved: (s: ApiKeyStatus) => void }): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)

  // A key from the environment always wins and can't be changed in-app; just show it.
  if (status.present && status.source === 'env') {
    return <span className="key-status ok">key env ✓</span>
  }

  // A stored key stays editable — a typo'd or revoked key must be recoverable
  // without hand-editing config.json.
  if (status.present && !editing) {
    return (
      <span className="key-status ok">
        key saved ✓
        <button className="link" onClick={() => { setDraft(''); setError(null); setEditing(true) }}>Change</button>
        <button className="link" onClick={async () => onSaved(await window.poddie.clearApiKey())}>Remove</button>
      </span>
    )
  }

  async function save(): Promise<void> {
    setError(null)
    try {
      onSaved(await window.poddie.setApiKey(draft))
      setDraft('')
      setEditing(false)
    } catch (err) {
      setError(errText(err))
    }
  }

  return (
    <span className="key-entry">
      <input
        type="password"
        placeholder="OpenAI API key (sk-…)"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && draft.trim() !== '' && save()}
      />
      <button className="ghost" onClick={save} disabled={draft.trim() === ''}>
        Save key
      </button>
      {status.present && (
        <button className="link" onClick={() => { setEditing(false); setError(null) }}>Cancel</button>
      )}
      {error && <span className="key-error">{error}</span>}
    </span>
  )
}

/** ⚙ popover for the once-in-a-while choices: transcribe engine + API key. */
function SettingsMenu({
  appInfo,
  engine,
  onEngineChange,
  keyStatus,
  onKeySaved
}: {
  appInfo: AppInfo | null
  engine: TranscribeEngine
  onEngineChange: (engine: TranscribeEngine) => void
  keyStatus: ApiKeyStatus | null
  onKeySaved: (s: ApiKeyStatus) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onMouseDown(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className="settings" ref={ref}>
      <button
        className="ghost icon"
        title="Settings"
        aria-label="Settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        ⚙
      </button>
      {open && (
        <div className="popover" role="dialog" aria-label="Settings">
          <div className="popover-row">
            <span className="popover-label">Transcribe with</span>
            <select
              value={engine}
              onChange={(e) => onEngineChange(e.target.value as TranscribeEngine)}
              title={appInfo?.localWhisper.hint ?? undefined}
            >
              <option value="local" disabled={!appInfo?.localWhisper.available}>
                Local model (free)
              </option>
              <option value="api">OpenAI API</option>
            </select>
            {engine === 'local' && appInfo && !appInfo.localWhisper.modelPresent && (
              <span className="popover-hint">First local run downloads the Whisper model (~1.6 GB)</span>
            )}
          </div>
          {engine === 'api' && keyStatus && (
            <div className="popover-row">
              <span className="popover-label">OpenAI API key</span>
              <ApiKeyBar status={keyStatus} onSaved={onKeySaved} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** The one progress pattern for every long-running job (proxy, transcribe, export). */
function ProgressLine({
  label,
  fraction,
  onCancel
}: {
  label: string
  fraction: number
  onCancel?: () => void
}): React.JSX.Element {
  return (
    <div className="progress-line">
      <div className="progress-line-head">
        <span className="progress-label">{label}</span>
        <span className="progress-pct">{Math.round(fraction * 100)}%</span>
        {onCancel && (
          <button className="ghost small" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      <progress aria-label={label} value={fraction} max={1} />
    </div>
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
  const [engine, setEngine] = useState<TranscribeEngine>(() =>
    localStorage.getItem('poddie.engine') === 'local' ? 'local' : 'api'
  )
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
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const dirtyRef = useRef(false)
  // dragenter/dragleave fire on every child transition — only depth 0↔1 matters
  const dragDepth = useRef(0)

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

  // The engine picks the active project file (api → .poddie.json, local →
  // .poddie.local.json) — loading lives here so opening a video and flipping
  // the engine are the same code path.
  const videoPath = video?.path ?? null
  useEffect(() => {
    if (!videoPath) return
    let stale = false
    window.poddie
      .loadProject(videoPath, engine)
      .then((p) => {
        if (!stale) setProject(p)
      })
      .catch((err) => setError(`Could not load project: ${errText(err)}`))
    return () => {
      stale = true
    }
  }, [videoPath, engine])

  function switchEngine(next: TranscribeEngine): void {
    // a pending autosave must not follow the flip and write into the other
    // engine's project file — the edit state re-initializes on reload anyway
    dirtyRef.current = false
    localStorage.setItem('poddie.engine', next)
    setEngine(next)
  }

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

  // debounced autosave of edit state into the active engine's project file
  useEffect(() => {
    if (!video || !items || !dirtyRef.current) return
    const timer = setTimeout(() => {
      dirtyRef.current = false
      setSaveStatus({ state: 'saving' })
      window.poddie
        .saveEdit(video.path, { version: 1, gapMinSec: GAP_MIN_SEC, items }, engine)
        .then(() => setSaveStatus({ state: 'saved', at: new Date().toLocaleTimeString() }))
        .catch((err) => {
          setSaveStatus({ state: 'failed' })
          setError(`Autosave failed: ${errText(err)}`)
        })
    }, 800)
    return () => clearTimeout(timer)
  }, [items, video, engine])

  // pending bulk silence trims — recomputed as edits change, applied as ONE undo step
  const silenceTrims = useMemo(() => (items ? trimSilenceChanges(items) : []), [items])
  const onTrimSilences = useCallback(() => applyEdit(silenceTrims), [silenceTrims, applyEdit])

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

  // One load path for both entries (dialog + drag-and-drop): reset per-video
  // state, then kick off peaks and (if needed) the preview proxy.
  function loadVideoInfo(info: VideoInfo): void {
    setVideo(info)
    setProject(null)
    setTProgress(null)
    setPeaks(null)
    setQuery('')
    setProxy({ status: info.needsProxy ? 'preparing' : 'none', path: null, fraction: 0 })
    // the [videoPath, engine] effect loads the project for the active engine

    window.poddie
      .getPeaks(info.path)
      .then(setPeaks)
      .catch((err) => setError(`Waveform unavailable: ${errText(err)}`))
    if (info.needsProxy) {
      window.poddie
        .ensureProxy(info.path)
        .then(({ proxyPath }) => setProxy({ status: 'ready', path: proxyPath, fraction: 1 }))
        .catch((err) => {
          setProxy({ status: 'none', path: null, fraction: 0 })
          setError(`Preview proxy failed: ${errText(err)}`)
        })
    }
  }

  async function openVideo(): Promise<void> {
    setError(null)
    setBusy('Reading video metadata…')
    try {
      const info = await window.poddie.selectVideo()
      if (info) loadVideoInfo(info)
    } catch (err) {
      setError(errText(err))
    } finally {
      setBusy(null)
    }
  }

  async function openDroppedPath(path: string): Promise<void> {
    setError(null)
    setBusy('Reading video metadata…')
    try {
      loadVideoInfo(await window.poddie.openVideoPath(path))
    } catch (err) {
      setError(errText(err))
    } finally {
      setBusy(null)
    }
  }

  async function transcribe(): Promise<void> {
    if (!video) return
    setError(null)
    setBusy('Transcribing…')
    try {
      const result = await window.poddie.transcribe(video.path, engine)
      if (result) setProject(result) // null = user canceled the confirmation dialog
    } catch (err) {
      setError(errText(err))
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
      setError(errText(err))
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
      setError(errText(err))
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
      if (feedbackOpen) return // modal owns the keyboard (its own listener handles Escape)
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
  }, [videoEl, undo, redo, feedbackOpen])

  const playerPath = video ? (video.needsProxy ? proxy.path : video.path) : null
  const playerSrc = playerPath && appInfo ? `${appInfo.mediaBaseUrl}/${encodeURIComponent(playerPath)}` : null
  const costEstimate = video ? whisperCostUsd(video.durationSec).toFixed(2) : null
  const keptSec = kept.reduce((acc, r) => acc + r.end - r.start, 0)
  const cutSec = video ? Math.max(0, video.durationSec - keptSec) : 0

  const hasFiles = (e: React.DragEvent): boolean => e.dataTransfer.types.includes('Files')

  return (
    <div
      className="app"
      onDragEnter={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        if (++dragDepth.current === 1) setDragOver(true)
      }}
      onDragOver={(e) => {
        if (hasFiles(e)) e.preventDefault()
      }}
      onDragLeave={() => {
        if (dragDepth.current > 0 && --dragDepth.current === 0) setDragOver(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        dragDepth.current = 0
        setDragOver(false)
        if (busy !== null) return // mirrors the disabled Open Video button
        const file = e.dataTransfer.files[0]
        if (file) void openDroppedPath(window.poddie.pathForFile(file))
      }}
    >
      {dragOver && (
        <div className="drop-overlay">
          <span>Drop to open video</span>
        </div>
      )}
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
        <button className="ghost" onClick={() => setFeedbackOpen(true)}>
          Send beta feedback
        </button>
        <SettingsMenu
          appInfo={appInfo}
          engine={engine}
          onEngineChange={switchEngine}
          keyStatus={keyStatus}
          onKeySaved={setKeyStatus}
        />
        <button className="ghost" onClick={openVideo} disabled={busy !== null}>
          Open Video…
        </button>
      </header>

      {feedbackOpen && <FeedbackDialog onClose={() => setFeedbackOpen(false)} />}

      {error && (
        <div className="error" role="alert">
          <div className="error-body">
            {error}
            {appInfo && <div className="error-hint">Full details: {appInfo.logPath}</div>}
          </div>
          <button className="error-close" onClick={() => setError(null)} title="Dismiss" aria-label="Dismiss error">
            ✕
          </button>
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
                  silenceTrimCount={silenceTrims.length}
                  onTrimSilences={onTrimSilences}
                  canUndo={(editState?.past.length ?? 0) > 0}
                  canRedo={(editState?.future.length ?? 0) > 0}
                  onUndo={undo}
                  onRedo={redo}
                  saveStatus={saveStatus}
                />
              ) : (
                <div className="empty-state">
                  <span className="step-label">Step 2 of 3 · Transcribe</span>
                  <p>No transcript yet — transcribe to start editing.</p>
                  <button
                    className="big"
                    onClick={transcribe}
                    disabled={busy !== null || (engine === 'api' && !keyStatus?.present) || !video.audioCodec}
                  >
                    {engine === 'local' ? 'Transcribe locally (free)' : `Transcribe (~$${costEstimate})`}
                  </button>
                  {engine === 'api' && !keyStatus?.present && (
                    <p className="hint">Add an OpenAI API key in ⚙ Settings (top right), or switch to the local model.</p>
                  )}
                  {engine === 'local' && appInfo && !appInfo.localWhisper.modelPresent && (
                    <p className="hint">First run downloads the local model (~1.6 GB).</p>
                  )}
                  {tProgress && busy && (
                    <div className="empty-progress">
                      <ProgressLine label={tProgress.message} fraction={tProgress.fraction} />
                    </div>
                  )}
                </div>
              )}
            </div>

            <aside className="video-pane">
              {playerSrc ? (
                <video ref={setVideoEl} key={playerSrc} className="player" controls src={playerSrc} />
              ) : (
                <div className="proxy-progress">
                  <ProgressLine label="Preparing preview…" fraction={proxy.fraction} />
                </div>
              )}

              <div className="card">
                <div className="card-title">Media</div>
                <div className="meta-compact">
                  <div>{video.path.split('/').pop()}</div>
                  <div>
                    {fmtDuration(video.durationSec)} · {video.width}×{video.height} · {video.videoCodec}
                    {video.needsProxy && ' (proxy preview)'} · {fmtBytes(video.sizeBytes)}
                  </div>
                </div>
              </div>

              {items && (
                <div className="card">
                  <div className="card-title">Export</div>
                  {cutSec > 0.05 && (
                    <div className="edit-summary">
                      {fmtDuration(keptSec)} kept · {fmtDuration(cutSec)} cut
                    </div>
                  )}
                  {exporting ? (
                    <ProgressLine
                      label="Exporting…"
                      fraction={exporting.fraction}
                      onCancel={() => void window.poddie.cancelExport()}
                    />
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
                    <div className="export-success">
                      <span>✓ Exported {exportResult.split('/').pop()}</span>
                      <button className="ghost small" onClick={() => void window.poddie.revealFile(exportResult)}>
                        Show in Finder
                      </button>
                    </div>
                  )}
                </div>
              )}

              {transcript && (
                <div className="card">
                  <div className="card-title">Transcription</div>
                  <div className="meta-compact">
                    <div>
                      {transcript.words.length.toLocaleString()} tokens · {transcript.language}
                      {transcript.costUsd != null && ` · $${transcript.costUsd.toFixed(2)}`}
                    </div>
                  </div>
                  <button
                    className="ghost small"
                    onClick={transcribe}
                    disabled={busy !== null || exporting !== null || (engine === 'api' && !keyStatus?.present)}
                  >
                    Re-transcribe…
                  </button>
                  {tProgress && busy && <ProgressLine label={tProgress.message} fraction={tProgress.fraction} />}
                </div>
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
            <div className="drop-zone">
              <span className="step-label">Step 1 of 3 · Open</span>
              <p>Edit a video podcast by editing its transcript.</p>
              <button className="big" onClick={openVideo}>
                Open Video…
              </button>
              <p className="hint">or drop a .mov / .mp4 anywhere in this window</p>
            </div>
          </div>
        )
      )}
    </div>
  )
}
