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
**Status**: complete (pending user smoke test in UI)
- [x] Electron + Vite + React + TS scaffold (electron-vite), strict TS, ESLint
- [x] Main-process media service: ffprobe metadata, audio extraction (mono 16 kHz m4a); peaks deferred to Phase 3 (try wavesurfer's own decode first, per findings)
- [x] IPC contract (typed) between main and renderer (src/shared/types.ts)
- [x] Smoke test: 4 vitest tests pass (probe + extract on generated H.264 fixture); real footage (footage/IMG_0470.MOV) probed and audio-extracted headlessly — UI click-through by user pending

### Phase 2: Transcription & Project Persistence
**Status**: pending
- [ ] Whisper API client in main process (word timestamps, verbose_json)
- [ ] Chunking for >25 MB audio with timestamp offsetting + boundary word stitching
- [ ] Progress reporting to renderer (extracting → uploading → transcribing)
- [ ] Project file save/load (`<video>.poddie.json`), auto-load when reopening same video
- [ ] API key entry UI (settings) if env var absent

### Phase 3: Aligned Viewer (read-only)
**Status**: pending
- [ ] Video player + transcript pane, words highlighted as playback progresses (binary search on time)
- [ ] Click word → seek video to word.start
- [ ] Search box: match words/phrases, highlight hits, Enter/arrows cycle + seek
- [ ] Waveform (wavesurfer + precomputed peaks) synced to player position

### Phase 4: Editing (the core)
**Status**: pending
- [ ] Select words (click-drag / shift-click) → Delete marks removed (struck-through, grayed)
- [ ] Silence gaps rendered as `[·1.2s·]` tokens, deletable like words
- [ ] keptRanges derivation + preview controller that skips removed ranges during playback
- [ ] Waveform: removed ranges shaded; drag-select region → delete (maps to overlapping words/gaps)
- [ ] Undo/redo (plain state stack over word/gap states)
- [ ] Autosave project on every edit (debounced)

### Phase 5: Export
**Status**: pending
- [ ] ffmpeg filter_complex builder from keptRanges (trim + concat, video+audio)
- [ ] Export dialog: destination, progress bar (parse ffmpeg `-progress`), cancel
- [ ] Verify A/V sync on a real multi-cut export

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
