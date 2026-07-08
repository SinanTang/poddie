# Progress — Poddie UX Refresh

## Session 2026-07-07 — Audit + planning

- Confirmed clean slate: previous session (MVP verification) fully closed out, git status clean.
- Read the entire renderer (`App.tsx`, `TranscriptView.tsx`, `SearchBar.tsx`, `Waveform.tsx`, `app.css` — ~1,900 lines total) and the current lawsofux.com law list.
- Wrote the law-by-law UX audit → [findings.md](findings.md): 10 violations (4 high: first-run Fitts/Jakob, header Hick's, no button hierarchy, mouse-only users can't cut), plus an explicit keep-list of what already works and a YAGNI list of laws deliberately not acted on.
- Wrote the 5-phase plan → [task_plan.md](task_plan.md): tokens → first-run/header → editing affordances → grouping/feedback → accessibility. Renderer-only; all keyboard shortcuts frozen.
- Flagged the one technical gotcha up front: Electron 43 removed `File.path`, so Phase 2 drag-and-drop needs `webUtils.getPathForFile` in the preload + a new `openVideoPath` IPC (types-first per project convention).

**Next**: await plan review, then start Phase 1 (CSS tokens + button hierarchy — zero behavior change).

## Session 2026-07-07 (cont.) — Phase 1 implemented

- Rewrote `app.css` around a `:root` token block: surfaces 0–3, five text tiers, accent trio (hover/press/deep), status colors, hit/selection colors, spacing/radius/type scales, `--ease: 120ms`.
- Interaction states added: button hover/active for primary + ghost, select/input border hover-focus, global `:focus-visible` ring, `accent-color` on checkboxes/ranges, `prefers-reduced-motion` guard (pulled forward from Phase 5). Word/gap tokens intentionally have no transitions (thousands of nodes; hover must stay cheap).
- Contrast fixes: hint tier `#6b7280` → `#838b9a` (AA on `--surface-0`); cut-token text `#4b5563` → `#6b7280`.
- One TSX change: "Save key" button demoted to ghost (`App.tsx`).
- Known remainder: `Waveform.tsx` passes hex colors to wavesurfer as JS config — out of CSS reach, noted in the token block comment.
- Environment fix along the way: electron binary was missing (`path.txt` + `dist/` absent — postinstall never ran after the v43 upgrade); repaired with `node node_modules/electron/install.js`. Logged in task_plan errors table.

## Session 2026-07-07 (cont.) — Phase 2 implemented

- **IPC (types-first per convention)**: `IPC.openVideoPath` ('video:openPath') + `PoddieApi.openVideoPath(path)` and `PoddieApi.pathForFile(file)`. Main handler validates the renderer-supplied path (non-empty string, .mov/.mp4/.m4v extension, exists) before `probeVideo` — fail fast, descriptive errors surface in the banner. Preload bridges `webUtils.getPathForFile` (Electron ≥32 removed `File.path`; this is the documented replacement).
- **Renderer**: extracted `loadVideoInfo()` so dialog-open and drop are one code path. Window-level drag handlers on the app root with a depth counter (dragenter/leave fire per child); full-window `.drop-overlay` (pointer-events: none) gives active feedback in every app state — one mechanism, no per-state special cases. Drops ignored while `busy` (mirrors the disabled button).
- **SettingsMenu** popover (in App.tsx): gear in header → "Transcribe with" select + ApiKeyBar (api engine only) + local-model download hint. Outside-click and Esc close; aria-haspopup/aria-expanded/role=dialog.
- **Empty states**: Step 1 of 3 drop-zone card with big primary CTA; Step 2 of 3 transcribe state with big CTA; header "Open Video…" demoted to ghost.
- **Bug found by screenshot verification** (pre-existing): "Edited: 0:00 kept · 0:08 cut" shown for a freshly opened, never-transcribed video — `cutSec` defaulted to full duration with `items === null`. Fixed by gating the summary on `items`.
- **CDP verification** (drove the real app; scripts in session scratchpad): `Input.dispatchDragEvent` with `data.files` works against Electron 43 — simulated a genuine file drop of a synthetic ffmpeg-generated mp4. Screenshots confirmed: first-run drop zone, settings popover, drag-over overlay, and post-drop workspace (video meta + preview + waveform + Step 2 CTA, no phantom "Edited" line).

## Session 2026-07-08 — Phase 3 implemented

- **Floating selection toolbar** (TranscriptView): appears above the selection focus after mouseup (hidden while dragging via a `dragging` state mirror of `draggingRef`), positioned in `.transcript-scroll` content coordinates (container is now `position: relative`, so it scrolls with the text). Shows "✂ Cut N" or "Restore N" + a ⌫ hint — N and the verb come from `toggleRangeChanges()` itself, so the button can never disagree with what the Delete key would do. Mouse-only users can finally cut.
- **Dismissible error banner**: `.error-body` + ✕ button. Also added `errText()` to strip Electron's `Error invoking remote method '…': Error:` prefix — the banner used to show raw IPC plumbing; now it shows "Not a supported video: hosts (need .mov, .mp4 or .m4v)". Replaced 10 inline `err instanceof Error ? …` copies. (Gotcha logged: a replace-all of that pattern also rewrote the helper's own body into infinite recursion — caught immediately, fixed.)
- **Contextual hint + hit areas**: selection hint now teaches ⇧click/⌫/Esc; search ‹ › and `.link` buttons got larger padding.
- **Verification approach worth remembering**: hand-crafted `drop-test.mp4.poddie.local.json` next to the synthetic mp4 (loadProject validates only `version`), so a CDP drop loads a full editing session headlessly — no Whisper needed. Real mouse-event drag selection via `Input.dispatchMouseEvent`. The app's own autosave then rewrote the project file with the 5 cut words — end-to-end proof of the edit path.

## Session 2026-07-08 (cont.) — Phase 4 implemented

- Video pane restructured into three `.card` regions (Media / Export / Transcription), each with an uppercase `.card-title` matching the `.step-label` treatment. Re-transcribe now lives inside the Transcription card next to the transcript stats; the kept·cut summary moved into the Export card, directly above the buttons it informs.
- New `ProgressLine` component is the single progress pattern app-wide: truncating label, tabular-nums percentage, optional Cancel, full-width bar. Replaced four divergent renderings (proxy prep, transcribe ×2, export). Removed the now-dead `.progress`, `.export-block`, `.export-result` CSS.
- Export success upgraded from a 12px line to a success-tinted `.export-success` card with the output filename and Show in Finder.
- CDP screenshot confirms the card layout with a real cut project: one blue primary per view, clear group boundaries, correct kept·cut chip.

## Test results (Phase 4)

- `npm run typecheck` ✓ · `npm run lint` ✓ · `npm test` 118/118 ✓ · CSS token cross-check ✓
- Card layout screenshot ✓. Not headlessly reachable: `.export-success` card and live export progress (need the native save dialog) — user should run one real export with the dev server stopped; ffmpeg export logic itself is unit-tested with real ffmpeg.

## Test results (Phase 3)

- `npm run typecheck` ✓ · `npm run lint` ✓ · `npm test` 118/118 ✓
- CDP: drag-select 5 words → "✂ Cut 5" → click → 5 tokens struck through, waveform red-shades the cut, export label drops to 0:05, edit summary correct → toolbar flips to "Restore 5" ✓
- Unsupported drop → clean error text → ✕ dismisses, banner gone, editing state intact ✓
- Untested headlessly: toolbar position at the very top line of a long transcript (below-fallback logic), CJK tokens under the toolbar (pure display — low risk).

## Test results (Phase 2)

- `npm run typecheck` ✓ · `npm run lint` ✓ · `npm test` 118/118 ✓
- CDP end-to-end drop flow ✓ (see above)
- Left for the user with real footage: HEVC drop (proxy path), API-key save/change/remove inside the popover, engine flip.

## Test results (Phase 1)

- `npm run typecheck` ✓ · `npm run lint` ✓ · `npm test` 118/118 ✓
- Static cross-check: every `var(--…)` used in app.css is defined, none unused ✓
- Visual: dev app launched with `--remote-debugging-port=9222`, first-run state screenshot via CDP ✓ (header, primary CTA, engine picker, key status, centered hint all correct)
- NOT yet visually verified: editing / exporting / error states — needs a real video opened via the file dialog, which can't be driven headlessly until Phase 2's `openVideoPath` IPC exists. **User: please eyeball one editing session before Phase 2.**
