import { beforeAll, describe, expect, test } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnvFile } from '../src/main/config'
import { runTool } from '../src/main/ffmpeg'
import { projectPathFor } from '../src/main/project'
import { transcribeVideo } from '../src/main/transcribe'

// Costs real API money (~$0.01) — only runs via `npm run test:e2e`.
const root = fileURLToPath(new URL('..', import.meta.url))
loadEnvFile(join(root, '.env'))

const footage = join(root, 'footage', 'IMG_0470.MOV')
const enabled = Boolean(process.env.PODDIE_E2E && process.env.OPENAI_API_KEY && existsSync(footage))

const tmp = fileURLToPath(new URL('.tmp-e2e', import.meta.url))
const slice = join(tmp, 'slice.mov')

describe.skipIf(!enabled)('Whisper end-to-end on real footage', () => {
  beforeAll(async () => {
    await rm(tmp, { recursive: true, force: true })
    await mkdir(tmp, { recursive: true })
    // 2-minute stream-copy slice from 5 min in (past any recording-setup noise)
    await runTool('ffmpeg', ['-y', '-ss', '300', '-t', '120', '-i', footage, '-c', 'copy', slice])
  }, 120_000)

  test('extract → whisper → stitched transcript → saved project', async () => {
    const stages: string[] = []
    const project = await transcribeVideo(slice, {
      cacheDir: join(tmp, 'cache'),
      apiKey: process.env.OPENAI_API_KEY!,
      onProgress: (p) => stages.push(p.stage)
    })

    const transcript = project.transcript!
    expect(transcript.model).toBe('whisper-1')
    expect(transcript.costUsd).toBeGreaterThan(0.01) // ~120 s → ~$0.012
    expect(transcript.costUsd).toBeLessThan(0.02)
    expect(transcript.words.length).toBeGreaterThan(20)
    expect(transcript.segments.length).toBeGreaterThan(0)

    // word timestamps: monotonic starts, all within the slice duration (+tolerance)
    const words = transcript.words
    expect(words[0].start).toBeGreaterThanOrEqual(0)
    expect(words[words.length - 1].end).toBeLessThanOrEqual(125)
    for (let i = 1; i < words.length; i++) {
      expect(words[i].start).toBeGreaterThanOrEqual(words[i - 1].start - 0.01)
    }

    expect(stages).toContain('extracting')
    expect(stages).toContain('transcribing')
    expect(stages).toContain('done')
    expect(existsSync(projectPathFor(slice))).toBe(true)

    console.log(
      `[e2e] language=${transcript.language} words=${words.length} ` +
        `first="${words.slice(0, 12).map((w) => w.text).join(' ')}…"`
    )
  }, 300_000)
})
