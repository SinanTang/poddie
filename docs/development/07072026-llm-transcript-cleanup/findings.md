# Findings: LLM Transcript Cleanup

## Environment survey (verified 2026-07-07, this Mac)
- **Ollama installed**: `/usr/local/bin/ollama`, client 0.31.1 — but the server
  is NOT running and **zero models are pulled** (`ollama list` empty). First
  spike step is `ollama serve` (or launch the app) + `ollama pull qwen3:8b`.
  0.31.1 comfortably post-dates structured outputs (`format: <json-schema>`,
  added 0.5.0) and Qwen3 support.
- **No MLX** (`mlx_lm` not importable, no CLI) and **no llama.cpp**
  (`llama-cli`/`llama-server` absent). Ollama is the only runtime present —
  aligns with the decision to build on it rather than introduce a toolchain.

## Constraints inherited from the MVP plan (docs/development/04072026-poddie-mvp/)
Verified against current source, not just docs:
- **Token-count-preserving output is the hard requirement** (findings.md:200):
  free-text LLM output can't be realigned to word timestamps. JSON patch ops
  over item indices, validated, routed through `ItemChange`.
- **The mutation helpers already exist** (`src/shared/edit.ts`): `textEditChanges`
  (text-only, invariant-tested), `mergeWithPrevChanges` (blocks merging across a
  gap token — LLM merge ops must inherit this rule), `toggleRangeChanges`
  (filler removal = mark removed; `removedRanges` absorbs micro-holes between
  adjacent removed items, so multi-token fillers cut cleanly). `applyChanges`
  is the single apply path; item COUNT never changes.
- **Fillers span multiple tokens** — CJK fillers are 1–2 char-tokens (嗯, 呃,
  那个, 就是), English ones can be multi-word ("you know") — so filler ops need
  an index RANGE and the list matcher must match token sequences. That
  requirement is what makes the matcher language-agnostic for free: it never
  inspects scripts, it just compares token runs against list entries.
- **Punctuation is the highest-leverage fix**: the real 44-min zh transcript has
  ~no punctuation → caption width-breaks split words (播/客节目, 654 cues).
  Sentence punctuation creates the soft-break points `buildCues` already honors.
- **Real typo shapes to prompt for**: homophone coin-flips (降维/将为), Latin
  mis-splits ("cons ult ing", "D PO firm") — the latter are `merge` ops, not
  text rewrites.
- **Progress must be POLLED** (export-progress lesson) and long-running child
  work needs cancel + `.part`-style discipline. LLM run state lives in main,
  renderer polls.
- **Probe external services, never assume** (`resolveTool` -version health
  check; `hasFilter('subtitles')`): the Ollama probe follows the same shape →
  `AppInfo.localLlm` gate.

## Design conclusions (pre-spike)
- **Echo validation** (`from` must equal current joined text of the targeted
  items) makes index hallucination structurally harmless AND makes stale
  suggestions self-invalidating after concurrent manual edits — one mechanism,
  two risks covered.
- **Chunks are independent and index-addressed** → merge is concatenation;
  a failed chunk is a logged skip, not a run failure. Sequential execution
  (single model instance; Ollama queues anyway).
- List-based filler detection ships first through the same Suggestion/review
  pipeline: instant, offline, deterministic — and it exercises the whole UI
  before LLM variance enters the picture.
- **Language never enters the logic** (user requirement 2026-07-07): don't
  assume footage language; zh/en are likely but not guaranteed. The design is
  already language-agnostic where it matters — index-addressed ops, echo
  validation on raw text, sequence matching over a flat data list, no language
  pin in the LLM prompt. Extensibility = other languages are a list edit and a
  transcript, zero code. Deliberately NOT building: language detection,
  per-language toggles, per-language code paths.

## Phase 0 spike (2026-07-07, in progress)

### Environment/session facts
- This Mac: **M4, 24 GB RAM** → qwen3:8b (5.2 GB) comfortable, 14b possible but tight alongside Electron+ffmpeg.
- Footage + project files live in the OLD repo checkout: `~/Documents/developers/poddie/footage/` (the current repo at `playground/poddie` has no footage dir). Real transcript: `IMG_0470.MOV.poddie.json` — zh, 2674 s, 9021 words, 1297 segments.
- **Whisper API segments DO carry punctuation** ("OK,大家好,…") — only word tokens lack it. Segment text is a possible future hint/validation source for the punctuation pass, unused for now.
- Spike windows: 4 × ~300 word-items, segment-aligned, at 60 s / 1320 s / 2400 s / 2139 s (the only ≥5-token Latin run in the episode, word idx 7241).

### v1 contract results (qwen3:4b, window 0): FAILED — 18.8% ops valid, 164 s/window
69 ops → 13 valid. Failure taxonomy (this is the valuable output):
- **37 echo mismatches** — mostly systematic off-by-one indices; echo validation caught every one (the mechanism earns its keep).
- **18 no-op fixes** (`from == to`) — the model "confirms" tokens it has no edit for.
- **Char-token completion pathology**: 4b rewrites single-char CJK tokens into two-char words using the NEIGHBOR's text (有→有一, 感→感谢, le→title). Applied, this would duplicate words — it's prose-rewriting sneaking in through `fix`.
- Latency: 164 s/window × ~30 windows ≈ 80 min/episode — over budget, but most output tokens were junk ops; a tighter contract shrinks output.
- 4b v1 run cut short after window 0 — pathologies conclusive, no value in more v1 data.

### v2 contract hardening (in response, before trying 8b)
- **`punct` is its own op** `{op:'punct', i, from, add}` with `add` from an enum of punctuation marks — appending is the only possible action, so the main task (punctuation) can no longer rewrite text at all. `fix` narrows to genuine mishearings.
- **Validator rejects neighbor-concat fixes** (`to` == prev.text+cur or cur+next.text) — the completion pathology is now structurally invalid, not just discouraged.
- Prompt states the data shape explicitly ("tokens are single chars/fragments — that is NORMAL, do not reshape") and bans no-op fixes.
- Lesson so far, same shape as the whisper spike: **don't beg the model in prose — make bad output structurally invalid** (op design + validator), then measure what's left.

### v2 results (qwen3:8b, window 0): still failing — 35.1% valid, 137 s/window
- v2 killed the v1 pathologies (0 no-op fixes, 0 neighbor-concats got through) but exposed the real bottleneck: **pure index drift**. 22/24 rejections were echo mismatches where `from` is a plausible sentence-end token but `i` points a few tokens away — the model cannot count reliably across 300 lines. All 13 valid ops were punct (the main task), so the model UNDERSTANDS the job; it just can't address tokens by counting.
- **v3 in response: context addressing.** Every op adds `pre` = exact text of the 2 word-tokens before the target; the validator snaps `i` within ±10 to the unique position where `pre`+`from` matches (none/ambiguous → drop). The index degrades to a hint; the copied text is the address — patch(1) fuzzy-hunk logic. Models are bad at counting and good at copying; the contract should lean on what they're good at.

### v3 (2-token `pre` + index snap): 20% — the model can't see token boundaries
- Required `pre` = "exactly the 2 word-tokens before the target"; the model instead copies 2–6 preceding CHARS, crossing token boundaries ("就是我们内", "之") → 52/65 "no pre+from match". Demanding token-boundary precision from the model was the mistake.
- **v4 in response: text anchoring.** Locate `pre`+`from` as a substring of the window's whitespace-normalized concatenated text (nearest occurrence to the hinted index, ±200 chars), then map the char span back to tokens via offsets — the app's existing CJK-search approach (`lib/transcript.ts`). Token boundaries stop existing for the model; cuts/merges still require token-aligned spans at the validator.

### v4 (text-anchored): addressing SOLVED, schema hole found — 81.8 / 79.2 / 0 / 0 %
- Windows w1/w3: 81.8% and 79.2% valid (rejects were mostly honest "text not found" hallucinations — exactly what the anchor is for).
- Windows w0/w2: 0% because the model omitted `add` on EVERY punct op — the shared op schema couldn't put `add` in `required` (filler/merge lack the field), so grammar-constrained decoding allowed dropping it. A tagged-union schema can't express per-variant required fields in Ollama's format.
- Also consistent across v1–v4: the model emits almost exclusively punct ops (the stated "main task"); fillers/fixes/merges ~never appear. If v5 doesn't change that, the production design should run focused per-category passes (punct pass, filler pass) rather than one do-everything call.
- **v5 in response: typed arrays** — `{punct:[], filler:[], fix:[], merge:[]}`, each array item schema with its own strict `required` (`add` for punct, `to` for fix). The omission becomes grammatically impossible; output also drops the per-op `op` tag.

### v5 (typed arrays): schema hole fixed — then the annotation killed the whole op approach
- v5 w0: 65.5% valid, `add` present on every punct op (typed arrays per op category, each with its own `required` — the correct way to express per-variant required fields under Ollama's grammar-constrained decoding; a tagged union can't). Run cut short because:
- **Manual annotation of v4's VALID punct ops (55 across 2 windows): only ~25–30% correctly placed.** The model fragments clauses ("验证。市场"), splits words ("市。场", "网络。安全", "各。种各样"), drops marks before clitics ("实现。的" for "实现的。"), and re-suggests duplicates. Validity ≠ quality: the contract can guarantee an op is *applicable*, not that it's *right*. qwen3:8b (think off) cannot place zh punctuation by generating positions, however they're addressed.

### The pivot (v6): classification, not generation — the app enumerates, the model judges
Root cause across v1–v5: every design asked the model to PRODUCE positions (indices, then anchors). Models are bad at that. Two measurements changed the shape:
- **Whisper segments carry ZERO punctuation** on this file (0/1297 terminal, 6 internal marks — the punctuated seg0 was an outlier), **but the segment boundaries are prosody-driven clause breaks** (avg 7.0 words/segment API, 9.2 local). Whisper already solved break-point detection; only the MARK is missing.
- The filler list detector (pure code) already finds candidate positions deterministically.
So v6 inverts control — the model never emits a position:
- **Punct pass**: numbered segment texts in, one decision per number out: 。？！， or "" (continuation). Applying = append mark to the segment's last word (deterministic by time). ~1297 tiny decisions per episode.
- **Filler pass**: the list finds candidates (那个/就是/嗯/um…); numbered candidates with ±12 words context in, cut/keep judgment per number out. LLM-as-precision-filter on top of the deterministic detector — directly attacks the known zh false-positive risk; unsure → keep.
- Fixes/merges drop out of LLM scope for now (manual editing from 5.1a covers them; revisit only if punct+filler passes prove the pipeline).
This also collapses latency: output ≈ one short JSON entry per unit instead of anchored ops.

### v6 results (qwen3:8b, classification design): the punct pass WORKS
Measured on 6×40-segment punct batches + 3×30-candidate filler batches, real transcript:
- **Answer coverage 100%** everywhere (240/240 segments, 90/90 candidates) — no addressing, no validity losses at all. Mark distributions vary with content across batches (28。/9，/3？ vs 11。/28，) → the model reads, not pattern-stamps.
- **Punct quality (my annotation of all 240): ~80–85% acceptable placement** — a 3× jump over the op approach (~25–30%). Questions marked correctly ("你们想要开发什么样的产品？"), commas on continuations. Failure modes left: comma-vs-period taste, choppy short-burst segments (@1100 batch), an occasional mark-one-segment-late. **Mid-word splits are impossible by construction** (marks land only at segment ends).
- **Filler judgment: no discrimination — kept 90/90**, including a clear false-start ("然后我【那个】是我第一次…"). Most candidates genuinely ARE meaningful (这个/就是/然后 as connectives), so keep-everything precision is high but true-filler recall ≈ 0. The LLM adds nothing over list+review yet. Decision: fillers ship as list detection + review UI (already the plan's baseline); LLM filler judgment is OPTIONAL polish, revisit with a better-prompted/bigger model later.
- **Latency (8b, batch 40): punct 17.1 min + filler 5.0 min projected** for the 44-min episode. Levers being measured: qwen3:4b, batch 80.
- Candidate stats: 358 list hits in the episode; top = 这个 132, 就是 124, 然后 86, 那个 11 — the high-ambiguity words dominate, confirming review-before-apply as load-bearing.
- 嗯/呃 barely appear in the whisper-1 transcript (3 hits total) — the API already drops most pure hesitation sounds; zh filler removal is mostly about discourse words, which are judgment calls.

### Model comparison: qwen3:4b DISQUALIFIED, qwen3:8b confirmed
- 4b at batch 80: first batch degenerate — 80/80 segments stamped 。 (on the same segments where 8b produced a mixed, content-driven distribution); second batch fine (33。/46，/1？). Intermittent pattern-stamping = can't trust any batch without checking, which defeats automation.
- 4b speed gain is marginal anyway (~0.74 s/seg at batch 80 vs 8b's 0.75 at batch 40) — output tokens dominate, and the whole-batch degeneracy risk isn't worth it. **qwen3:8b, think off, temperature 0 is the config.**

## Open questions (answer in Phase 0 spike, not before)
- qwen3:4b vs 8b: is 4b's zh good enough? (halves latency and RAM)
- Real op-validity rate at ~300 items/chunk; does shrinking the window raise it?
- Does `think: false` + json-schema format hold output quality, or does Qwen3
  need a one-shot example in the prompt?
- Wall-clock per chunk on this machine → projected episode time vs the 20-min gate.
- Is in-app `/api/pull` (model download w/ progress, whisper-local precedent)
  worth it, or is a copy-paste hint enough for a personal tool?
