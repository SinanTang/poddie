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
- iPhone recording: **HEVC** (proxy path confirmed necessary), portrait 1080×1920,
  ~30 fps, 44.5 min, 5.0 GB, AAC audio — gitignored via `footage/*`
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
