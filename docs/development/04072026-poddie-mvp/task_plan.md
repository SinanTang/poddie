# Task Plan: Poddie — Transcript-Based Video Podcast Editor (MVP)

## Goal
A local desktop tool (personal use) for editing video podcasts by editing their
transcript, Descript-style. Import an iPhone video, transcribe it with the
OpenAI Whisper API (word-level timestamps), edit by deleting words/segments in
the transcript or selecting ranges on the waveform, preview the edit live, and
export the cut video with ffmpeg.

## Non-Goals (YAGNI)
- Multi-track editing, overdub/voice cloning, collaboration, cloud sync
- Cross-platform packaging/signing (runs on this Mac only)
- Handling arbitrary codecs — iPhone H.264/HEVC MOV/MP4 is the target
- Local Whisper inference (API only; revisit if cost/privacy becomes an issue)

## Architecture Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Shell | **Electron + Vite + React + TypeScript** | Desktop feel (file dialogs, drag-drop), trivial access to ffmpeg/fs from the main process. Tauri rejected: Rust toolchain + sidecar packaging friction for zero benefit at personal scale. |
| Video processing | **System ffmpeg** (`/opt/homebrew/bin/ffmpeg`, already installed) | No bundling needed for a personal tool. Fall back to `ffmpeg-static` only if this breaks. |
| Transcription | **OpenAI Whisper API** `whisper-1`, `verbose_json` + `timestamp_granularities: ["word"]` | Word-level timestamps are the backbone of everything. Audio extracted to mono 16 kHz m4a; chunk >25 MB (API limit) with per-chunk time offsets. |
| Edit model | **Non-destructive EDL** — source file never touched; edits = word states (`kept`/`removed`) merged into cut ranges | One data structure drives preview, waveform overlay, export, and undo. No special cases: silences are just gaps between words, treated as range items too. |
| Preview | HTML5 `<video>` + a "skip removed ranges" playback controller (jump on `timeupdate`) | No re-encode needed to preview an edit. ~30 ms seek glitch at cuts is fine for preview. |
| Waveform | **wavesurfer.js** (+ regions plugin) with ffmpeg-precomputed peaks | Battle-tested, region selection built in. Peaks precomputed so hour-long files load instantly. |
| Export | ffmpeg `filter_complex` trim/concat with re-encode | Frame-accurate cuts. Stream-copy segment cutting rejected: keyframe snapping makes cuts inaccurate. Re-encode of a ≤2 h podcast is acceptable. |
| Persistence | JSON project file (`<video>.poddie.json`) next to the source video | Human-readable, git-diffable, no DB. Holds transcript + word states + settings. |
| API key | `OPENAI_API_KEY` env var, or entered once in-app → stored in a local config file | Personal tool; keychain integration is over-engineering. |

## Data Model (core)
```ts
interface Word { id: number; text: string; start: number; end: number; removed: boolean }
interface Gap  { after: number /* word id */; start: number; end: number; removed: boolean } // silence
// Derived, never stored: keptRanges: [start, end][] — computed by merging
// non-removed words+gaps; drives preview skipping, waveform shading, export.
```

## Phases

### Phase 1: Scaffold & Media Pipeline
**Status**: complete 
- [x] Electron + Vite + React + TS scaffold (electron-vite), strict TS, ESLint
- [x] Main-process media service: ffprobe metadata, audio extraction (mono 16 kHz m4a); peaks deferred to Phase 3 (try wavesurfer's own decode first, per findings)
- [x] IPC contract (typed) between main and renderer (src/shared/types.ts)
- [x] Smoke test: 4 vitest tests pass (probe + extract on generated H.264 fixture); real footage (footage/IMG_0470.MOV) probed and audio-extracted headlessly — UI click-through by user pending

### Phase 2: Transcription & Project Persistence
**Status**: complete ✅ (E2E passed 2026-07-05)
- [x] Whisper API client in main process (whisper.ts: verbose_json + word/segment granularity, injectable fetch, 429/5xx retry with backoff)
- [x] Chunking for >25 MB audio (chunking.ts: silencedetect-snapped boundaries, offsetting, seam-overlap dedup in stitchWords)
- [x] Progress reporting to renderer (transcribe:progress events; extracting → analyzing → transcribing i/n → saving → done)
- [x] Project file save/load (project.ts: `<video>.poddie.json`, atomic write, version check; auto-load on video open)
- [x] API key entry UI (config.ts + header bar; env var wins over stored key; stored 0600)
- [x] E2E: passed on 2-min slice of real footage (`npm run test:e2e`, gated by PODDIE_E2E so `npm test` never spends API money). Key finding: podcast is CHINESE — one token per CJK char; see findings.md for Phase 3/6 impacts. Full-file transcription: user runs via app UI (~$0.27)
- [x] .env support: loadEnvFile() in config.ts, called at app startup (env var still wins over stored config key)

### Phase 3: Aligned Viewer (read-only)
**Status**: complete ✅ 
- [x] Video player + transcript pane, active word highlighted via rAF + binary search; paragraph-memoized rendering (9k tokens); CJK-aware token joining (shared/cjk.ts); follow-playback autoscroll (middle-band); paragraph timestamps
- [x] Click word → seek video (also paragraph time labels)
- [x] Search: CJK cross-token + multi-word EN + mixed queries via offset-indexed concat text (lib/transcript.ts); ⌘F focus, Enter/Shift+Enter cycle, hit + active-hit highlights, auto-seek on navigate; capped at 500 matches
- [x] Waveform: wavesurfer 7 bound to the <video> element (media option) with main-process precomputed peaks (ffmpeg s16le decode → 4000 max-abs buckets, cached JSON) — no renderer audio decode
- [x] HEVC proxy: ensurePreviewProxy (h264_videotoolbox 540p → libx264 fallback), -progress reporting, cache-keyed like audio; UI shows progress then swaps player src; export will still cut the ORIGINAL
- [x] Keyboard: space play/pause, ←/→ ±3 s, ⌘F search
- [x] User visual check of viewer on real footage (proxy pre-warmed in background)

### Phase 4: Editing (the core)
**Status**: complete ✅ 
- [x] Select (click-drag / shift-click) → ⌫ removes; ⌫ on fully-removed selection RESTORES (one toggle rule); click still seeks; Esc clears
- [x] Silence gaps ≥0.35 s rendered as `1.2s` chip tokens, deletable like words (shared/edit.ts: deriveItems — silences ARE items, no special cases)
- [x] keptRanges = complement of merged removed ranges over [0,duration] (micro-hole absorption, sliver dropping — hard unit-tested); preview controller (rAF) hops cuts during playback, pauses at a cut reaching EOF
- [x] Waveform: removed ranges shaded red (regions plugin); drag-select on waveform → deletes overlapping items (>50% or >0.05 s overlap)
- [x] Undo/redo: ItemChange[] stacks, ⌘Z/⇧⌘Z + toolbar buttons; item count never changes so indices stay valid
- [x] Autosave: debounced 800 ms → project.edit (full items persisted — self-contained, survives derivation changes); "X kept · Y cut" summary in video pane
- [x] User check on real footage

### Phase 5: Export
**Status**: complete ✅ (2026-07-05 — user confirmed a real 44-min export produced a valid, playable file)
- [x] ffmpeg builder from keptRanges (export.ts: pure buildExportArgs — n=1 plain input seek, n>1 trim/atrim+setpts+concat graph; audio-less variant; renderer passes LIVE kept ranges so sub-debounce edits are included)
- [x] Encoding: h264_videotoolbox 10M → libx264 crf18 fallback, aac 192k, yuv420p, +faststart — deliberately the universal SNS/platform ingest format (see findings); exports cut the ORIGINAL file, never the proxy
- [x] Export dialog (save panel, defaults `<stem>-edited.mp4` beside source), progress bar, working Cancel (AbortController → spawn signal), .part-then-rename so failures/cancels leave no fake output, Show-in-Finder on success
- [x] A/V sync verified automated: 3-cut export of 10 s fixture → duration 4 s ±0.3, h264+aac, |video − audio stream duration| < 0.2 s; cancel test leaves no partial file
- [x] Real 44-min export: valid 3.2 GB h264/aac 44:15 file, user-confirmed playable
- [x] Progress bar fixed: PUSH→POLL (getExportProgress invoke every 400 ms); robust to renderer reloads — user-confirmed working (see errors table)

### Phase 5.1: In-place transcript text editing + waveform zoom
**Status**: complete ✅

Motivation: Whisper mis-splits tokens ("cons ult ing", "D PO firm", CJK char-tokens)
and drops punctuation; the user needs to clean the transcript for readable captions.
Separately, at 44 min across ~900 px the waveform is ~3 s/px — too coarse for precise
manual region selection.

**5.1a — In-place text editing (display/caption layer only; NEVER changes cut timing)**
- [x] Double-click a word token → inline editable input; Enter/blur commits, Esc cancels (settle-once guard so a blur race can't override Esc; CJK IME composition Enter respected). Gap tokens are not editable.
- [x] Editing changes `EditItem.text` only — invariant stated loudly in shared/edit.ts (`textEditChanges` doc) and App.tsx.
- [x] Merge mis-splits: ⌫ at input start merges the in-flight draft into the previous word (`mergeWithPrevChanges`): text concat, merged span = union, neighbor's display text blanked but item + time span kept (audio untouched). Skips already-blanked words (chain merges "cons ult ing" → "consulting"); a gap token BLOCKS merging (never silently join across an audible silence — editor stays open, draft kept).
- [x] Undo/redo generalized: `ItemChange` is now a reversible field patch `{index, prev: ItemPatch, next: ItemPatch}` (covers removed/text/end in ONE code path — cut, edit, merge are not special cases). Item count never changes → indices in history stay valid.
- [x] Persistence: `EditState` shape unchanged (items still `{kind,text,start,end,removed}`) → version stays 1, old project files load as-is. History was never persisted, so the ItemChange refactor can't break saved files.
- [x] Search index + CJK join read item text → edits flow through; blanked words already handled as zero-width tokens (same path as gaps).
- [x] Invariant test: keptRanges/removedRanges deep-equal before vs after text edits + merges (export args derive only from ranges → byte-identical export). 20 edit tests total.

**5.1b — Waveform zoom for granular selection**
- [x] Zoom control: log-scale slider + "Fit" button + ⌘/ctrl-scroll (and trackpad pinch) zooms around the time under the cursor; wavesurfer handles horizontal scroll. Max 250 px/s (~4 ms/px). Fit uses `ws.zoom(0)` → fillParent owns the width, so window resizes re-fit for free.
- [x] Peaks density raised: 4000 fixed buckets → max(4000, 20/s), versioned cache (version:2 marker; stale/pre-versioning caches recompute once). Measured on the real 44-min file: 53,617 buckets, 308 KB JSON, 448 ms compute — cheap.
- [x] Everything still works at zoom: regions/cut shading and drag-select are time-based (scale for free); autoScroll+autoCenter keep the playhead visible; `ws.zoom()` gated on the `decode` event (needs decodedData built from provided peaks).
- [x] Minimap deferred (YAGNI until zoom navigation actually hurts).
- Verified: region re-shading perf unchanged (same count, recreated per edit as before); peaks JSON measured, not bloated.

### Phase 5.5: Audio-only export
**Status**: complete ✅
- [x] "Export audio only…" button (disabled when the source has no audio stream) → save dialog whose format dropdown picks M4A (AAC 192k, +faststart) or MP3 (libmp3lame 192k); format derived from the chosen extension
- [x] Not a separate code path: `buildExportArgs` gained a format param (`mp4`|`m4a`|`mp3`); video presence falls out of the format, so audio-only is the same trim/concat graph minus the video chains. `exportVideo` renamed → `exportMedia`; videotoolbox→x264 fallback only applies to mp4 (audio encodes are software, seconds not minutes)
- [x] Same guarantees as video export: .part-then-rename, cancel, poll-based progress, Show-in-Finder; fail-fast error when exporting audio from a silent video
- [x] Tests: builder units (m4a atrim-only graph + faststart, mp3 codec/no-faststart, no-audio-stream throws) + real ffmpeg 3-cut m4a (audio-only stream, duration ±0.3 s) and mp3 exports — 82 tests total

### Phase 6: Advanced (if time allows)
**Status**: in progress — captions (incl. burn-in), silence auto-trim, and local whisper.cpp all USER-VERIFIED 2026-07-06; remaining: filler-word detection, local LLM cleanup
- [x] Captions: SRT from kept words remapped to the output timeline; burn-in USER-VERIFIED 2026-07-06 (real export completed and checked)
  — shared/captions.ts: buildRemap (source→output via keptRanges prefix sums, cut times collapse), buildCues (breaks on 0.6 s pauses / 42-unit width with CJK=2 / 5 s max / sentence-punctuation soft break at ≥20 units; removed + blanked words excluded; CJK-aware joining), toSrt. "Export captions (.srt)…" button → save dialog → sidecar.
  — Burn-in: buildExportArgs takes subtitlesPath → `-vf subtitles` (single range) or `[v]subtitles[vout]` after concat (multi); SRT written to cache dir (app-controlled path = safe filter quoting). Capability-probed at startup (`hasFilter('subtitles')` → AppInfo.canBurnCaptions). UNBLOCKED 2026-07-05: user installed `ffmpeg-full` (bottled, keg-only, has libass); resolveTool auto-prefers its keg path; real burn-in encode test now RUNS and passes. App restart needed once to re-probe.
  — Real-data check: 44-min project → 654 cues, 35 KB, avg 3.8 s. Known limitation: punctuation-less zh transcript → width breaks can split a word (播/客节目); user-added punctuation (5.1a) creates soft breaks, and the Phase-6 LLM punctuation pass fixes it wholesale. Revisit Intl.Segmenter word-boundary backtracking only if it still hurts after that.
- [ ] Filler-word detection: token match against configurable list (um, uh, like, you know…) → "Remove all N fillers" with per-item review
  — Feasibility HIGH. Must match token SEQUENCES (CJK fillers 嗯/呃/那个/就是 = 1–2 char-tokens; see findings). Detection = pure shared code; removal = existing toggle model. Precision risk on zh (那个/就是 are often real words) → review-before-apply UI is load-bearing, not optional.
- [x] Silence auto-detection (USER-VERIFIED 2026-07-06): gaps ≥ 0.75 s → bulk trim keeping 0.15 s padding per speech-adjacent side
  — shared/edit.ts trimSilenceChanges: one ItemPatch per gap (span shrunk inward + removed together → single undo restores original silences exactly); file-edge gaps get no pad on the edge side (leading/trailing dead air goes completely); pad-consumed gaps skipped. Toolbar button "✂ Trim N silences" with live count (disabled at 0); applies as ONE undo step; waveform shading/preview/autosave flow through. 6 unit tests incl. cuts-never-touch-word-edges and undo round-trip.
- [x] Use open source Whisper model to replace API call to whisper-1 for transcript generation
  — Feasibility MEDIUM (integration easy, quality is the question). Clean seam exists: transcribeAudioFile(chunk) → WhisperResult. Candidates on this M-series Mac: mlx-whisper (Metal, word_timestamps=True), whisper.cpp (Metal, weaker word timing), faster-whisper (CPU-only here). Needs large-v3 (~3 GB) for zh/mixed quality; expect minutes not seconds per episode vs $0.27 API. GATE: A/B spike against the existing paid 44-min transcript (word-timing drift drives cut accuracy) BEFORE committing. Keep API path as default/fallback — same WhisperResult contract.
  — **GATE PASSED 2026-07-06, engine chosen: whisper.cpp** (large-v3-turbo 1.6 GB, `--dtw large.v3.turbo -nfa`). Beat the paid API on real-silence timing in all 3 sampled windows; text parity; 4.4× realtime (~10 min/episode). mlx-whisper disqualified — silently dropped 28.6 s of speech in one window. Full numbers + integration gotchas (DTW needs -nfa; t_dtw in centiseconds; `[_TT_###]` token filtering; BPE→word reconstruction) in findings.md. Remaining: build the integration.
  — **IMPLEMENTED + USER-VERIFIED 2026-07-06** (real 44-min episode transcribed locally in the app: 9066 words, ~12 min, .poddie.local.json written, api file untouched). Engine toggle in the header (api|local, localStorage-persisted); each engine owns its own project file — api keeps `<video>.poddie.json` untouched, local writes `<video>.poddie.local.json` — so flipping the toggle live-switches transcript+edits (user requirement: keep the paid transcript as reference). main/whisper-local.ts: probe (resolveTool 'whisper-cli' + version health check), model auto-download (.part+rename, 1 GB sanity floor; PODDIE_WHISPER_MODEL override; model pre-seeded into userData/models from the spike), pure parseWhisperCppJson (BPE→word: leading-space/CJK-boundary splits, '�'-fragment + bare-punctuation attach, t_dtw centiseconds with coarse-offset fallback, **silence-snapped word ends** — coarse token ends leave fake mid-speech gaps that auto-trim would cut; ffmpeg silencedetect (d=0.25) arbitrates: gap without silence → bridged, gap with silence → snapped to measured bounds; validated on real footage, fake ≥0.75 s gaps 11→~0 per 3 min). Local path skips chunking (no 25 MB limit), extracts wav (whisper-cli can't read m4a), streams progress via `-pp` on stderr (stdout is block-buffered when piped and looked hung — see errors table). Headless e2e on a real 3-min slice: 617 words, zh auto-detected, 3.2× realtime, 4 gaps ≥0.75 s, both project files verified independent.
- [ ] Use a local LLM (e.g. Qwen3) to edit transcript for filler-word auto-detection, fixing typos, minor corrections and adding punctuations.
  — Feasibility MEDIUM-HIGH with one hard constraint: LLM must NOT return rewritten prose (unalignable). Design: feed indexed tokens per segment, require structured JSON patch ops (setText i / merge i / filler i) → maps 1:1 onto the existing ItemChange model + review UI + undo; timing untouchable by construction. Runtime via Ollama/MLX (Qwen3 8–14B fits this Mac). ~9k tokens per 44-min episode → chunked calls, minutes. Could subsume filler-list detection, but list matching stays as the instant/offline baseline.

## Phase 7: build a distributable open source app
**Status**: in progress — local packaging works (2026-07-06, user-launchable .app via `npm run dist:dir`); distribution to OTHER machines not started

- [x] Local packaging: electron-builder (mac-only, dmg target), `npm run dist` (dmg) / `npm run dist:dir` (unpacked .app in dist/mac-arm64)
  — electron-builder.yml: `files` is an ALLOWLIST (out/** + package.json) — blocklist default would drag multi-GB footage/ and tests/.tmp* into the asar
  — build/icon.png (1024², from the rounded dock icon) → electron-builder generates the .icns
  — build/afterPack.cjs: strips xattrs + ad-hoc re-signs the bundle. NOT optional: two distinct launch failures without it (see errors table — stale-signature kill, then windowless setIcon crash)
  — App icon: packaged builds use bundle icon.icns; `app.dock.setIcon` is dev-only (`!app.isPackaged` guard, try/caught — cosmetic ops must never abort startup)
  — Media server lifetime = APP lifetime (teardown moved window-all-closed → will-quit); window-scoped teardown left the video player dead after any dock-reactivate (see errors table)
- [x] README.md + LICENSE (MIT): install/run-from-source, build .app/.dmg + Gatekeeper right-click→Open, usage walkthrough, file-storage model (sidecar tied to video path + writable-folder requirement), contributing (→ CLAUDE.md + docs/), known limitations. package.json gained license/repository/homepage.
- [ ] Distribution blockers for other people's machines (currently personal-Mac-only):
  — ffmpeg/ffprobe NOT bundled (resolveTool shells out to homebrew paths); other Macs need `brew install ffmpeg-full` or we bundle ffmpeg-static + lose libass burn-in
  — whisper-cli same story (local transcription silently unavailable without homebrew whisper-cpp; API path still works)
  — No Developer ID/notarization: recipients hit Gatekeeper "unidentified developer" (right-click→Open once). Fine for beta; notarize if it ever goes wide


## Key Risks
| Risk | Mitigation |
|------|------------|
| Whisper word timestamps drift/imprecise (~±50–100 ms) | Pad cut boundaries slightly; boundaries snap to gap midpoints, not word edges |
| >25 MB audio (podcasts are long) | Chunk at silence points near the 25 MB boundary; offset + stitch |
| HEVC .mov from iPhone won't play in Chromium `<video>` | Detect via ffprobe; auto-create H.264 proxy for preview, export still cuts the original |
| Preview seek lag at cuts | Acceptable for preview; export is the ground truth |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| `EPERM uv_cwd` — node/python couldn't call getcwd() inside ~/Documents (file I/O by path worked; Apple binaries worked; independent of tool sandbox) | 3 (sandbox off, chdir-after-start, inode check) | macOS permission issue on the user's side; user fixed it (session interrupt), node worked afterwards. If it recurs: check terminal app's Files-and-Folders/Full-Disk access, or move repo out of ~/Documents |
| `dyld: Library not loaded libx265.215.dylib` — homebrew ffmpeg 8.1 broken after partial upgrade (x265 soname mismatch); `which ffmpeg` succeeded but binary couldn't launch | 1 | `brew reinstall ffmpeg` → 8.1.2 works |
| Click-word-to-seek stalled (user report): media:// handler used net.fetch(file://) which ignores Range headers → Chromium couldn't seek unbuffered parts of the 512 MB proxy; sequential play was unaffected, masking it | 1 | media-protocol.ts: proper 206 partial responses (parseRange + fs stream slices), 416/404 handling, unit-tested. Lesson: any HTML5 media served via custom protocol NEEDS range support |
| Range fix v1 broke PLAYBACK (user report: black screen after ~1 s, frozen waveform cursor): `Readable.toWeb(createReadStream)` mishandles backpressure/cancel; Chromium's media loader opens open-ended ranges and cancels mid-flight → pipeline wedged | 2 | Rewrote as explicit pull-based ReadableStream over a FileHandle (1 MB reads, cancel/EOF closes handle). Tests: multi-chunk byte-exact + cancel-then-reread. Lesson: don't trust toWeb() for large cancellable streams |
| Range fix v2 ALSO broke (user: play snaps to 0:00, frozen). Headless repro proved it: `protocol.handle` streamed 206 → `PIPELINE_ERROR_READ: FFmpegDemuxer data source error` on mid-file seek; buffered clamped 206 → Chromium never issues follow-up ranges, seeks snap to EOF. Electron's protocol.handle cannot serve seekable media, period | 3 | **Abandoned custom protocol.** Localhost HTTP media server (127.0.0.1, ephemeral port, per-session token path; media-server.ts) — Chromium's real HTTP stack handles ranges natively. Repro-verified seeks to 600 s and 2500 s resume playback instantly. Lesson: after 2 failed fixes on a platform API, stop patching and swap the platform API; build a minimal repro harness FIRST |
| Corrupt export "not compatible with QuickTime" (moov atom not found): I edited src/ files DURING an active export → dev `--watch` hot-restarted main → orphaned ffmpeg mid-encode → truncated MP4 (no moov = incomplete) | 1 | Cleaned up; re-exported undisturbed → valid file. RULE: never edit src/ while a user export runs (hot-reload kills it) |
| Export progress bar stuck at 0% (user). Isolation harness proved ffmpeg -progress + runToolProgress parsing WORK (fractions flowed 1.7→51% in a 30-line repro). Real bug: PUSH delivery — main sent to the `event.sender` captured at start; renderer HMR reload strands that webContents so the live renderer gets nothing. (`-nostats` red herring: chased+cleared; the "0 reports" was a broken /dev/null test) | 3 | Push→POLL: main stores `exportFraction`, renderer polls via invoke every 400 ms (invoke always hits the live handler). The export itself was fine — valid 3.2 GB file; only the readout was broken |
| Local transcribe looked hung at 19% for 10+ min (user, first real 44-min run). whisper-cli was fine (102% CPU, finished on schedule) — its stdout segment lines, which drove our progress %, are BLOCK-buffered when piped (line-buffered only on a TTY): one burst of ~40 lines in 2 ms, then minutes of silence until the next 4 KB flush | 1 | Parse stderr instead: `-pp` prints `whisper_print_progress_callback: progress = N%` on stderr, which is UNbuffered → smooth 5%-step updates (verified live). stdout now discarded at spawn (`stdio` ignore — an unread pipe would fill 64 KB and deadlock the child). Lesson: never derive progress from a piped child's stdout; use stderr or a file |
| Packaged .app silently killed at launch (user: click → nothing). `identity: null` made electron-builder SKIP signing, but it had already modified the raw Electron template (asar/Info.plist/icon) → the template's stale ad-hoc signature no longer matched. Apple Silicon verifies signatures at exec time (not just Gatekeeper-on-download) → SIGKILL before main ever ran. Bonus: `codesign` refused to re-sign until `com.apple.provenance` xattrs (stamped on the extracted Electron zip) were stripped | 2 | build/afterPack.cjs: `xattr -cr` + `codesign --force --deep --sign -` after packing. Lesson: "skip signing" is not a valid state for a MODIFIED bundle on arm64 — ad-hoc re-sign is the floor |
| Packaged .app STILL "doesn't launch" (user; survived the signing fix). Process ran, log showed session start — then `app.dock.setIcon(icon)` threw (resources/icon.png not in the asar: electron-vite `?asset` emits an app-root-relative path, and the electron-builder files allowlist only ships out/**) → the throw aborted the whole async whenReady handler → no IPC, no media server, no createWindow: alive but windowless. My earlier "verified launches" were this same zombie — I'd checked processes, not the window ("Poddie Helper (Renderer)" was absent = no window ever existed) | 3 (signing → re-sign automation → this) | Dock setIcon is dev-only now (`!app.isPackaged` + try/catch+log; packaged builds already have icon.icns). Lessons: (1) a cosmetic op must never sit unguarded at the front of the startup path; (2) "process running" ≠ "app working" — no Renderer helper = no window; (3) run the packaged BINARY directly in a terminal first — its stderr names the bug instantly, vs. Finder's silent nothing |
| Packaged app: video player dead after reopening the window (user screenshot: transcript/waveform/metadata fine, `<video>` empty at 0:00). NOT a packaging bug — `window-all-closed` closed the media server, but on macOS the app outlives its last window; dock-click `activate` recreated the window whose player URL pointed at a dead port (curl: connection refused; `lsof -p <pid> -i`: zero listeners). Everything over IPC kept working, only the HTTP-served video died. Latent in dev forever: nobody closes the dev window and reactivates — you Ctrl-C the terminal | 1 | Server lifetime = APP lifetime, not window lifetime: close moved to `will-quit` (non-darwin reaches it via app.quit() — one path, no platform special case). Verified with a repro harness driving the real out/main bundle through close-all-windows → activate: server responds at every step. Lesson: on macOS, anything torn down in `window-all-closed` will be missing after every dock-reactivate — tie resource lifetimes to the app, and probe the server (curl + lsof) before blaming the client |
