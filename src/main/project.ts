import { readFile, rename, stat, writeFile } from 'node:fs/promises'
import type { EditState } from '../shared/edit'
import type { Project, TranscribeEngine, VideoFingerprint } from '../shared/types'

/**
 * Each engine owns a separate project file, so a local whisper.cpp
 * transcription never overwrites the paid API transcript (or its edits).
 */
export function projectPathFor(videoPath: string, engine: TranscribeEngine = 'api'): string {
  return engine === 'local' ? `${videoPath}.poddie.local.json` : `${videoPath}.poddie.json`
}

export async function fingerprintOf(videoPath: string): Promise<VideoFingerprint> {
  const s = await stat(videoPath)
  return { sizeBytes: s.size, mtimeMs: s.mtimeMs }
}

/** Returns null when no project file exists; throws on a corrupt one. */
export async function loadProject(videoPath: string, engine: TranscribeEngine = 'api'): Promise<Project | null> {
  let raw: string
  try {
    raw = await readFile(projectPathFor(videoPath, engine), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  const project = JSON.parse(raw) as Project
  if (project.version !== 1) {
    throw new Error(`Unsupported project version ${String(project.version)} in ${projectPathFor(videoPath, engine)}`)
  }
  return project
}

/** Atomic write (temp + rename) so a crash can't corrupt an existing project. */
export async function saveProject(project: Project, engine: TranscribeEngine = 'api'): Promise<void> {
  const path = projectPathFor(project.videoPath, engine)
  const updated: Project = { ...project, updatedAt: new Date().toISOString() }
  const tmpPath = `${path}.tmp`
  await writeFile(tmpPath, JSON.stringify(updated, null, 1), 'utf8')
  await rename(tmpPath, path)
}

/**
 * Loads the project sitting next to `videoPath`, applies `edit`, saves it back.
 *
 * Re-homes `videoPath` first: the argument is where we just loaded from and is
 * authoritative, whereas the persisted `project.videoPath` field goes stale the
 * moment the file (or any parent folder) is moved or renamed. Without this, a
 * reopened-from-a-new-location project keeps autosaving to its dead original
 * path and every write fails with ENOENT.
 */
export async function saveEdit(
  videoPath: string,
  edit: EditState,
  engine: TranscribeEngine = 'api'
): Promise<Project> {
  const project = await loadProject(videoPath, engine)
  if (!project) {
    throw new Error(`No project file to save edits into (${projectPathFor(videoPath, engine)} missing)`)
  }
  project.edit = edit
  project.videoPath = videoPath
  await saveProject(project, engine)
  return project
}
