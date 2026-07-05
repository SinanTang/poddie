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
**Status**: implemented 2026-07-05 — awaiting user verification in the app

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

### Phase 5.5 (candidate, user-suggested): Audio-only export
- [ ] "Export audio (.m4a/.mp3)" — same keptRanges, atrim/concat only, no video encode (seconds not minutes); for Apple Podcasts / Spotify RSS feeds. Await user go-ahead.

### Phase 6: Advanced (if time allows)
**Status**: pending
- [ ] Filler-word detection: token match against configurable list (um, uh, like, you know…) → "Remove all N fillers" with per-item review
- [ ] Silence auto-detection: gaps > threshold (default 0.75 s) → bulk trim, keeping padding (e.g. 0.15 s each side)
- [ ] Captions: generate SRT from kept words remapped to the output timeline; optional burn-in via ffmpeg `subtitles` filter on export

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
