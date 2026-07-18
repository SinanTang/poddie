# Findings — audio input

## Verified in code (2026-07-18)

- **Export layer is already stream-agnostic.** `buildExportArgs` builds video/audio
  filter chains independently off `format` + `hasAudio` ("audio-only exports are the
  same graph minus the video chains"); `exportMedia` already probes for `hasAudio`.
  Only missing piece: a `hasVideo` guard so `mp4` on an audio-only source fails fast
  instead of dying inside ffmpeg with a cryptic `[0:v]` mapping error.
- **Everything downstream of the probe is audio-driven already**: `extractAudio`
  (`-vn` is a no-op on audio files), `computePeaks`, chunking, both Whisper engines,
  captions, project persistence (`projectPathFor` is extension-agnostic).
- **Video-stream assumptions live in exactly three places**:
  1. `probeVideo` (media.ts:48) — throws "No video stream found"
  2. open dialog filter + drag-drop regex (index.ts:101, 111) — mov/mp4/m4v only
  3. renderer: `<video>` element, `HTMLVideoElement` prop types (Waveform.tsx:16,
     TranscriptView.tsx:12), Media card printing `width×height · videoCodec`,
     Export card always offering video + burn-in
- **wavesurfer, seek-skip controller, transcript autoscroll, keyboard shortcuts**
  only touch HTMLMediaElement members (`currentTime`, `paused`, `seeking`,
  `play`, `pause`) — safe to feed an `<audio>` element.
- **media-server MIME map** (media-server.ts:15) lacks mp3/wav/flac/ogg/opus/aac;
  falls back to `application/octet-stream` (Chromium sniffs, but be explicit).
- **tests/media.test.ts:49** asserts the OLD behavior (audio-only rejects) —
  must be inverted, it's now the feature.
- **Chromium-playable audio codecs** (Electron ships proprietary codecs): aac, mp3,
  flac, opus, vorbis, pcm_s16le/f32le etc. NOT alac — an `.m4a` can be ALAC, so
  needsProxy must key off the **codec**, not the extension.

## Verified live (2026-07-18, built app driven over CDP — scripts in session scratchpad)

- **m4a drop** (real speech audio + hand-crafted `.poddie.local.json`): `<audio class="player">`
  renders (native controls bar, no black box), Media card shows `0:20 · aac · 317 KB`
  (no dims), Export card shows ONLY "Export 0:20 audio…" (primary) + "Export captions
  (.srt)…" — no video button, no burn-in row. Waveform renders real peaks; transcript
  with word + gap tokens loads; ✂ Trim silences applied and autosaved.
- **Cut-skip on `<audio>`**: playhead sampled at 100 ms during playback jumps
  3.48 → 4.46 over the trimmed 3.55–4.45 gap, zero dwell samples inside the cut.
- **Video regression**: mp4 drop shows `<video>`, dims·codec meta, burn-in checkbox,
  all three export buttons; cut-skip trajectory clean.
- **Pre-existing re-drop bug found & fixed** (see task_plan errors table): re-dropping
  the currently-open file killed the edit state/cut-skip — on video too, so it predates
  this feature. Loader effect now keyed on media object identity; re-drop verified
  clean for both audio and video.
- **rAF throttling note**: an occluded Electron window still fired rAF at ~30 fps here,
  fine for the skip controller — but don't chase "skip doesn't work" reports without
  first checking window visibility.
- ALAC → AAC proxy covered by unit test (generated ALAC fixture → `.proxy.m4a`, aac,
  playable); not separately exercised in the live UI — same renderer path as HEVC proxy.
