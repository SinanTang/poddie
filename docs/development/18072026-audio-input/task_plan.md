# Audio input support

## Goal

Open common **audio** files (podcast recordings) exactly like videos: transcribe,
edit by transcript/waveform, export. UX principle: never assume the input format —
one "Open Media" entry point. When the source has no video stream, the UI hides
video export and caption burn-in; only audio export (m4a/mp3) and SRT remain.

## Architecture decisions

| Decision | Choice | Why |
|---|---|---|
| Probe shape | Rename `VideoInfo` → `MediaInfo`, add `hasVideo: boolean`, `videoCodec: string \| null`; width/height/fps stay numbers (0 when audio-only) | One type, no parallel audio path; typecheck finds every touchpoint |
| Persisted JSON | `Project.videoPath` field name unchanged | Never break userspace: existing `.poddie.json` files must load |
| Probe failure mode | Throw only when file has **neither** audio nor video stream | Fail fast on garbage, accept any real media |
| Audio preview playability | `CHROMIUM_PLAYABLE_AUDIO` set (aac, mp3, flac, opus, vorbis, pcm_*) mirrors the video set; unplayable (e.g. ALAC) → audio proxy `.proxy.m4a` (aac 96k) | Same proxy pattern as HEVC video, no new machinery |
| Preview element | `<audio controls>` when `!hasVideo`, else `<video>`; state/props loosened `HTMLVideoElement` → `HTMLMediaElement` | wavesurfer + seek-skip + transcript sync only use HTMLMediaElement members |
| Export gating | Renderer hides video button + burn-in when `!hasVideo`; `buildExportArgs` gains `hasVideo` and throws on mp4-without-video | Defense in depth, mirrors existing `hasAudio` guard |
| Accepted audio extensions | m4a, mp3, wav, flac, ogg, opus, aac | Common podcast formats; all decodable by ffmpeg AND Chromium (aac raw = ADTS ok) |

## Phases

- [x] Phase 1: Research — read media.ts, export.ts, index.ts, App.tsx, types.ts, tests
- [x] Phase 2: Shared types + probe (`probeMedia`) + audio proxy + media tests
- [x] Phase 3: Entry points — dialog filters, drag-drop regex, media-server MIME map
- [x] Phase 4: Export guard (`hasVideo` in buildExportArgs/exportMedia) + export tests
- [x] Phase 5: Renderer — media element switch, export card gating, copy changes
- [x] Phase 6: Verify (typecheck ✓, lint ✓, 130/130 tests ✓, CDP-driven live run with m4a — see findings) + docs (README, CLAUDE.md)

## Key risks

- `<audio>` vs wavesurfer: `media:` option is documented for HTMLMediaElement — verified live (waveform render + cut-skip against `<audio>`).
- Raw `.aac` (ADTS) has estimated duration from ffprobe — acceptable, cuts are sample-accurate on export regardless.
- Rotation/display-dims logic must not run for audio-only (no video stream to read `side_data_list` from) — probe uses optional chaining, covered by unit test.

## Errors encountered

| Error | Attempt | Resolution |
|---|---|---|
| mp4-export-of-audio guard error triggered the videotoolbox→libx264 "fallback", failing twice with a noisy log | 1 | Hoisted the first `buildExportArgs` call outside the fallback try in `exportMedia` — validation errors now reject immediately |
| Cut-skip dead after re-dropping the SAME file (repro'd on video too → **pre-existing bug**, not audio-specific): project loader keyed on `[mediaPath, engine]` doesn't re-fire when the path is unchanged, but `loadMediaInfo` already reset `project` to null → edit state silently gone | 2 | Keyed the loader effect on the `media` **object** (fresh per open) instead of the path string; re-drop verified fixed for both audio and video via CDP playhead sampling |
