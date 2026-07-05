import { beforeAll, describe, expect, test } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fingerprintOf, loadProject, projectPathFor, saveProject } from '../src/main/project'
import type { Project } from '../src/shared/types'

const tmp = fileURLToPath(new URL('.tmp-project', import.meta.url))
const videoPath = join(tmp, 'clip.mov')

beforeAll(async () => {
  await rm(tmp, { recursive: true, force: true })
  await mkdir(tmp, { recursive: true })
  await writeFile(videoPath, 'not really a video, just a fingerprint target')
})

describe('project persistence', () => {
  test('load returns null when no project file exists', async () => {
    expect(await loadProject(videoPath)).toBeNull()
  })

  test('save/load roundtrip preserves the transcript', async () => {
    const project: Project = {
      version: 1,
      videoPath,
      fingerprint: await fingerprintOf(videoPath),
      transcript: {
        language: 'english',
        durationSec: 12.3,
        model: 'whisper-1',
        createdAt: '2026-07-05T00:00:00.000Z',
        words: [{ text: 'Hello', start: 0.5, end: 0.9 }],
        segments: [{ text: 'Hello', start: 0.5, end: 0.9 }]
      },
      updatedAt: ''
    }
    await saveProject(project)

    const loaded = await loadProject(videoPath)
    expect(loaded).not.toBeNull()
    expect(loaded!.transcript).toEqual(project.transcript)
    expect(loaded!.updatedAt).not.toBe('')
    expect(projectPathFor(videoPath)).toBe(`${videoPath}.poddie.json`)
  })

  test('load throws on an unsupported version', async () => {
    const badVideo = join(tmp, 'bad.mov')
    await writeFile(badVideo, 'x')
    await writeFile(projectPathFor(badVideo), JSON.stringify({ version: 99 }))
    await expect(loadProject(badVideo)).rejects.toThrow(/unsupported project version/i)
  })
})
