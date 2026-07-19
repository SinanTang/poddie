import { beforeAll, describe, expect, test } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fingerprintOf, loadProject, projectPathFor, saveEdit, saveProject } from '../src/main/project'
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

  test('saveEdit re-homes a project whose stored videoPath went stale after a move', async () => {
    // Simulate a moved file: the project JSON sits next to the video at the NEW
    // path, but its internal videoPath still points at the OLD (now-gone) folder.
    const movedVideo = join(tmp, 'moved.mov')
    await writeFile(movedVideo, 'x')
    const stale: Project = {
      version: 1,
      videoPath: '/Users/someone/gone/moved.mov', // old absolute path, folder deleted
      fingerprint: await fingerprintOf(movedVideo),
      transcript: {
        language: 'english',
        durationSec: 1,
        model: 'whisper-1',
        createdAt: '2026-07-18T00:00:00.000Z',
        words: [],
        segments: []
      },
      updatedAt: ''
    }
    // Write it directly at the new location's project path (as a real move would leave it).
    await writeFile(projectPathFor(movedVideo), JSON.stringify(stale))

    const edit = { version: 1 as const, gapMinSec: 0.3, items: [] }
    // Without re-homing this would try to write into /Users/someone/gone → ENOENT.
    await expect(saveEdit(movedVideo, edit)).resolves.toBeDefined()

    const reloaded = await loadProject(movedVideo)
    expect(reloaded!.videoPath).toBe(movedVideo) // healed to the real path
    expect(reloaded!.edit).toEqual(edit)
  })

  test('load throws on an unsupported version', async () => {
    const badVideo = join(tmp, 'bad.mov')
    await writeFile(badVideo, 'x')
    await writeFile(projectPathFor(badVideo), JSON.stringify({ version: 99 }))
    await expect(loadProject(badVideo)).rejects.toThrow(/unsupported project version/i)
  })

  test('each engine owns its own project file — local never touches the api file', async () => {
    expect(projectPathFor(videoPath, 'api')).toBe(`${videoPath}.poddie.json`)
    expect(projectPathFor(videoPath, 'local')).toBe(`${videoPath}.poddie.local.json`)

    const apiBefore = await loadProject(videoPath, 'api')
    expect(apiBefore?.transcript?.model).toBe('whisper-1') // saved by the roundtrip test above

    expect(await loadProject(videoPath, 'local')).toBeNull()
    const localProject: Project = {
      version: 1,
      videoPath,
      fingerprint: await fingerprintOf(videoPath),
      transcript: {
        language: 'zh',
        durationSec: 12.3,
        model: 'whisper.cpp large-v3-turbo',
        createdAt: '2026-07-06T00:00:00.000Z',
        words: [{ text: '你好', start: 0.5, end: 0.9 }],
        segments: [{ text: '你好', start: 0.5, end: 0.9 }]
      },
      updatedAt: ''
    }
    await saveProject(localProject, 'local')

    expect((await loadProject(videoPath, 'local'))?.transcript?.model).toBe('whisper.cpp large-v3-turbo')
    expect(await loadProject(videoPath, 'api')).toEqual(apiBefore) // untouched
  })
})
