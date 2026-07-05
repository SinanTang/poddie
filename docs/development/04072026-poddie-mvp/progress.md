# Progress Log: Poddie MVP

## Session 2026-07-04
- Verified environment: ffmpeg/ffprobe present (homebrew), Node 22, empty repo
- Wrote task_plan.md (6 phases), findings.md (env + Whisper/ffmpeg facts)
- Correction: first draft of task_plan.md wrongly marked phases complete;
  rewritten with all phases pending — no code exists yet
- Next: user review of plan → Phase 1 scaffold

## Session 2026-07-05 (Phase 1)
- Scaffolded Electron + Vite + React + TS manually (no interactive CLI): package.json,
  electron.vite.config.ts, tsconfig, eslint flat config
- src/shared/types.ts (typed IPC contract), src/main/{ffmpeg,media,index}.ts,
  src/preload/index.ts, src/renderer (App with open/probe/extract UI, media:// protocol)
- Hit + resolved: macOS EPERM-uv_cwd blocker (user-side fix), broken homebrew ffmpeg
  (brew reinstall) — details in task_plan errors table
- User added footage/IMG_0470.MOV (real iPhone clip) + gitignore entry

## Test results
- 2026-07-05: `npm run typecheck` ✅  `npm run lint` ✅  `npm test` ✅ 4/4
  (probe metadata, no-video-stream rejection, mono-16kHz extraction, cache hit)
- 2026-07-05: `npm run build` ✅ (main/preload/renderer bundles)
- 2026-07-05: real footage headless run: HEVC 1080×1920 44.5 min 5 GB probed;
  audio extracted 21.3 MB in 5.7 s
- Pending: user UI smoke test (Open Video → metadata card + HEVC banner)

## Session 2026-07-05 (Phase 2)
- New main modules: config.ts (API key: env > stored config, 0600), whisper.ts
  (transcribeAudioFile with injectable fetch + retry), chunking.ts (pure:
  parseSilences/planChunks/stitchWords/stitchSegments), project.ts (atomic
  save/load of <video>.poddie.json), transcribe.ts (orchestrator + progress)
- IPC: apiKey:status/set, project:load, transcribe:start (+progress event);
  preload + App.tsx updated (key bar, transcribe button w/ cost estimate,
  progress bar, transcript preview from segments)
- Dev server now runs with --watch (main-process hot restart)
- Tests: 20/20 ✅ (chunking 9, whisper 4 w/ fake fetch, project 3, media 4);
  typecheck ✅ lint ✅
- BLOCKED on E2E: no OPENAI_API_KEY yet (user setting it up). Test plan when
  ready: cut 2-min slice of footage → transcribe (~$0.01) → verify words JSON →
  then full 44-min file (~$0.27, single chunk, no chunking path exercised)
