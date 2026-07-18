# Progress — audio input

## 2026-07-18 session 1

- Researched all video-stream assumptions (3 places: probe, entry points, renderer
  — see findings.md). Export layer confirmed already stream-agnostic.
- Wrote task_plan.md with architecture decisions; branch `audio-input` (created by user).
- Implemented Phases 2–5: `MediaInfo` (+`hasVideo`, nullable `videoCodec`), `probeMedia`
  accepts any file with ≥1 stream, `CHROMIUM_PLAYABLE_AUDIO` set, AAC m4a proxy for
  unplayable audio (ALAC), dialog/drag-drop accept 7 audio extensions, media-server MIME
  additions, `buildExportArgs` `hasVideo` guard, renderer `<audio>` element + export card
  gating (audio-only: audio + SRT only, no burn-in), copy updated to "Open Media".
- Tests: 130/130 ✓ (new: audio-only probe, ALAC needs-proxy, ALAC→AAC proxy, no-stream
  reject, mp4-from-audio fails fast incl. real-ffmpeg path). typecheck ✓ lint ✓.
- Live CDP verification of audio + video flows incl. cut-skip playback (findings.md).
- Found & fixed a pre-existing bug: re-dropping the currently-open file wedged edit
  state (loader effect keyed on unchanged path) — now keyed on media object identity.
- Docs: README + CLAUDE.md updated. NOT committed — awaiting user review.
