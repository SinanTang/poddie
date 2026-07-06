<div align="center">
  <img src="resources/icon.png" alt="Poddie" width="128" height="128" />
  <h1>Poddie</h1>
  <p><strong>Edit your video podcast by editing its transcript.</strong></p>
  <p><em>A local, transcript-based video editor for macOS — Descript-style, but on your own machine.</em></p>
</div>

> **Beta / personal tool.** Poddie was built for one person's podcast workflow and runs
> on **Apple Silicon Macs only**. It works well for that, but it is not a polished,
> notarized, cross-platform product. Expect rough edges, and see
> [Known limitations](#known-limitations) before relying on it.

---

## What it does

Import a video, transcribe it to a word-level transcript, then edit the video *by editing
the words* — delete a sentence in the transcript and the corresponding video is cut. No
timeline scrubbing required.

- **Transcribe** with either OpenAI's Whisper API (fast, ~$0.006/min) or a **fully local**
  model via whisper.cpp (free, private, ~4× realtime). Handles Chinese, English, and mixed.
- **Edit by deleting words** — select words or silences in the transcript, press delete.
  Removed spans are cut from the export. Undo/redo throughout.
- **Trim silences** in one click, and **fix Whisper mis-splits** by editing token text
  in place (display-only — never shifts your cuts).
- **Live preview** that skips your cuts without re-encoding, with a zoomable waveform.
- **Export** the cut video (MP4/H.264/AAC), audio only (M4A/MP3), or captions (SRT sidecar,
  or burned in when your ffmpeg has libass).

Editing is **non-destructive**: your source video is never modified. Edits are saved as a
small human-readable JSON file next to the video.

---

## Requirements

| Requirement | Notes |
|-------------|-------|
| **macOS on Apple Silicon** (M1 or newer) | Uses `h264_videotoolbox` and Homebrew's `/opt/homebrew` paths. Intel Macs are untested. |
| **Node.js 22+** and npm | To run or build from source. |
| **ffmpeg** | `brew install ffmpeg-full` recommended — the standard `ffmpeg` bottle works but lacks `libass`, so caption **burn-in** is disabled (SRT export still works). |
| **whisper.cpp** *(optional)* | `brew install whisper-cpp` — only needed for the free local transcription engine. Without it, the OpenAI API engine still works. |
| **OpenAI API key** *(optional)* | Only needed for the API transcription engine. Set `OPENAI_API_KEY`, or enter it once in the app. |

> Poddie shells out to system `ffmpeg`/`ffprobe`/`whisper-cli` (it does not bundle them),
> resolving `ffmpeg-full` → `/opt/homebrew/bin` → `/usr/local/bin` → `PATH`, health-checking
> each. Override with `PODDIE_FFMPEG`, `PODDIE_FFPROBE`, or `PODDIE_WHISPER_CLI`.

---

## Install & run from source

```bash
git clone https://github.com/electronicbrains/poddie.git
cd poddie
npm install
npm run dev
```

Optionally create a `.env` in the repo root so the app picks up your API key in dev:

```
OPENAI_API_KEY=sk-...
```

## Build a distributable app

```bash
npm run dist:dir   # unpacked Poddie.app in dist/mac-arm64/ (fast — try this first)
npm run dist       # a .dmg in dist/
```

The build is **ad-hoc signed, not notarized** (no Apple Developer ID). The first time you
open it, macOS Gatekeeper will warn about an "unidentified developer" — **right-click the
app → Open**, then confirm, and it launches normally from then on.

---

## How to use

1. **Open Video…** — pick an `.mov`/`.mp4`/`.m4v`. iPhone HEVC is auto-converted to an
   H.264 preview proxy (your original is untouched and is what gets exported).
2. **Choose how to transcribe** in the header — **Local model** (free, private, no key) or
   **OpenAI API** (paste your key). Local's first run downloads a ~1.6 GB Whisper model once. You'll
   see a cost/time estimate and confirm.
3. **Edit** — click a word to seek; drag or shift-click to select, then <kbd>⌫</kbd> to cut
   (press again on a fully-cut selection to restore). Double-click a word to fix its text.
   Use **✂ Trim silences** to bulk-remove dead air.
4. **Preview** — the player skips your cuts live. Zoom the waveform for precise selections.
5. **Export** the cut video, audio-only, or captions.

Keyboard: <kbd>Space</kbd> play/pause · <kbd>←</kbd>/<kbd>→</kbd> ±3s ·
<kbd>⌘F</kbd> search · <kbd>⌘Z</kbd>/<kbd>⇧⌘Z</kbd> undo/redo.

---

## Where your files live

- **Your edits** are saved as a sidecar next to the source video:
  `<video>.poddie.json` (API engine) and `<video>.poddie.local.json` (local engine).
  Each engine keeps its own file, so switching engines swaps transcript + edits without
  losing either. These files are plain JSON — readable, diffable, no hidden database.
- **App data** (preview proxies, waveform peaks, extracted audio, downloaded Whisper models,
  logs, and your saved API key) lives in `~/Library/Application Support/poddie/`.

Two things to know:

- **Keep the video where it is.** The sidecar is tied to the video's path — move or rename
  the video and its project file is orphaned. If you move the video, move its `.poddie*.json`
  files alongside it.
- **The video's folder must be writable** for edits to save. A video opened from a read-only
  location (mounted DMG, locked SD card) will transcribe but fail to save a project.

---

## Contributing

Poddie is an Electron + Vite + React + TypeScript app. Main process (Node/ffmpeg/fs),
preload bridge, and renderer (React UI) live under `src/`.

```bash
npm run dev        # run in development (hot reload)
npm test           # unit tests (Vitest)
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
```

- **Architecture & conventions:** [`CLAUDE.md`](CLAUDE.md) explains the core edit model
  (non-destructive `EditItem` / `keptRanges`), the media-serving approach, and the
  packaging gotchas.
- **Design decisions & history:** [`docs/development/`](docs/development/) records every
  architecture decision *with its rationale*, plus a detailed log of bugs and how they were
  root-caused. Read it before large changes — it explains the *why*.
- Keep business logic as pure, unit-tested functions (see `src/shared/`). Don't run
  `npm run test:e2e` casually — it hits the real OpenAI API and costs money.

Please open an issue to discuss substantial changes before a PR.

---

## Known limitations

- **Apple Silicon macOS only.** No Windows/Linux/Intel builds.
- **Depends on Homebrew tools** — `ffmpeg`/`whisper-cli` are not bundled; other users must
  install them (see [Requirements](#requirements)).
- Tuned for iPhone H.264/HEVC recordings; exotic codecs are untested.

---

## License

[MIT](LICENSE) © 2026 Sinan Tang
