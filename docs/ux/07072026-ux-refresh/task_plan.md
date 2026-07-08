# Task Plan — Poddie UX Refresh (Laws of UX)

## Goal

Refresh Poddie's UI to be simple, intuitive, and user-friendly, applying lawsofux.com principles — **without changing the edit model, media pipeline, or any keyboard shortcut**. Renderer + CSS work only (one small preload/IPC addition for drag-and-drop). Each phase ships independently and leaves the app fully working.

Audit with law-by-law violations: see [findings.md](findings.md).

## Guiding decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Scope | Renderer/CSS only; no edit-model or pipeline changes | Refresh, not rewrite. Business logic is tested and verified. |
| Theme | Keep dark theme, systematize it with CSS custom properties | Right choice for a video editor; the problem is inconsistency, not darkness |
| Keyboard shortcuts | All preserved byte-identical | "Never break userspace" — user muscle memory is the userspace here |
| Settings home | Popover behind a gear icon (engine + API key) | Hick's Law: settings ≠ actions; used once, not per-session |
| New dependencies | None | 4-component app; a popover and a toast need ~40 lines of CSS, not a library |
| Phase order | Tokens first, then structure, then affordances, then polish | Every later phase builds on the token system; CSS-only first = lowest risk first |

## Phases

### Phase 1 — Design tokens + button hierarchy (CSS only, zero behavior change) ✅ 2026-07-07
**Laws: Aesthetic-Usability, Von Restorff, Fitts (feedback), Accessibility**
- [x] Extract all colors/spacing/radii/font-sizes in `app.css` into CSS custom properties on `:root` (surfaces 0-3, text tiers, accent, danger/success/warning, hit/selection, spacing + radius + type scales)
- [x] Button hierarchy: primary (default) / `ghost` / `link` with `:hover` / `:active` states, 120ms transitions, global `:focus-visible` ring, `prefers-reduced-motion` guard (pulled forward from Phase 5 since transitions land here). Word/gap tokens deliberately get NO transitions — thousands of nodes, hover must stay cheap.
- [x] Fix hint-text contrast: `--text-faint: #838b9a` (was `#6b7280`); cut-token text bumped `#4b5563` → `#6b7280` (dimmed by design, now legible)
- [x] Demote "Save key" → ghost ("Re-transcribe" already was). Header "Open Video…" stays primary until Phase 2 moves the primary CTA into the empty state.
- **Verified**: typecheck + lint + 118/118 tests ✓; static used-vs-defined token cross-check ✓; CDP screenshot of first-run state ✓. Editing/exporting/error states not screenshot-verifiable until Phase 2's `openVideoPath` IPC exists (file dialog can't be driven headlessly) — CSS classes are unchanged, risk covered by the token cross-check; user should eyeball an editing session before Phase 2 starts.

### Phase 2 — First-run experience + header simplification ✅ 2026-07-07
**Laws: Fitts, Jakob, Hick, Proximity, Mental Model**
- [x] Empty state: dashed drop-zone card with "Step 1 of 3 · Open" label, one-line value prop, big primary "Open Video…" CTA, "or drop a .mov / .mp4" hint
- [x] Drag-and-drop: `pathForFile` (webUtils) + `openVideoPath` IPC (types → main handler with extension/existence validation → preload); window-level drag handlers with depth-counted enter/leave and a full-window pointer-events-none "Drop to open video" overlay. Dialog and drop share one `loadVideoInfo()` path.
- [x] Header simplified to: brand · search · spacer · ⚙ · Open Video (now ghost — the empty state owns the primary). Engine picker + ApiKeyBar live in a `SettingsMenu` popover (outside-click + Esc close, aria-haspopup/expanded).
- [x] Transcribe empty state: "Step 2 of 3 · Transcribe" label, big CTA, hint now points at ⚙ Settings
- [x] **Bonus bug fix found via screenshot verify**: video pane showed "Edited: 0:00 kept · 0:08 cut" before any transcript existed (`cutSec` = full duration when `items` is null) — now gated on `items`
- **Verified**: typecheck/lint/118 tests ✓; CDP-driven: first-run, popover open, drag-over overlay, and a real synthetic-mp4 drop → video + waveform + Step 2 state all screenshot-confirmed. Not yet covered: key save/remove flows inside the popover with a real key, engine-flip project-file swap (unchanged code path), HEVC drop needing proxy — user should sanity-check with real iPhone footage.

### Phase 3 — Editing affordances ✅ 2026-07-08
**Laws: Paradox of the Active User, Fitts, Doherty**
- [x] Floating selection toolbar (`.sel-toolbar` in TranscriptView): "✂ Cut N" / "Restore N" + ⌫ kbd hint, anchored above the selection focus (falls below near the top), hidden mid-drag. Label/count derive from the same pure `toggleRangeChanges()` the ⌫ key uses — one semantics, two input paths. Button blurs itself after click so Space stays on the video.
- [x] Error banner: flex layout with `.error-body` + ✕ `.error-close` dismiss
- [x] Contextual hint: selection-active copy is now "⇧click extends · ⌫ cuts or restores · Esc clears"; bigger hit areas for search ‹ › and `.link` buttons
- [x] **Bonus**: `errText()` helper strips Electron's "Error invoking remote method '…':" wrapper from every renderer error message (was leaking raw IPC noise into the banner); DRY'd 10 inline copies of the same ternary
- **Verified**: typecheck/lint/tests ✓. CDP-driven with a hand-crafted `.poddie.local.json` next to the synthetic video: real mouse drag-selection over 5 words → toolbar "✂ Cut 5" → click → strikethrough + waveform red shading + "Export 0:05 video…" + correct edit summary → toolbar flips to "Restore 5"; autosave persisted the cut to the project file (full applyEdit→saveEdit path). Unsupported-file drop → clean banner text → ✕ dismisses; editing state survives the failed drop.

### Phase 4 — Grouping + feedback polish ✅ 2026-07-08
**Laws: Common Region, Chunking, Peak-End, Goal-Gradient**
- [x] Video pane chunked into three bordered `.card`s with uppercase micro-titles: **Media** (filename, dims/codec/size) / **Export** (kept·cut summary, burn-in, 3 buttons, progress, success) / **Transcription** (tokens·language·cost, Re-transcribe, transcribe progress). Edit summary moved from the meta blob into the Export card where the decision happens.
- [x] Export success: `.export-success` card — success-tinted border/background, "✓ Exported <filename>" + Show in Finder. CSS-only.
- [x] One `ProgressLine` component (label + tabular % + optional Cancel + bar) replaces all four ad-hoc progress renderings (proxy, transcribe in empty state, transcribe in pane, export); dead `.progress`/`.export-block`/`.export-result` CSS removed; `progress { accent-color }`.
- **Verified**: typecheck/lint/118 tests ✓; token cross-check ✓; CDP screenshot of the card layout with a cut project (kept·cut chip, single primary, grouped Re-transcribe) ✓. Not verifiable headlessly (native save dialog): the success card and live export/transcribe ProgressLine states — **user: run one real export (dev server stopped!) to see the peak-end card**; the ffmpeg export path itself is covered by export.test.ts.

### Phase 5 — Accessibility + final pass
**Laws: Accessibility, Aesthetic-Usability**
- [ ] `:focus-visible` audit across all interactive elements; tooltip audit (every icon-ish button has `title`)
- [ ] `prefers-reduced-motion` guard on any transition added in earlier phases
- [ ] Final visual regression pass through every state; update this plan + progress.md; screenshot before/after
- **Verify**: keyboard-only walkthrough of the entire pipeline (open → transcribe → edit → export)

## Key risks

| Risk | Mitigation |
|------|------------|
| Breaking keyboard muscle memory | Shortcuts are frozen; Phase 3 only *adds* mouse paths |
| Drag-drop path handling on Electron 43 (`File.path` removed) | Use `webUtils.getPathForFile` in preload — confirmed API for this version; verify with a real file first |
| Editing `src/` during a live export (orphans ffmpeg — happened before) | Never run exports and edits concurrently in dev |
| CSS refactor regressing a rarely-seen state (error, proxy-prep, save-failed) | Phase 1 verify checklist enumerates every state explicitly |
| Scope creep (themes, tours, libraries) | YAGNI list in findings.md is binding |

## Errors encountered

| Error | Attempt | Resolution |
|-------|---------|------------|
| `npm run dev` fails: "Error: Electron uninstall" (electron-vite) | 1 | `node_modules/electron/path.txt` + `dist/` missing — the electron binary postinstall never ran (leftover from the v43 upgrade). Fix: `node node_modules/electron/install.js`. |
| Background `npm run dev` fails: "Missing script: dev" | 1 | A prior `cd node_modules/electron` persisted into the next Bash call. Fix: absolute-path `cd` at the start of background commands. |

## Status

- [x] Audit complete (findings.md)
- [x] Phase 1 — tokens + hierarchy (2026-07-07, uncommitted)
- [x] Phase 2 — first-run + header (2026-07-07, uncommitted)
- [x] Phase 3 — editing affordances (2026-07-08, uncommitted)
- [x] Phase 4 — grouping + feedback (2026-07-08, uncommitted)
- [ ] Phase 5 — accessibility + final pass
