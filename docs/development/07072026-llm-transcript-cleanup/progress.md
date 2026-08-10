# Progress: LLM Transcript Cleanup

## Session 2026-07-07 — planning
- Read parent plan + findings (04072026-poddie-mvp), `src/shared/edit.ts`,
  `src/shared/types.ts`, `src/main/whisper-local.ts` (integration precedent).
- Surveyed local LLM runtimes: Ollama 0.31.1 installed (no server running, no
  models pulled); MLX and llama.cpp absent → Ollama chosen as runtime.
- Wrote task_plan.md (6 phases, gate-first like the whisper.cpp spike),
  findings.md (environment survey + inherited constraints + open questions).
- Correction during planning: first draft of task_plan.md was accidentally
  written with phases marked complete — rewritten immediately; all phases are
  **pending**, nothing is built yet.
- User requirement folded in: never assume footage language (zh/en likely,
  others must work). Plan updated — language lives in data (filler list,
  transcript), never in logic; no per-language code paths; spike adds an EN
  window sanity check.
- Next: Phase 0 spike (pull qwen3 models, run op-contract windows on the real
  transcript, measure against the gate).

## Session 2026-07-07/08 — Phase 0 spike: GATE PASSED (punctuation-only scope)
- Pulled qwen3:4b + qwen3:8b; server on 127.0.0.1:11434; M4 24 GB.
- Six contract iterations against the real 44-min zh episode (spike1–6.mjs in
  scratchpad/spike-llm/, results kept per version). Arc: indexed ops failed on
  index drift (18.8%) → punct-op split (35.1%) → rigid 2-token context (20%)
  → text-anchored ops (80% valid but only ~25–30% of punct placements CORRECT)
  → typed-array schema (fixed grammar hole) → **v6 enumerate-and-classify:
  100% coverage, ~80–85% placement quality, 17 min/episode projected**.
- Key deltas vs the original plan, all documented in task_plan/findings:
  LLM contract is classification (no positions from the model); LLM scope v1
  is punctuation only (filler judgment measured useless: kept 90/90); model
  locked to qwen3:8b think-off (4b intermittently degenerate); echo-validation
  machinery replaced by deterministic segment→last-word anchoring.
- task_plan.md fully updated: Phase 0 ✅ with measured gate numbers; decisions
  table, data model, Phases 1/3/4 and risks rewritten for the v6 design.
- Next: Phase 1 (shared/cleanup.ts pure core + tests), using spike6's prompt,
  schema, matcher, and transcripts as fixtures.

## Session 2026-07-08 (cont.) — Phase 1 complete
- src/shared/cleanup.ts: Suggestion union, findFillerSuggestions,
  segmentAnchors, punctBatches/serializePunctBatch/mapPunctAnswers,
  suggestionChanges, PUNCT_SYSTEM/PUNCT_FORMAT (spike v6 contract).
- tests/cleanup.test.ts: 17 tests — matcher (longest-first, CJK char-tokens,
  case-insensitive Latin multi-word, gap/removed/blank blocking, no overlap),
  anchors (start-time assignment, skip dead words, null), batching (numbering,
  skip punctuated, edits reflected), answer mapping (drop out-of-range/dup/
  unknown/stale), apply (keptRanges invariant, undo round-trip, stale skips).
- Note: node_modules was missing in this checkout (fresh clone?) — first
  `npx vitest` silently downloaded vitest 4.x instead of the project's 3.x;
  ran `npm install` and re-verified on project versions (135 pass, tsc+eslint
  clean).
- Next: Phase 2 — review UI + filler-list path in the renderer (toolbar
  "Find fillers", review panel, apply as one undo step, user check).

## Session 2026-07-09 — Phase 2 built (user check pending)
- components/ReviewPanel.tsx (new): generic suggestion review list — per-row
  ✓/✗ with revert-to-pending toggle, bulk accept/reject, apply count, Esc
  close, row click → seek. Reused as-is for LLM punct in Phase 4.
- App.tsx: review state (snapshot + decisions map), live fillerCount memo,
  openFillerReview/onDecide/applyReview/seekToItem; panel docks above
  TranscriptView in the transcript pane.
- TranscriptView.tsx: "◌ Review N fillers" toolbar button next to Trim
  silences.
- app.css: .review-* styles on the existing dark vocabulary.
- Verified: tsc, eslint, 135 tests, electron-vite build all clean. Real-app
  interaction needs the native file dialog → user check.

## Session 2026-08-10 — Phase 2 UX revision + completion
- User feedback: review-per-item flow too tedious. Filler removal should be
  one-click (like silence trim), not review-then-apply.
- ReviewPanel.tsx: stripped to read-only summary list — timestamps + context,
  click to seek, close. Removed: Decision type, per-row ✓/✗, Accept/Reject
  all, Apply button.
- App.tsx: replaced openFillerReview/onDecide/applyReview with single
  removeFillers callback — finds + applies all fillers as one undo step,
  then opens the read-only summary panel.
- TranscriptView.tsx: "✂ Remove N fillers" (was "◌ Review N fillers").
- app.css: removed .accepted/.rejected/.review-actions styles.
- Verified: tsc, eslint, 154 tests, build all clean. User approved UX.
- Phase 2 marked complete ✅.
- Priority shift: user identified chapter-level curation as highest-value
  LLM feature — editing workflow should go chapters-first, then word-level.
  Punctuation deprioritized (now Phase 5). New Phase 3: LLM service +
  chapter summarization. New Phase 4: chapter curation UI.
- Chapter UX agreed: story-arc main chapters (intro/struggle/insight/
  takeaway), subchapters as curation units, per-subchapter keep/cut toggle,
  editorial notes as margin-scribble style (not fixed taxonomy). Persisted
  in project file for multi-session review. Toolbar button "Chapter
  Curation (AI)" between "Remove fillers" and "Undo".
- Next: Phase 3 (LLM service + chapter summarization).

## Session 2026-08-10 (cont.) — Phase 3 complete
- src/main/llm.ts (new): probeLocalLlm (Ollama /api/tags, 3s timeout),
  generic chat() helper (structured JSON, temp 0, think off, 32k ctx,
  10-min timeout), analyzeChapters (story-arc prompt + JSON schema).
- src/shared/types.ts: LocalLlmStatus, Chapter/Subchapter/ChapterAnalysis,
  AppInfo.localLlm, Project.chapters, IPC channels llm:chapters +
  project:saveChapters, PoddieApi.analyzeChapters + saveChapters.
- src/main/project.ts: saveChapters persistence.
- src/main/index.ts: Ollama probe at startup, llm:chapters handler (runs
  analysis + auto-saves), project:saveChapters handler.
- src/preload/index.ts: bridged analyzeChapters + saveChapters.
- Tests: 155 pass (+1 saveChapters roundtrip), tsc/eslint/build clean.
- Spike results on real 44-min zh episode:
  - v1 (num_ctx 16384, m:ss timestamps): capped at 9:00 — model truncated
  - v2 (num_ctx 32768, seconds timestamps, duration hint in prompt): full
    0–2674s coverage, 3 chapters / 8 subchapters, 270s wall-clock.
    Editorial notes somewhat generic but acceptable for v1.
- Next: Phase 4 (chapter curation UI).

## Session 2026-08-10 (cont.) — Phase 4 built (user check pending)
- components/ChapterPanel.tsx (new): main chapters with subchapters,
  per-subchapter keep/cut toggle (✓/✗), time range, title, summary,
  editorial note. Click row → seek video. "Apply N cuts" in header.
  Cut subchapters dimmed (opacity 0.45). Esc closes.
- App.tsx: chapters state (loaded from project, set after LLM analysis),
  chapterPanelOpen, analyzingChapters. onChapterButton (first click →
  LLM analysis, subsequent → toggle panel), onToggleChapterKept (toggle +
  persist via saveChapters), applyChapterCuts (mark word items in cut
  subchapter time ranges as removed, one undo step).
- TranscriptView.tsx: "📑 Chapters (AI)" button between "Remove fillers"
  and "Undo", gated on llmAvailable. Shows "⏳ Analyzing…" during LLM
  call, changes to "📑 Chapters" once results exist.
- app.css: .chapter-* styles (panel, header, list, group, main, sub,
  toggle kept/cut, sub-body/title/summary/note).
- Verified: tsc, eslint, 155 tests, build all clean.

## Session 2026-08-10 (cont.) — Phase 4 user check + fixes → complete ✅
- USER CHECK on real footage revealed 3 issues, all fixed:
  1. Main chapter timestamps wrong (all "0:00 – 39:47"): LLM returned
     bogus startTime/endTime for main chapters. Fix: compute from
     min/max of subchapters both in analyzeChapters() and at render
     time in ChapterPanel.tsx (covers cached data too).
  2. Editorial notes too long and generic: tightened prompt from "margin
     scribble" to "concise editorial verdict (under 12 words) for
     keep/cut decisions, comparing against other subchapters". Renamed
     editorialNote → editorialVerdict across types/schema/prompt/UI/tests.
  3. Editorial note UI indistinct from summary: changed from plain italic
     gray to amber-tinted pill with "AI note:" prefix.
- Added "↻ Regenerate" button in chapter panel header (re-runs LLM
  analysis without manual JSON editing).
- Chapter panel now shows as top half with transcript visible below —
  clicking a subchapter seeks video AND user can see transcript context.
- Phase 4 marked complete ✅.

## Session 2026-08-10 (cont.) — Phase 6 (docs & closeout)
- README updated: added Ollama to requirements table, AI chapter curation
  and filler removal feature bullets, "Using a different LLM" section
  documenting PODDIE_LLM_MODEL and PODDIE_OLLAMA_URL env vars with
  guidance on model requirements and tested models.
- LLM model already configurable in code (llm.ts line 6:
  `process.env.PODDIE_LLM_MODEL ?? 'qwen3:8b'`); probe hint already
  shows the configured model name dynamically.
- Next: update parent task_plan, mark Phase 6 complete.
