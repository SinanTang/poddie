import { readFile, rename, stat, writeFile } from 'node:fs/promises'
import type { Project, VideoFingerprint } from '../shared/types'

export function projectPathFor(videoPath: string): string {
  return `${videoPath}.poddie.json`
}

export async function fingerprintOf(videoPath: string): Promise<VideoFingerprint> {
  const s = await stat(videoPath)
  return { sizeBytes: s.size, mtimeMs: s.mtimeMs }
}

/** Returns null when no project file exists; throws on a corrupt one. */
export async function loadProject(videoPath: string): Promise<Project | null> {
  let raw: string
  try {
    raw = await readFile(projectPathFor(videoPath), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  const project = JSON.parse(raw) as Project
  if (project.version !== 1) {
    throw new Error(`Unsupported project version ${String(project.version)} in ${projectPathFor(videoPath)}`)
  }
  return project
}

/** Atomic write (temp + rename) so a crash can't corrupt an existing project. */
export async function saveProject(project: Project): Promise<void> {
  const path = projectPathFor(project.videoPath)
  const updated: Project = { ...project, updatedAt: new Date().toISOString() }
  const tmpPath = `${path}.tmp`
  await writeFile(tmpPath, JSON.stringify(updated, null, 1), 'utf8')
  await rename(tmpPath, path)
}
