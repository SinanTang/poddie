# Progress Log: Poddie MVP

## Session 2026-07-04
- Verified environment: ffmpeg/ffprobe present (homebrew), Node 22, empty repo
- Wrote task_plan.md (6 phases), findings.md (env + Whisper/ffmpeg facts)
- Correction: first draft of task_plan.md wrongly marked phases complete;
  rewritten with all phases pending — no code exists yet
- Next: user review of plan → Phase 1 scaffold

## Session 2026-07-05 (Phase 1)
- Scaffolded Electron + Vite + React + TS manually (no interactive CLI): package.json,
  electron.vite.config.ts, tsconfig, eslint flat config
- src/shared/types.ts (typed IPC contract), src/main/{ffmpeg,media,index}.ts,
  src/preload/index.ts, src/renderer (App with open/probe/extract UI, media:// protocol)
- Hit + resolved: macOS EPERM-uv_cwd blocker (user-side fix), broken homebrew ffmpeg
  (brew reinstall) — details in task_plan errors table
- User added footage/IMG_0470.MOV (real iPhone clip) + gitignore entry

## Session 2026-07-05 (Phase 3)
- Full transcript exists: 9,021 tokens / 1,297 segments / chinese / $0.27; first
  line "OK大家好…" confirms MIXED zh+en content
- New: shared/cjk.ts (needsSpaceBetween/joinTokens), renderer lib/transcript.ts
  (SearchIndex w/ char-offset maps, findMatches, findWordAtTime, buildParagraphs
  w/ 50-word min merge), components/ (TranscriptView w/ memoized ParagraphView,
  SearchBar, Waveform), App.tsx 3-pane layout rewrite, app.css rewrite
- ffmpeg.ts: +runToolBuffer (PCM), +runToolProgress (spawn + -progress parse)
- media.ts: +ensurePreviewProxy (videotoolbox→x264 fallback), +computePeaks
  (8 kHz s16le → 4000 buckets, JSON-cached)
- Tests 40/40 ✅ typecheck ✅ lint ✅ (incl. real HEVC→proxy round-trip, CJK
  search cases from the actual transcript)
- Pre-warmed 44-min proxy into app cache (background ffmpeg, key 8eae1de9d0de2961)

## Session 2026-07-05 (Phase 4)
- shared/edit.ts: EditItem (word|gap unified), deriveItems, removedRanges (merge
  + micro-hole absorption), keptRanges (complement + sliver drop),
  toggleRangeChanges (delete-or-restore), applyChanges (immutable, reversible)
- Persistence: project.edit = full EditState (items incl. text/times/removed) —
  chose duplication over parallel-array indices for corruption-resistance
- TranscriptView: custom selection (drag/shift-click, native selection off),
  gap chips, cut styling, Delete/Escape keys, undo/redo toolbar
- Waveform: cut shading + enableDragSelection → delete via overlap mapping
- App: EditHistory state, ⌘Z/⇧⌘Z, debounced autosave, skip-preview rAF
  controller, edited-duration summary
- lib/transcript.ts genericized to TimedToken (items with zero-width gaps);
  fixed spacing bug for empty tokens in search index
- Tests 63/63 ✅ typecheck ✅ lint ✅ (edit.test.ts covers the plan's "test
  hard" list: empty edit, everything removed, adjacent merge, micro-holes,
  toggle semantics, undo reversibility)

## Session 2026-07-05 (Phase 4 follow-ups + Phase 5)
- Autosave made visible (user report "can't see progress saved"): SaveStatus
  state machine (clean/pending/saving/saved/failed) + toolbar indicator with
  timestamp; verified saves were already landing via log + project json
- Explained edit-merge model to user (no operation log — per-token boolean
  snapshot, last write wins; ranges coalesce at read time)
- Phase 5 export shipped: export.ts (buildExportArgs pure + exportVideo with
  VT→x264 fallback, .part rename, AbortSignal cancel), runToolProgress gained
  signal param, IPC export:start/cancel/progress/reveal, video-pane UI
  (progress + Cancel + Show in Finder)
- Export format Q&A → findings (already-optimal MP4/H.264/AAC/faststart);
  audio-only export logged as Phase 5.5 candidate
- Tests 69/69 ✅ typecheck ✅ lint ✅ (export: 4 builder unit tests + real
  3-cut ffmpeg export w/ A/V sync probe + cancel cleanup)
- Pending user verification: listen across cut joins on a real full export

## Session 2026-07-05 (export bugs: interruption + progress)
- Corrupt export (moov-atom-missing, QuickTime won't open): caused by ME editing
  files during an active export → dev --watch hot-restarts main → orphaned ffmpeg
  mid-run. Lesson: never edit src/ while a user export runs. Later export (left
  undisturbed) completed clean: valid 3.2 GB h264/aac 44:15 file.
- Progress bar stuck 0%: root-caused via isolation harness to PUSH-event delivery
  (stale event.sender after renderer HMR), NOT ffmpeg/parsing (both verified
  working). Fix: poll via invoke (getExportProgress) — see task_plan errors +
  findings. Tests still 69/69 ✅ typecheck ✅ lint ✅
- Clarified .poddie.json edit storage + merge model to user (per-token boolean
  snapshot at line ~51610; ranges coalesce at read time)
- User confirmed progress fix works → Phase 5 marked COMPLETE ✅ (full core flow
  import→transcribe→edit→preview→export all done + user-verified)
- Planned Phase 5.1 (user-requested after testing): (a) in-place transcript text
  editing — display/caption layer only, must NOT touch cut timing; double-click
  token → inline edit; merge mis-split tokens keeping time span; generalize the
  undo ItemChange model to cover text edits. (b) waveform zoom — ws.zoom() +
  higher-density precomputed peaks (~10-20 buckets/s), keep cut shading /
  drag-delete / playhead-follow working at zoom. See task_plan Phase 5.1.

## Session 2026-07-05 (Phase 5.1 implementation)
- 5.1a: shared/edit.ts — ItemChange refactored boolean-flip → reversible field
  patch {index, prev, next: ItemPatch}; new pure textEditChanges +
  mergeWithPrevChanges (concat text, span union, blank neighbor, skip blanked
  words, gap blocks merge). EditState shape/version unchanged → old projects load.
- 5.1a UI: TranscriptView TokenEditor (double-click word → inline input; Enter/
  blur commit, Esc cancel w/ settle-once race guard, IME-composition safe,
  ⌫-at-start merges the DRAFT into prev word; blocked merge keeps editor open).
  Blanked words skipped in render; App wires onEditText/onMergeWithPrev through
  the same applyEdit → undo/autosave path.
- 5.1b: computePeaks density 4000 fixed → max(4000, 20/s) with version:2 cache
  marker (stale caches recompute once). Real 44-min file measured: 53,617
  buckets, 308 KB JSON, 448 ms compute. Waveform.tsx: log-scale zoom slider +
  Fit (ws.zoom(0) → fillParent, resize-proof) + ⌘-scroll zoom-at-cursor via
  getScroll/setScroll; zoom gated on 'decode' (needs decodedData from peaks).
- Tests 78/78 ✅ (+9: patch-model toggle/apply updates, textEditChanges,
  mergeWithPrevChanges incl. chain + gap-block, keptRanges-invariance
  "text never moves audio", stale-peaks-cache recompute) typecheck ✅ lint ✅
- User confirmed both features work → Phase 5.1 COMPLETE ✅

## Session 2026-07-05 (Phase 5.5: audio-only export)
- export.ts: ExportFormat ('mp4'|'m4a'|'mp3') param on buildExportArgs — video
  presence derives from format, so audio-only reuses the same trim/concat
  builder minus video chains (no second code path). exportVideo → exportMedia;
  encoder fallback scoped to mp4 only. AUDIO_ARGS: aac 192k (mp4/m4a, both
  +faststart) / libmp3lame 192k (mp3, no movflags).
- IPC export:start takes kind 'video'|'audio'; audio save dialog offers
  M4A/MP3 filters, format read from the chosen extension. Renderer:
  window.poddie.exportMedia(path, ranges, kind); new "Export audio only…"
  ghost button (disabled without an audio stream). Progress/cancel/.part/
  reveal shared with video export unchanged.
- Tests 82/82 ✅ typecheck ✅ lint ✅ (+4: m4a graph units, mp3 codec args,
  no-audio throw, real ffmpeg 3-cut m4a + single-cut mp3 exports)
- User confirmed working → Phase 5.5 COMPLETE ✅

## Session 2026-07-05 (Phase 6: captions)
- Phase 6 feasibility review recorded (user added local-Whisper + local-LLM
  items, reprioritized): captions/silence/fillers HIGH, local Whisper MEDIUM
  (A/B spike gate vs the paid transcript), LLM cleanup MEDIUM-HIGH (JSON patch
  ops over token indices, never free text). See task_plan + findings.
- shared/captions.ts: buildCues (output-timeline remap via keptRanges prefix
  sums; pause/width/duration/sentence-punct breaking; CJK width=2 units;
  excludes removed + blanked words) + toSrt + srtTimestamp. 10 unit tests.
- Export integration: buildExportArgs subtitlesPath param (-vf single-range /
  [v]subtitles[vout] post-concat), ExportOptions.subtitlesPath, srt written to
  cache dir. IPC: captions:export (save dialog → sidecar .srt), exportStart
  gained burnInSrt arg. UI: "Export captions (.srt)…" + burn-in checkbox.
- DISCOVERY: homebrew ffmpeg 8.1.2 has NO libass → no subtitles filter on this
  Mac. Added hasFilter() runtime probe → AppInfo.canBurnCaptions gates the
  checkbox (disabled + reason tooltip); burn-in real-encode test self-skips.
  SRT sidecar path fully works regardless.
- Real-data check: 44-min project → 654 cues, 35 KB SRT, avg 3.8 s. Known
  limitation: punctuation-less zh → occasional mid-word width breaks; 5.1a
  punctuation edits improve, LLM pass will fix wholesale.
- Tests 95/95 (+2 gated skips) ✅ typecheck ✅ lint ✅
- Awaiting user verification (export SRT for the real project)

## Test results
- 2026-07-05: `npm run typecheck` ✅  `npm run lint` ✅  `npm test` ✅ 4/4
  (probe metadata, no-video-stream rejection, mono-16kHz extraction, cache hit)
- 2026-07-05: `npm run build` ✅ (main/preload/renderer bundles)
- 2026-07-05: real footage headless run: HEVC 1080×1920 44.5 min 5 GB probed;
  audio extracted 21.3 MB in 5.7 s
- Pending: user UI smoke test (Open Video → metadata card + HEVC banner)

## Session 2026-07-05 (Phase 2)
- New main modules: config.ts (API key: env > stored config, 0600), whisper.ts
  (transcribeAudioFile with injectable fetch + retry), chunking.ts (pure:
  parseSilences/planChunks/stitchWords/stitchSegments), project.ts (atomic
  save/load of <video>.poddie.json), transcribe.ts (orchestrator + progress)
- IPC: apiKey:status/set, project:load, transcribe:start (+progress event);
  preload + App.tsx updated (key bar, transcribe button w/ cost estimate,
  progress bar, transcript preview from segments)
- Dev server now runs with --watch (main-process hot restart)
- Tests: 20/20 ✅ (chunking 9, whisper 4 w/ fake fetch, project 3, media 4);
  typecheck ✅ lint ✅
- E2E UNBLOCKED: user added OPENAI_API_KEY via .env → added loadEnvFile() to
  config.ts (app startup) + config.test.ts; verified .env is gitignored
- E2E PASSED (2026-07-05): 2-min slice → chinese, 399 word-tokens (one per CJK
  char!), monotonic timestamps, project json saved, all stages reported; ~10 s
  wall clock. `npm run test:e2e` (PODDIE_E2E-gated). Unit tests now 22/22 ✅
- Chinese-language impacts recorded in findings.md (CJK joining, cross-token
  search, sequence-based filler detection) — affects Phases 3 & 6
- Next: user transcribes full 44-min file in app UI (~$0.27), then Phase 3

## Session 2026-07-05 (cost transparency, user-requested)
- Requirement recorded: podcasts are zh / en / MIXED — all transcript features
  must be language-agnostic (findings.md)
- shared/format.ts: fmtBytes/fmtDuration/whisperCostUsd (deduped from App.tsx)
- Native confirmation dialog in transcribe:start IPC handler (duration + est.
  cost + replace-warning when re-transcribing); cancel → null → renderer no-op
- Actual cost stored as Transcript.costUsd (optional field — old project files
  still load); shown in transcript header
- Tests 24/24 ✅ typecheck ✅ lint ✅
