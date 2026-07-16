<div align="center">
  <img src="resources/icon.png" alt="Poddie" width="128" height="128" />
  <h1>Poddie <sup>⎨beta⎬</sup></h1>
  <p><strong>Text-based, local-first video & podcast editor.</strong></p>
  <p><em>Cut videos by deleting words — local, private, and free, all on your Mac.</em></p>
</div>

<div align="center">

**🔒 100% local & private** · **💸 Free transcription** · **🔇 Silence auto-trim** · **💬 Caption burn-in** · **🎬 One-click export**

<img src="docs/demo.gif" alt="Poddie demo" width="800" />

</div>

---

Poddie turns video editing into text editing. Import a recording, get a word-level
transcript, then **delete the words you don't want**, and Poddie cuts the video to match. What takes an hour of timeline scrubbing now takes minutes of proofreading.

Built for podcasters and creators who don't have time to edit their footage.

- 🎙️ **Transcribe free & offline** with a local Whisper model — or use OpenAI's API
  (~$0.006/min) when you want it faster.
- ✂️ **Edit by deleting words** — select words or silences, hit delete, done. Full undo/redo.
- 🔇 **Silence auto-trim** — strip dead air across the whole episode in one click, no
  hunting for gaps.
- ▶️ **Preview instantly** — the player skips your cuts live, no re-encoding, with a
  zoomable waveform for frame-precise selections.
- 💬 **Caption burn-in** — generate captions from your transcript and burn them straight
  into the video. The kind of subtitle feature other editors put behind a subscription.
- 📤 **Export anything** — cut video (MP4), audio-only podcast (M4A/MP3), or captions as a
  standalone SRT file.

No lock-in, no hidden database, no cloud.

> **Beta / personal tool.** Poddie was built for one person's podcast workflow and runs
> on **macOS only**. Expect rough edges,
> and see [Known limitations](#known-limitations) before relying on it.

---

## Requirements

| Requirement | Notes |
|-------------|-------|
| **macOS** (Apple Silicon or Intel) | Distributed as a universal build. Uses `h264_videotoolbox` with a `libx264` software fallback, and probes both Homebrew prefixes (`/opt/homebrew` on Apple Silicon, `/usr/local` on Intel). Best-tested on Apple Silicon. |
| **Node.js 22+** and npm | To run or build from source. |
| **ffmpeg** | `brew install ffmpeg-full` recommended — the standard `ffmpeg` bottle works but lacks `libass`, so caption **burn-in** is disabled (SRT export still works). |
| **whisper.cpp** *(optional)* | `brew install whisper-cpp` — only needed for the free local transcription engine. Without it, the OpenAI API engine still works. |
| **OpenAI API key** *(optional)* | Only needed for the API transcription engine. Set `OPENAI_API_KEY`, or enter it once in the app. |

> Poddie shells out to system `ffmpeg`/`ffprobe`/`whisper-cli` (it does not bundle them),
> preferring the `ffmpeg-full` keg (either Homebrew prefix), then `/opt/homebrew/bin` →
> `/usr/local/bin` → `PATH`, health-checking each. Override with `PODDIE_FFMPEG`,
> `PODDIE_FFPROBE`, or `PODDIE_WHISPER_CLI`.

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
npm run dist:dir   # unpacked universal Poddie.app in dist/mac-universal/ (try this first)
npm run dist       # a universal .dmg in dist/
```

The build is **ad-hoc signed, not notarized**. The first time you
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

- **macOS only.** Universal build runs on Apple Silicon and Intel; no Windows/Linux. Best-tested on Apple Silicon.
- **Depends on Homebrew tools** — `ffmpeg`/`whisper-cli` are not bundled; other users must
  install them (see [Requirements](#requirements)).
- Tuned for iPhone H.264/HEVC recordings; exotic codecs are untested.

---

## License

[MIT](LICENSE) © 2026 Sinan Tang
