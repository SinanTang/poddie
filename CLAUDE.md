# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Poddie is a **local, personal-use** Electron desktop app for editing video podcasts by editing their transcript (Descript-style): import an iPhone video → transcribe with the OpenAI Whisper API (word-level timestamps) → delete words/silences in the transcript or on the waveform → preview live → export the cut video with ffmpeg. Single user, no cloud sync, no multi-platform packaging.

Full project history — architecture decisions with rationale, phase-by-phase status, every bug hit and how it was root-caused, and measured facts about the real footage — lives in `docs/development/04072026-poddie-mvp/`:
- `task_plan.md` — architecture decisions table, data model, phase checklist, key risks, **errors encountered** (read this before re-debugging something that looks familiar — e.g. the Electron `protocol.handle` seekable-media dead end, the dev-server-hot-reload-kills-active-export trap)
- `findings.md` — verified facts (ffmpeg recipes, Whisper API behavior, CJK transcript handling, real-footage measurements)
- `progress.md` — session-by-session log

Read these before making architectural changes — they explain *why*, not just *what*.

## Commands

```bash
npm run dev         # electron-vite dev (main process runs with --watch/hot-restart)
npm run build        # electron-vite build → out/
npm run typecheck    # tsc --noEmit
npm run lint         # eslint src tests
npm test             # vitest run, excludes the Whisper e2e test
npm run test:e2e     # PODDIE_E2E=1 vitest run tests/whisper-e2e.test.ts — hits the REAL OpenAI API, costs money
```

Run a single test file: `npx vitest run tests/edit.test.ts`. Run a single test by name: `npx vitest run -t "pattern"`.

**Never edit files under `src/` while a user has an export running** — the dev server's `--watch` hot-restarts the main process, orphaning any in-flight ffmpeg export and producing a corrupt (moov-atom-missing) output file. This has happened before (see task_plan.md errors table).

## Architecture

Three-process Electron layout: `src/main` (Node, ffmpeg/fs/OpenAI access), `src/preload` (typed bridge), `src/renderer` (React UI). The IPC contract — every channel name and the `PoddieApi` shape exposed to the renderer as `window.poddie` — is centralized in `src/shared/types.ts`; add new IPC there first, then implement the handler in `src/main/index.ts` and wire the preload.

**Non-destructive edit model (the core abstraction).** The source video is never touched until export. An edit is a flat sequence of `EditItem` (`src/shared/edit.ts`): each item is a `word` (from the transcript) or a `gap` (a silence ≥ 0.35s, treated as an equally deletable token — no special-casing silence vs. words). Every item has `removed: boolean`. `keptRanges()` is the **single derived artifact** — the complement of merged removed ranges over `[0, duration]` — and it alone drives preview seek-skipping, waveform cut-shading, the ffmpeg export graph, and caption timeline remapping. Anything that needs "what's left after edits" calls this function; nothing else computes ranges independently.

Undo/redo, cuts, in-place text edits (Phase 5.1), and silence auto-trim are all the same operation underneath: an `ItemChange` is a reversible field patch (`{index, prev: ItemPatch, next: ItemPatch}`) on one item. Because item *count* never changes, indices recorded in undo history stay valid forever — there's one `applyChanges()` code path for every kind of edit. **Invariant, enforced by tests:** display text is decorative — cuts/`keptRanges`/export derive only from `start`/`end`/`removed`, never from `text`, so a text edit or token merge must produce a byte-identical export.

**Persistence**: a `<video>.poddie.json` file next to the source video (`src/main/project.ts`), atomic write, holding the transcript and `EditState`. No database.

**Media pipeline** (`src/main/media.ts`, `ffmpeg.ts`): ffprobe for metadata; iPhone HEVC needs an H.264 proxy for Chromium preview (`ensurePreviewProxy`, hardware `h264_videotoolbox` → `libx264` fallback) — **exports always cut the original file, never the proxy**. Waveform peaks are precomputed in the main process (not decoded in the renderer) and cached, versioned so a density change invalidates stale cache entries.

**Preview media serving**: preview video is served over a **localhost HTTP server** (`media-server.ts`), not Electron's `protocol.handle` — that API cannot serve properly seekable media (verified via repro harness; see task_plan.md errors table). Don't reintroduce a custom protocol for media.

**Export** (`src/main/export.ts`): pure `buildExportArgs()` builds the ffmpeg `filter_complex` trim/concat graph from kept ranges (plain seek for a single range, trim+concat for multiple); `exportMedia()` runs it with `h264_videotoolbox`→`libx264` fallback for video, `.part`-then-rename so a cancelled/failed export never leaves a fake output file. Progress is **polled** by the renderer via `invoke`, not pushed via `event.sender.send` — pushed events go stale across renderer HMR reloads (root-caused in task_plan.md). Same poll pattern should be used for any new long-running progress in dev.

**CJK handling**: transcripts may be Chinese, English, or mixed, and Whisper returns one token per CJK character. `src/shared/cjk.ts` provides the join/width helpers used everywhere text is displayed, searched, or measured for captions — never assume space-joined Latin words.

**Captions** (`src/shared/captions.ts`): SRT cue building remaps source timestamps to the post-cut output timeline via `keptRanges` prefix sums. Caption burn-in requires an ffmpeg build with `libass` (Homebrew's default bottle lacks it — `ffmpeg-full` has it); this is runtime-probed (`hasFilter('subtitles')`) and surfaced as `AppInfo.canBurnCaptions`, never assumed.

## Working conventions in this codebase

- Business logic (`shared/edit.ts`, `shared/captions.ts`, chunking/stitching in `main/chunking.ts`) is written as pure, unit-tested functions taking plain data — side effects (fs, ffmpeg spawn, IPC) stay in thin wrapper modules. Keep new logic in that shape so it stays testable without an Electron runtime.
- `resolveTool()` (ffmpeg path resolution) runs a `-version` health check on every candidate rather than trusting `which` — a previous Homebrew ffmpeg existed on PATH but failed to launch (broken dylib). Don't regress to existence-only checks for external binaries.
- Main-process failures should go through the existing logger (`main/logger.ts`) and the `handleIpc` wrapper in `main/index.ts`, which logs every IPC handler failure with its channel name before rethrowing.
