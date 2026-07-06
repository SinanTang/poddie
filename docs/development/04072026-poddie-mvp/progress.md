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

## Session 2026-07-05 (Phase 6: silence auto-trim + burn-in unblocked)
- ffmpeg-full guidance: homebrew split the formula; `brew install ffmpeg-full`
  is bottled, keg-only (/opt/homebrew/opt/ffmpeg-full/bin), includes libass +
  whisper-cpp. resolveTool now prefers the ffmpeg-full keg automatically
  (override order: PODDIE_FFMPEG > ffmpeg-full > /opt/homebrew/bin > PATH).
- User installed ffmpeg-full mid-session → burn-in real-encode test detected
  libass and PASSED (no longer skipped). App restart re-probes → checkbox on.
- Silence auto-trim: shared/edit.ts trimSilenceChanges (gaps ≥ 0.75 s → span
  shrunk inward 0.15 s per speech-adjacent side + removed, in ONE ItemPatch;
  file-edge sides unpadded; pad-consumed gaps skipped). Toolbar "✂ Trim N
  silences" with live count; single undo step. 6 new unit tests (padding
  placement, word-edge safety, threshold override incl. fp-rounding fix,
  skip rules, undo round-trip).
- Tests 102/102 (+1 e2e skip) ✅ typecheck ✅ lint ✅
- Awaiting user verification: trim silences on the real project + burn-in
  export after app restart

## Session 2026-07-06 (Phase 6: local-Whisper A/B spike — gate PASSED)
- User verified silence auto-trim ✅ (burn-in export still running, unverified)
- Spike (no app code touched): 3×180 s windows of the real episode through
  whisper.cpp large-v3-turbo (+DTW, -nfa) and mlx-whisper large-v3-turbo,
  scored vs the paid transcript (char alignment) AND vs real audio silences
  (ffmpeg silencedetect edges = timing ground truth).
- Result: whisper.cpp tracked real silence edges BETTER than the paid API in
  all 3 windows (median 126/89/123 ms vs API 202/109/149 ms); text agreement
  93.6–97.1 %; hallucination parity. mlx-whisper disqualified: silently
  dropped 28.6 s of speech in one window + needs a Python runtime.
- Decision: build local mode on whisper.cpp (`whisper-cli`, already installed
  as ffmpeg-full dep). Keep whisper-1 API path as default/fallback — same
  WhisperResult contract. Full numbers + integration gotchas in findings.md.
- Next: wire whisper-cli behind transcribeAudioFile seam (spawn like ffmpeg,
  resolveTool health check, model download on first use, settings toggle).

## Session 2026-07-06 (Phase 6: local whisper.cpp engine implemented)
- User verified silence auto-trim ✅; requirement added: keep the paid
  transcript file as reference — local transcription writes a NEW file.
- Engine toggle (header select, localStorage): api → <video>.poddie.json
  (untouched), local → <video>.poddie.local.json. Toggle live-switches the
  loaded project; project load moved into one [videoPath, engine] effect
  (openVideo no longer loads inline). Autosave carries the engine; flipping
  clears dirty state so a pending save can't cross project files.
- resolveTool generalized to whisper-cli (--version health check,
  PODDIE_WHISPER_CLI override, per-tool install hint).
- main/whisper-local.ts: probeLocalWhisper → AppInfo.localWhisper (gates the
  toggle; modelPresent re-probed per appInfo call), ensureModel (HF download,
  .part+rename, 1 GB sanity floor), transcribeLocalFile (spawn, -l auto -ojf
  -nfa --dtw <preset from model filename>, progress from stdout timestamps),
  parseWhisperCppJson (pure): BPE→word reconstruction + SILENCE-SNAPPED ends
  (empirically required — coarse token ends fake mid-speech gaps: 62/98 fake
  in win0, 11 would mis-trim ≥0.75 s; snapping to silencedetect bounds → ~0).
- transcribe.ts split into apiTranscript/localTranscript over one shared
  extract→probe→save spine; local skips chunking, extracts wav not m4a
  (whisper-cli reads no m4a); extractAudio gained a format param.
- Confirmation dialog per engine: cost (api) vs time estimate + 1.6 GB
  first-download note (local); REPLACE warning checks that engine's file.
- Model pre-seeded: spike download copied to userData/models (no 1.6 GB
  re-download for the user).
- Headless e2e (real 3-min slice): 617 words zh auto-detected, 3.2× realtime,
  4 gaps ≥0.75 s, .poddie.local.json saves/loads, api file stays null.
- Tests 115/115 (+13: whisper-local parse/snap/preset 12, project variant 1)
  ✅ typecheck ✅ lint ✅ build ✅
- Next: user verifies local transcription in the app UI; then filler-word
  detection per the agreed Phase 6 order.

## Session 2026-07-06 (local transcribe: real-episode run + progress fix)
- User ran the full 44-min episode locally: 9066 words, done in ~12 min
  (matches the 3.2× realtime estimate), .poddie.local.json written. VERIFIED.
- But the UI looked hung at 19% for 10+ min → user reported it as stuck.
  Root cause: progress parsed whisper-cli's stdout segment lines, and stdout
  is block-buffered when piped — bursts then long silence (errors table).
- Fix: `-pp` progress on stderr (unbuffered, 5% steps), stdout discarded at
  spawn so the unread pipe can't fill and deadlock; localTranscript maps the
  fraction directly (no more duration division).
- Re-ran headless e2e: progress streamed 15→100% live, same transcript
  quality (617 words zh, 3.7× realtime). Tests 115/115 ✅ typecheck ✅ lint ✅
- USER-VERIFIED 2026-07-06: local whisper transcription AND caption burn-in
  both confirmed working on the real episode. Phase 6 remaining: filler-word
  detection, then local LLM transcript cleanup.

## Session 2026-07-06 (Phase 7: packaging + the two launch bugs)
- Custom app icon: resources/icon.png (Gemini-generated P/waveform mark,
  squircle-masked + shadow via scratchpad script — macOS does NOT round icon
  corners for you; transparent corners must be baked into the PNG). Dev dock
  icon via app.dock.setIcon; ?asset import needed electron-vite/node in
  tsconfig types.
- Packaging: electron-builder (mac dmg; files = ALLOWLIST out/** +
  package.json, since footage/ is multi-GB), build/icon.png 1024² →
  auto-.icns, scripts npm run dist / dist:dir. Electron ^36 npm-audit
  advisory noted as pre-existing, not addressed.
- Launch bug #1 (click → nothing): skipped signing left the Electron
  template's STALE ad-hoc signature on the modified bundle; arm64 kills
  invalid signatures at exec time, silently. Fix: build/afterPack.cjs =
  xattr -cr (com.apple.provenance blocks codesign) + ad-hoc --deep re-sign.
- Launch bug #2 (STILL nothing): dock.setIcon threw in the packaged app
  (resources/icon.png not in the asar — ?asset paths are app-root-relative)
  → async whenReady handler aborted → process alive, ZERO windows. My earlier
  "verified" launches were this same zombie: I had checked processes, not
  windows — "Poddie Helper (Renderer)" absent = no window ever existed.
  Found in ONE step by running Contents/MacOS/Poddie directly in a terminal
  (stderr printed the exact error) after Gatekeeper theories went nowhere.
  Fix: setIcon dev-only (!app.isPackaged) + try/catch+log; BrowserWindow icon
  option dropped (no-op on macOS); packaged builds use the bundle's icon.icns.
- VERIFIED properly this time: clean dist:dir rebuild → Renderer helper
  present, media server up, clean log, window on screen (left running).
- Docs: task_plan Phase 7 status + 2 errors-table rows; findings.md
  "Packaging facts" (exec-time signature kills, ?asset resolution, debug
  order: direct-binary stderr > Renderer-helper check > app log > system log;
  spctl "rejected" is normal for un-notarized apps — don't chase it).
- Tests 115/115 ✅ typecheck ✅ lint ✅
- Phase 7 remaining: README; distribution blockers = ffmpeg/whisper-cli not
  bundled (homebrew-only), no Developer ID/notarization (right-click→Open).

## Session 2026-07-06 (BYO API key: change/remove for distributed users)
- Context: add/use own key already worked (validated sk- regex, 0600 store,
  env > config precedence, password input, "key saved ✓", transcribe gated on
  presence). Gap for a distributed beta: once present, ApiKeyBar showed only
  "key saved ✓" — no way to change/remove. A typo'd/revoked key (passes the
  format regex, fails at OpenAI) stranded the user in hand-editing config.json.
- Fix: config.ts clearApiKey (removes stored key; env still wins, can't clear
  env from app). IPC apiKey:clear + preload clearApiKey + main handler.
  ApiKeyBar: stored key → "key saved ✓ · Change · Remove"; Change reveals the
  input (Enter-to-save, Cancel); env-sourced key stays read-only "key env ✓".
  button.link style added.
- Tests: +3 config (rejects non-sk, save→clear round-trip, env-wins-over-stored
  + can't-clear-env). 118/118 ✅ typecheck ✅ lint ✅ build ✅
- README key row updated (per-user store, changeable/removable, env wins).

## Session 2026-07-06 (UI: "Transcribe" relabel + a scare that wasn't a bug)
- Header relabel per user: "Whisper:" → "Transcribe:", options "Local (whisper.cpp)"
  → "Local model" / "OpenAI API"; the API-key field now shows ONLY in OpenAI API
  mode (local needs no key). Two empty-state hints de-jargoned ("switch to Local
  model", "downloads the local model"). README how-to step aligned.
- Then: user screenshot showed the PACKAGED app as a white page with raw CSS text
  ("e: 12px; }" = tail of the built stylesheet). Looked like my change broke the
  build. It hadn't: `npm run build` succeeded, braces balanced, and a harness on
  out/renderer + CDP (`--remote-debugging-port`) on the packaged binary BOTH showed
  React mounted, CSS applied (bg rgb(27,29,33)), new labels present. Root cause was
  a build race — `dist:dir` run while `npm run dev` was live, both writing out/, so
  the packaged index.html got captured mid-write. Clean rebuild from a quiet tree
  verified good via CDP. Errors-table entry added (incl. the CDP diagnostic recipe).
- Tests 118/118 ✅ typecheck ✅ lint ✅ build ✅

## Session 2026-07-06 (packaged-app bug #3: dead video player)
- User report: packaged app opens now, but after loading a video the player
  shows nothing (transcript/waveform/metadata all fine — see screenshot).
- Localized in two probes: app log had ZERO media-server request lines for the
  session (dev sessions log 206s immediately), then curl → connection refused
  and `lsof -p <pid> -i` → no listeners: server dead, app alive.
- Root cause: `window-all-closed` closed the media server; on macOS the app
  outlives its last window, and dock-reactivate created a new window pointing
  at the dead port. IPC features unaffected — only the HTTP-served video died.
  Latent since Phase 3 in dev (nobody closes-then-reactivates a dev window).
- Fix: server teardown moved to `will-quit` (server lifetime = app lifetime;
  non-darwin reaches will-quit via app.quit(), one code path).
- Verified with a repro harness (scratchpad) driving the REAL out/main bundle:
  probe after launch → RESPONDING, after last-window-close → RESPONDING (was:
  dead), after activate-recreates-window → RESPONDING; clean quit. Packaged
  rebuild re-verified: Renderer helper up, server answering. Left running.
- Docs: errors-table row (lesson: on macOS anything torn down in
  window-all-closed is missing after every dock-reactivate; probe the server
  before blaming the client). Tests 115/115 ✅ typecheck ✅ lint ✅

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
