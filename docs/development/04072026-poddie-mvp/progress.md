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
