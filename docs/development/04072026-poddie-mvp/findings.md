# Findings: Poddie MVP

## Environment (verified 2026-07-04)
- macOS (Darwin 25.3.0), Apple Silicon (homebrew at /opt/homebrew)
- ffmpeg + ffprobe installed at /opt/homebrew/bin/ — no bundling needed
- Node v22.16.0, npm 11.4.1
- Repo is empty (fresh .git only)

## Whisper API facts (from API docs knowledge — verify against live docs before Phase 2)
- Endpoint: `POST /v1/audio/transcriptions`, model `whisper-1`
- Word timestamps require `response_format: "verbose_json"` AND
  `timestamp_granularities[]: "word"` — only `whisper-1` supports word granularity
  (the newer `gpt-4o-transcribe` models do NOT return word timestamps as of cutoff)
- Hard 25 MB upload limit → mono 16 kHz 64 kbps m4a ≈ 28 MB/hour, so chunking is
  needed for recordings over roughly 50 min; chunk with per-chunk start offsets
- Word timestamps are decent but not sample-accurate (±50–100 ms typical);
  never cut exactly at word.end — cut in the middle of the surrounding silence

## Design insights
- **Silences as first-class tokens**: modeling inter-word gaps as deletable
  tokens (same shape as words) means silence trimming, filler removal, and
  manual deletion all collapse into one code path: "mark items removed, derive
  keptRanges". No special cases.
- **keptRanges is the single derived artifact**: preview skipping, waveform
  shading, SRT remapping, and the ffmpeg export graph all consume it. Compute
  it in one pure function; unit-test it hard (empty edit, everything removed,
  adjacent removals merging, boundary padding).
- **Preview vs export split**: preview = seek-skipping over the original file
  (instant, approximate); export = ffmpeg re-encode (slow, exact). Never try to
  make preview frame-exact.
- iPhone default is HEVC ("High Efficiency") — Chromium `<video>` cannot decode
  it. ffprobe on import; if HEVC, generate an H.264 proxy once and preview off
  the proxy while exporting from the original.

## ffmpeg recipes (to validate in Phase 1/5)
- Audio for Whisper: `ffmpeg -i in.mov -vn -ac 1 -ar 16000 -b:a 64k out.m4a`
- Peaks for waveform: decode to raw PCM and downsample to ~1000 px worth of
  min/max pairs in Node (or wavesurfer can decode the extracted m4a directly —
  try that first, precompute only if slow on 1 h files)
- Export multi-cut (n ranges):
  `-filter_complex "[0:v]trim=A:B,setpts=PTS-STARTPTS[v0];[0:a]atrim=A:B,asetpts=PTS-STARTPTS[a0];…;[v0][a0]…concat=n=N:v=1:a=1[v][a]" -map "[v]" -map "[a]"`
  Single range: plain `-ss A -to B` (no concat graph)
- Burn captions: `-vf "subtitles=out.srt"` (SRT times must be post-cut timeline)
- Progress: `-progress pipe:1` → parse `out_time_us` against total kept duration

## Real footage baseline (footage/IMG_0470.MOV, measured 2026-07-05)
- iPhone recording: **HEVC** (proxy path confirmed necessary), coded 1080×1920
  with **rotation −90 side data → displays LANDSCAPE 1920×1080**,
  ~30 fps, 44.5 min, 5.0 GB, AAC audio — gitignored via `footage/*`
- probeVideo reports display dims (rotation-aware since Phase 3); ffmpeg ≥5.1
  auto-applies the display matrix on transcode, so proxies/exports come out
  correctly oriented with no extra flags. 44-min proxy: 512 MB 960×540, ~4 min
  hardware encode (h264_videotoolbox), cached as 8eae1de9d0de2961.proxy.mp4
- Whisper-prep extraction: 21.3 MB m4a in **5.7 s** (≈470× realtime) — extraction
  is effectively free; no progress UI needed for it, a spinner suffices
- 64 kbps mono m4a ≈ 0.48 MB/min → 25 MB Whisper cap hit at ~52 min; this 44.5 min
  file fits in ONE request, so chunking is only exercised by longer recordings

## Requirement (user, 2026-07-05): podcasts will be Chinese, English, OR mixed CN/EN
- Never assume a single language: all transcript handling (joining, search,
  filler lists, captions) must handle CJK tokens, Latin word tokens, and both
  interleaved in one transcript. Whisper auto-detect stays on (no language pin).
- Filler detection needs BOTH lists active regardless of detected language
  (a "chinese" transcript can still contain "okay", "so", English tech terms).

## E2E discovery: the podcast is in CHINESE (measured 2026-07-05, 2-min slice)
- Whisper auto-detected `language=chinese`; returned **one word-token per CJK
  character** (399 tokens for 2 min), each with its own timestamps
- Design impacts:
  - **Rendering/joining**: never join CJK tokens with spaces — join adjacent CJK
    chars directly, keep spaces only around Latin runs (mixed zh/en likely in a
    tech podcast). One `isCjk()` helper + smart joiner, used by preview, editor,
    SRT generation.
  - **Search (Phase 3)**: a query like 审计 spans two tokens — search the
    concatenated string and map match offsets back to token indices (build a
    concatenated text + per-token offset index).
  - **Filler words (Phase 6)**: English list useless. Chinese fillers (嗯, 呃,
    啊, 那个, 就是, 然后, 这个…) are 1–2 chars = 1–2 tokens → detector must match
    token *sequences*, not single tokens. Keep list configurable.
  - **Upside**: character-level timestamps = finer cut granularity than English.
- Slice project file: 44 KB for 2 min → ~1 MB for 44 min. Fine as JSON.
- Pipeline timing: 2-min slice → ~10 s wall clock total (extract + upload + API).
  Full 44-min file ≈ estimate 2–4 min, single chunk.

## Platform lesson: Electron protocol.handle can't serve seekable media (2026-07-05)
- Verified with a minimal headless repro (scratchpad/repro/main{,2,3}.js pattern:
  hidden BrowserWindow + muted <video> + event/range logging, ~10 s per run):
  - streamed 206 body → PIPELINE_ERROR_READ on mid-file seek
  - buffered clamped 206 → Chromium stops issuing range requests; seek → EOF
  - localhost HTTP server → everything works natively
- Production shape: media-server.ts — 127.0.0.1, ephemeral port, random token
  in path, standard 200/206/416/404/403, createReadStream piping (backpressure
  and abort handled by node http). Renderer gets base URL via app:info IPC.
- The repro harness pattern is the debugging tool of choice for any future
  media-pipeline weirdness — keep using it before theorizing.

## Debuggability (added 2026-07-05, user request)
- Main-process logger (logger.ts): human-readable lines → console + 
  ~/Library/Application Support/poddie/logs/poddie.log (5 MB startup rotation)
- Logged: session start, every IPC failure (with channel), ffmpeg failures with
  stderr tail, long ffmpeg runs, transcribe stages, media server requests/errors,
  uncaught exceptions/rejections
- Renderer error banner shows the log path under every error message

## Whisper token mis-splits motivate in-place editing (Phase 5.1a)
- Real transcript shows Latin words split across tokens: "cons ult ing",
  "D PO firm", "leg al firm", "pol icy", "im ple mentation", "sh adow AI",
  plus missing punctuation throughout. These read badly and would make ugly
  captions. In-place text editing is to fix the DISPLAY/CAPTION text only.
- Load-bearing invariant for the build: text is decorative. Cuts/keptRanges/
  export derive from time + `removed`, never from text. A text edit must produce
  a byte-identical export. Merging mis-split tokens keeps each token's time span
  (blank the neighbor's display text; don't delete the item, don't cut audio).

## IPC progress: POLL, don't PUSH (2026-07-05)
- Push (`event.sender.send` from a captured handler event) is fragile in dev:
  renderer HMR reloads swap the webContents, stranding the old sender → events
  vanish, UI freezes at its last value. This bit the export progress bar (0%).
- Poll (renderer `invoke`s a getter every N ms) always hits the live main
  handler and current renderer — robust to reloads. Used for export progress;
  transcribe/proxy progress still push (short-lived, less exposed, but same
  risk — migrate if they misbehave).
- Debugging lesson (again): the isolation-repro harness nailed this. A ~30-line
  node script running the EXACT runToolProgress code proved the main side worked,
  which localized the bug to IPC delivery. Build the repro before theorizing.
- Also confirmed: `ffmpeg -progress pipe:1` needs `-f null -` (not `/dev/null`)
  in tests or it errors instantly and encodes nothing — a self-inflicted false
  negative that cost time. Don't suppress ffmpeg stderr while testing it.

## Export format rationale (2026-07-05, user asked re: SNS/podcast platforms)
- MP4 + H.264 (yuv420p) + AAC + `+faststart` = universal ingest format: YouTube,
  IG/Reels, TikTok, X, Bilibili, 小红书, WeChat Channels, Spotify video all take
  it natively and transcode on ingest anyway — HEVC buys nothing at upload time
  (and X has rejected it). 10 Mbps @1080p is inside every platform's rec range.
- yuv420p is load-bearing: some pipelines/QuickTime choke on other chroma formats.
- Orientation is the per-platform decision, not codec: this footage displays
  landscape 1920×1080 (YouTube-shaped); vertical platforms letterbox it.
- Gap: audio-first podcast feeds (Apple/Spotify RSS) want MP3/M4A — audio-only
  export offered to user, logged as Phase 5.5 candidate in task_plan.

## Environment gotchas (this Mac)
- `EPERM uv_cwd`: third-party binaries (node, python) were denied getcwd() inside
  ~/Documents while file I/O by absolute path worked. User-side macOS permission
  fix resolved it. If it recurs, dev tooling dies mysteriously — check this first.
- Homebrew ffmpeg was silently broken (x265 dylib mismatch) — `which ffmpeg`
  proving existence ≠ binary launches. resolveTool() runs `-version` as a health
  check on every candidate, which caught this; keep that behavior.

## Open questions (resolve during build, not before)
- Does wavesurfer 7 handle a 1 h m4a decode fast enough, or do we need
  precomputed peaks? (measure in Phase 3)
- Whisper chunk-boundary stitching: cut chunks at detected silence to avoid
  splitting a word; verify duplicate/missing words at seams on a real file.
