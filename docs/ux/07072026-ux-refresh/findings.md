# Findings — Poddie UX Refresh

## Current UI inventory (audited 2026-07-07, from source)

- **Header** (`App.tsx:462-487`): app title · SearchBar (only when transcript exists) · engine `<select>` · inline API-key entry/status · "Open Video…" button. Everything in one row.
- **Error banner** (`App.tsx:489-494`): full-width red strip, raw error text + log path. **Not dismissible** — stays until the next action happens to clear it.
- **First-run empty state** (`App.tsx:655-661`): one gray hint line ("Open an iPhone recording…"); the actual action lives in the far top-right header.
- **Transcript pane**: toolbar (follow checkbox · rotating hint string · save status · ✂ Trim N silences · ↩/↪ undo-redo) above the token stream.
- **Video pane** (330px fixed): player → unchunked meta text → export block (burn-in checkbox + 3 stacked buttons) → floating "Re-transcribe…" button.
- **Waveform footer**: wavesurfer + zoom slider + Fit + hint text.

## UX audit — violations mapped to Laws of UX

| # | Law | Violation in Poddie | Severity |
|---|-----|--------------------|----------|
| 1 | **Fitts's Law**, **Jakob's Law** | First-run: the only CTA ("Open Video…") is a small button in the top-right corner, far from where the eye lands. No drag-and-drop of a video file onto the window — the #1 expectation for a media app. | High |
| 2 | **Hick's Law**, **Law of Proximity** | Header mixes one-time *settings* (transcribe engine, API key management incl. a password input) with per-session *actions* (open, search). 6+ interactive elements in one undifferentiated row. | High |
| 3 | **Von Restorff Effect** | Every `<button>` defaults to the same solid blue — "Open Video", "Save key", "Transcribe", "Export video" all compete as primaries. No visual hierarchy signals THE next action. | High |
| 4 | **Paradox of the Active User** | The entire editing interaction model (click seeks · drag selects · ⌫ deletes · double-click edits) is taught via one 12px gray hint string. A mouse-only user **cannot cut words at all** — delete is keyboard-only, there is no on-selection affordance. | High |
| 5 | **Aesthetic-Usability Effect**, **Doherty (feedback)** | No `:hover`/`:active`/`:focus-visible` states on buttons (only `.link` has hover). No transitions. ~20 hardcoded hex grays with no system. Interface gives no tactile feedback. | Medium |
| 6 | **Peak-End Rule** | Export success — the payoff moment of the whole workflow — is a 12px "✓ Exported" line. Errors (the other memorable peak) are a harsh un-dismissible red wall. | Medium |
| 7 | **Law of Common Region**, **Chunking** | Video pane is an unbounded vertical stack: metadata, edit summary, export controls, re-transcribe all run together with 10px gaps and no grouping boundaries. | Medium |
| 8 | **Goal-Gradient**, **Mental Model** | The app is a strict 3-step pipeline (Open → Transcribe → Edit/Export) but the UI never communicates the stage or progress toward the goal. Each stage's empty state exists but isn't framed as a step. | Medium |
| 9 | **Accessibility (supports all laws)** | `#6b7280` hint text on `#1b1d21` ≈ 3.9:1 contrast — below WCAG AA 4.5:1 for small text. No `:focus-visible` rings anywhere → keyboard nav is invisible. | Medium |
| 10 | **Fitts's Law** (minor) | Tiny hit targets: `.link` buttons (Change/Remove key), `‹ ›` search nav, gap tokens `0.8s`. | Low |

## What is already GOOD — do not break ("never break userspace")

- **Keyboard shortcuts**: Space, ←/→, ⌘F, ⌘Z/⇧⌘Z, ⌫ on selection, Esc. Muscle memory exists — every shortcut must survive unchanged.
- **Trim button shows live count** ("✂ Trim 12 silences") — feedback before commitment. Keep.
- **Cost estimate inside the Transcribe button** ("Transcribe (~$0.36)") — honest affordance. Keep.
- **Save indicator** with timestamp; **poll-based export progress** (survives HMR — architectural, don't touch); **cancellable export**; **kept/cut duration summary**.
- **Follow-playback band scrolling** (keeps active word in middle 60%). Keep.
- The **dark theme** itself — right choice for a video editor; refresh should systematize it, not replace it.

## Technical constraints discovered

- **Drag-and-drop**: Electron ≥32 removed `File.path` in the renderer. Getting a dropped file's path requires `webUtils.getPathForFile(file)` in the **preload** (Electron 43 here). Needs a new preload export + a new IPC `openVideoPath(path)` beside the existing dialog-based `selectVideo()` — add to `src/shared/types.ts` first per project convention.
- **CSS is one flat file** (`app.css`, 488 lines) with hardcoded hex values. Tokenizing via CSS custom properties on `:root` is zero-risk (no build-tool change, no behavior change) and is the prerequisite for every visual change after it.
- All refresh work is **renderer-only** (plus one small preload/IPC addition for drag-drop). `shared/edit.ts`, export, media pipeline: untouched.
- Dev rule from CLAUDE.md: never edit `src/` while an export is running (hot-restart orphans ffmpeg).

## Laws deliberately NOT acted on (YAGNI)

- **Parkinson's/Tesler's**: no onboarding tour, no shortcuts-cheatsheet modal — single-user app, the user wrote the workflow.
- **Choice Overload at export**: three export buttons is fine for one user who uses all three; grouping into a card (common region) is enough — no dropdown consolidation.
- No light theme, no theming system, no component library. One user, one platform.
