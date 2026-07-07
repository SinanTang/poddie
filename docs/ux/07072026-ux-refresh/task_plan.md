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

### Phase 2 — First-run experience + header simplification
**Laws: Fitts, Jakob, Hick, Proximity, Mental Model**
- [ ] Empty state: large centered "Open Video" primary CTA + drop-zone affordance ("or drop a .mov/.mp4 here")
- [ ] Drag-and-drop: `webUtils.getPathForFile` in preload, new `openVideoPath` IPC (types in `shared/types.ts` first → handler in `main/index.ts` → preload), window-level drop target reusing the exact `openVideo()` flow
- [ ] Move engine picker + API key UI out of the header into a ⚙ settings popover; header becomes: brand · search · spacer · ⚙ · Open Video
- [ ] Transcribe empty state: keep cost/free labels and hints, restyle with the step framing ("Step 2 — Transcribe")
- **Verify**: drop a real .mov; open via button; key save/remove/change flows inside popover; engine flip still swaps project files

### Phase 3 — Editing affordances
**Laws: Paradox of the Active User, Fitts, Doherty**
- [ ] Floating selection toolbar anchored near the selection: "✂ Cut (⌫)" / "Restore (⌫)" (+ word count) — makes mouse-only cutting possible; ⌫ path untouched
- [ ] Error banner: add ✕ dismiss button (fix: currently only clears on next action)
- [ ] Contextual toolbar hint: show interaction hints only while relevant (selection active vs idle); slightly larger hit areas for search ‹ › and key `.link` buttons
- **Verify**: mouse-only cut/restore round-trip; ⌫ still works; hint changes with selection state

### Phase 4 — Grouping + feedback polish
**Laws: Common Region, Chunking, Peak-End, Goal-Gradient**
- [ ] Video pane: chunk into bounded cards — Media info / Export / Transcription; move "Re-transcribe…" into the Transcription group
- [ ] Export success: clear peak-end moment — filename + duration exported + "Show in Finder" in a success card (CSS-only emphasis, no animation library)
- [ ] Unify the three progress displays (proxy, transcribe, export) into one visual pattern
- **Verify**: full export round-trip (video, audio, srt) — run export only with dev server stopped or via packaged build (CLAUDE.md rule)

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
- [ ] Phase 2 — first-run + header
- [ ] Phase 3 — editing affordances
- [ ] Phase 4 — grouping + feedback
- [ ] Phase 5 — accessibility + final pass
