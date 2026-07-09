# Task Plan: LLM Transcript Cleanup (Poddie Phase 6, final item)

Parent: `docs/development/04072026-poddie-mvp/task_plan.md` Phase 6 — this plan
covers the last two open items there: **filler-word detection** (list-based)
and **local LLM cleanup** (fillers + typos + minor corrections + punctuation).
They share one suggestion/review pipeline, so they are one plan.

## Goal
A "Clean up transcript" pass that uses a local LLM (Qwen3 via Ollama) to
suggest — never silently apply — three kinds of transcript edits:
1. **Filler removals** (嗯/呃/那个/就是/um/uh/you know…) → cut the audio
2. **Text fixes** (homophone typos like 降维/将为, mis-split tokens, casing) → display/caption text only
3. **Punctuation** (zh transcripts have ~none; captions width-break mid-word without it) → display/caption text only

All suggestions land in a review UI (accept/reject per item, bulk per
category), and accepted ones apply through the existing `ItemChange` model:
one undo step, autosave, timing untouched by construction.

**Language stance (user requirement, 2026-07-07): never assume the footage's
language.** zh/en are the *likely* cases and the test data, not a design
boundary. The core mechanics are language-agnostic by construction: the op
contract addresses token indices, the filler detector matches configurable
token sequences (a list is just data — any language's list plugs in), and the
LLM works in whatever language the transcript is in (no language pin in the
prompt; Qwen3 is multilingual). Don't build per-language code paths or a
language switch — flexibility comes from keeping language out of the logic,
not from enumerating languages.

## The One Hard Constraint
**The LLM must never return rewritten prose — free text cannot be realigned
to word timestamps.** How this is enforced changed after the Phase 0 spike
(v1–v5 ops → v6 classification; findings.md tells the story): the model never
produces positions or text at all. The app **enumerates** units (numbered
Whisper segments for punctuation, numbered list-detected filler candidates)
and the model only **classifies** each number (which mark ends this segment /
is this candidate a disfluency). Application is deterministic on our side.
Item count never changes; `start`/`end`/`removed` are only ever touched by the
same code paths manual editing already uses. A cleanup that only edits text
must produce a byte-identical export (same invariant as Phase 5.1a, same test
pattern).

## Non-Goals (YAGNI)
- Cloud LLM fallback (this feature exists for privacy/cost; API Whisper already covers "paid path")
- Prose rewriting, summarization, translation, speaker labels
- Auto-apply without review (zh filler precision makes review load-bearing, not optional)
- Bundling model weights or an inference runtime into the .app (same stance as ffmpeg/whisper-cli: external tool, probed at runtime, graceful hint when absent)
- Persisting pending suggestions in the project file (ephemeral until applied; applied edits autosave as normal `EditState`)
- Streaming token-level UI (suggestions appear per completed chunk; that's enough)

## Architecture Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Runtime | **Ollama HTTP API** (`127.0.0.1:11434`) | Already installed on this Mac (`/usr/local/bin/ollama` 0.31.1). Owns model download/quantization/updates (`/api/pull` with progress). Structured outputs (`format: <json-schema>`) force parseable JSON at the decoder level. llama.cpp-via-brew rejected: second binary + hand-rolled model management for zero benefit. MLX rejected: Python runtime dependency — the exact reason mlx-whisper was disqualified in the whisper spike. |
| Model | **Qwen3 8B** (`qwen3:8b`), `think: false`, temperature 0 — SPIKE-CONFIRMED | 4b disqualified: intermittent whole-batch degeneracy (stamped 。 on all 80 segments of a batch 8b handled fine) with marginal speed gain. Override via `PODDIE_LLM_MODEL` (same pattern as `PODDIE_WHISPER_MODEL`). |
| LLM contract | **Enumerate-and-classify, never generate positions** (spike v6). Punct: numbered segment texts in → one mark per number out (。？！，or none), appended to the segment's last word. Filler: numbered list-detected candidates with context in → cut/keep per number out. | Spike v1–v5 proved the op approach dead: models can't count tokens (index drift), can't respect token boundaries, and can't PLACE punctuation even when addressing works (~25–30% placement quality). Classification: 100% answer coverage, ~80–85% punct placement quality, mid-word splits impossible by construction. |
| LLM scope (v1) | **Punctuation only.** LLM filler judgment deferred; fixes/merges stay manual (5.1a) | Spike: LLM filler judgment showed zero discrimination (kept 90/90 incl. a clear false-start) — adds nothing over list+review. Punct is where the LLM earns its seat. Revisit filler judgment later with better prompts/models. |
| Batching | ~40 segments per call (Whisper segments, avg 7–9 words) → ~33 calls, ~17 min per 44-min episode | Batch 80 measured: no real speed win (generation dominates) and more comma-bias in flowing stretches; smaller batches shrink the blast radius of a failed call. Future speed lever: OLLAMA_NUM_PARALLEL concurrent batches. |
| Progress | **Poll**, not push (`llm:poll` invoke, like export) | Hard-won rule from the export progress bug: pushed events strand across renderer HMR reloads. |
| Review UI | Suggestion list grouped by category, accept/reject each, bulk accept per category, click → seek video to the word | zh precision risk: 那个/就是 are often REAL words. Review-before-apply is load-bearing. Seek-on-click lets the user *hear* whether it's a filler. |
| Apply | Accepted suggestions → `ItemChange[]` → existing `applyEdit` path → **one undo step** | Undo/redo/autosave/waveform shading/preview all flow through for free; item count never changes so history indices stay valid. |
| Filler baseline | List-based sequence matcher ships FIRST (pure shared code, zero deps, instant, offline) through the same suggestion+review pipeline | Closes the other open Phase 6 item; de-risks the review UI against a deterministic producer before adding LLM variance; remains the instant fallback when Ollama is absent. |
| Language handling | No per-language code paths. Detector = generic token-sequence matcher over one flat, configurable list (shipped default covers zh+en; users extend/replace the list, ALL entries always active — mixed transcripts are normal). LLM prompt names no language. | User requirement: don't assume footage language; zh/en are likely, others must work without code changes. Language lives in data (lists, transcripts), never in logic. |
| Availability | Probe at startup → `AppInfo.localLlm: {available, hint, modelPresent}` | Same gate shape as `LocalWhisperStatus`. Server down / model missing → actionable hint (`ollama serve`, `ollama pull qwen3:8b`), button disabled, list-based fillers still work. |

## Data Model (shared/cleanup.ts — all pure, all unit-tested)
```ts
// The app enumerates; the LLM (or the list) only decides. Positions never come from the model.
interface Suggestion {
  id: number
  kind: 'punct' | 'filler'
  source: 'list' | 'llm'
  status: 'pending' | 'accepted' | 'rejected'
  // punct: append `add` to word item `index` (the segment's last word)
  // filler: mark word items `index..endIndex` removed
  index: number
  endIndex?: number
  add?: string          // one of the punct-mark enum
  preview: string       // context text for the review row
}
// findFillerCandidates(items, list): longest-match-first token-sequence scan → filler Suggestions.
// segmentAnchors(items, segments): each segment → its last word item index (by time, deterministic;
//   segments with no kept word are skipped). Feeds both the punct prompt and the apply step.
// suggestionChanges(items, accepted): → ItemChange[] via textEditChanges (punct appends to text)
//   and toggleRangeChanges (filler removals). One apply path, one undo step.
// LLM answers referencing unknown numbers are dropped; unanswered numbers default to no-op.
// A punct answer for a segment whose last word's text changed since enumeration is dropped (stale).
```

## Phases

### Phase 0: Spike & GATE — op quality on the real transcript
**Status**: complete ✅ — **GATE PASSED 2026-07-08 on the fail-path scope the gate itself defined: punctuation-only LLM + list+review fillers.** Full v1→v6 story in findings.md.
- [x] Ollama server up, pulled `qwen3:4b` + `qwen3:8b`; machine = M4 24 GB
- [x] Six contract iterations on the real 44-min zh transcript (4 windows incl. the Latin-run region): v1 indexed ops 18.8% valid → v2 punct-op split 35.1% → v3 2-token context 20% → v4 text-anchored 80%-valid-but-25–30%-placement-quality → v5 typed arrays (schema fixed, quality still capped) → **v6 enumerate-and-classify: 100% answer coverage, ~80–85% placement quality**
- [x] Measured: filler candidates 358/episode (这个132 就是124 然后86 — high-ambiguity words dominate); LLM filler judgment kept 90/90 → no value over list+review; punct 17.1 min projected (8b, batch 40); batch 80 no faster and comma-biased; 4b intermittently degenerate → disqualified
- [x] Decisions locked: qwen3:8b think-off temp-0; ~40-seg batches; LLM scope v1 = punctuation only; fillers = list detection + review UI; fixes/merges stay manual
- [x] **GATE (as re-scoped by its own fail path): coverage 100% (≥90% ✓), punct placement ~80–85% acceptable (✓ with review UI in the loop), projected wall-clock ~17 min (≤20 ✓)**

### Phase 1: Pure core (shared/cleanup.ts)
**Status**: complete ✅ (2026-07-08 — 17 unit tests; 135 total pass, typecheck + lint clean)
- [x] Suggestion model (discriminated union PunctSuggestion | FillerSuggestion) + `suggestionChanges` → ItemChange[] via textEditChanges (punct append) / toggleRangeChanges (filler removal); invariant test: punct leaves keptRanges AND every start/end/removed deep-equal; combined punct+filler set round-trips through applyChanges next/prev
- [x] `segmentAnchors`: single forward pass assigning words to segments by START times (no end/overlap ambiguity) → last live word per segment; removed/blanked words skipped, empty segment → null
- [x] Punct batching: continuous numbering across batches, skips empty + already-punctuated anchors, segment text rebuilt from CURRENT items (reflects user edits); `serializePunctBatch` (`n|text` lines); `mapPunctAnswers` drops out-of-range/duplicate/unknown-mark/stale-anchor answers, empty mark = no-op. PUNCT_SYSTEM prompt + PUNCT_FORMAT schema (spike v6, `add` required+enum'd) exported for main/llm.ts
- [x] Filler-list detector: script-blind longest-match-first token-sequence scan over runs of live words — gap/removed/blanked items break the run (never cut across an audible pause or a hand-edited region); one flat configurable list, zh+en defaults; bracketed context previews
- Staleness design: suggestions carry the text they saw (anchorText / span text); apply re-checks against current items and silently skips mismatches — callers can diff counts for the UI

### Phase 2: Review UI + filler-list path (ships standalone)
**Status**: built ✅ 2026-07-09 (tsc/eslint/135 tests/build all clean) — awaiting USER CHECK
- [x] Toolbar "◌ Review N fillers" (live count, disabled at 0) → ReviewPanel.tsx: found/to-apply counts, per-row ✓/✗ (re-deciding reverts to pending), Accept/Reject all, row click seeks the video, Esc closes. Panel docks above the transcript in the same pane; suggestions snapshot on open (ids stay stable), apply re-validates and skips stale
- [x] Apply accepted → suggestionChanges → ONE applyEdit (one undo step) → autosave + waveform shading + kept/cut summary all flow through the existing items pipeline
- [x] Filler cuts render through the existing `.cut` strikethrough — no new rendering path
- [ ] USER CHECK on real footage: precision of the zh list, review ergonomics (358 candidates on the real episode — is the row flow workable?)

### Phase 3: LLM service (main/llm.ts)
**Status**: pending
- [ ] Probe: server version + model presence → `AppInfo.localLlm` (available/hint/modelPresent); injectable fetch (whisper.ts pattern), never assume server is up
- [ ] `punctBatch(numberedSegs)`: chat call w/ the spike6 prompt + json-schema format (marks array, enum'd `add`), temperature 0, think off, 1 retry on network/5xx, per-batch timeout
- [ ] Orchestrator: sequential ~40-seg batches (one model instance; OLLAMA_NUM_PARALLEL is a later speed lever), progress fraction + suggestions accumulated per batch, AbortController cancel, failed batch → logged + skipped, never aborts the run
- [ ] IPC: `llm:status`, `llm:start`, `llm:poll` (fraction + new suggestions since last poll), `llm:cancel` — through `handleIpc` wrapper for logging

### Phase 4: LLM path in the UI
**Status**: pending
- [ ] "Add punctuation (AI)" button (gated on `localLlm.available`; disabled state shows the hint) → runs orchestrator → punct suggestions stream into the SAME review panel per batch (review can start while later batches run; bulk-accept per batch is the expected flow given ~1300 suggestions)
- [ ] Review ergonomics at punct scale: group by batch/time-range, default-accepted with easy unaccept (placement is ~80–85% right — opt-OUT review reads better than opt-in at this volume), click → seek
- [ ] USER CHECK on the real 44-min episode: end-to-end run, review, apply, export; verify punctuation actually fixes the caption width-break problem (654-cue file is the benchmark)

### Phase 5: Docs & closeout
**Status**: pending
- [ ] Update parent task_plan Phase 6 checkboxes + this plan's status; findings.md gets measured numbers (op validity %, precision, wall-clock)
- [ ] README: local LLM setup section (install Ollama, pull model, feature is optional)
- [ ] CLAUDE.md: one-paragraph pointer (suggestion pipeline, the echo-validation invariant, where the op contract lives)

## Key Risks
| Risk | Mitigation |
|------|------------|
| zh filler false positives (那个/就是 as real words — measured: they're 74% of all 358 candidates) | Review UI is the product, not a safety net; list matcher requires the sequence to be a standalone token run. (LLM pre-filtering measured useless in spike — kept 90/90.) |
| Occasional whole-batch degeneracy (4b stamped 。×80; 8b comma-heavy on flowing stretches) | 8b only; ~40-seg batches limit blast radius; review UI groups by batch so a bad batch is one bulk-reject; mark-distribution sanity check per batch (all-same-mark on ≥40 segs → flag in UI) is cheap if needed |
| Punct placement wrong ~15–20% of the time | Marks land only at segment ends (mid-word impossible); review is opt-out at this volume; wrong mark = one click or an inline text edit later |
| Ollama not installed / server down / model missing | Probe + per-state hint; list-based fillers work regardless; no hard dependency for the rest of the app |
| Latency (~33 sequential batches ≈ 17 min) | Progress + cancel from day one (poll pattern); OLLAMA_NUM_PARALLEL concurrency is the untapped lever if 17 min annoys |
| Suggestions go stale (user edits while reviewing) | Punct answers re-checked against the segment's last-word text at apply time — changed text → suggestion dropped with a visible count; filler ranges re-checked the same way |
| Model RAM pressure (8B ≈ 5–6 GB) while ffmpeg/whisper run | Cleanup is a foreground, standalone action — UI disables the button while an export or transcription is active |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
