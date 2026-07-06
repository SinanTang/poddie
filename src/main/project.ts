import { readFile, rename, stat, writeFile } from 'node:fs/promises'
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
