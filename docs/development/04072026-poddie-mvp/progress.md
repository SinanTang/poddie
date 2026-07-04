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
