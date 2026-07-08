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
