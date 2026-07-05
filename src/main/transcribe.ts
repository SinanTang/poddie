import { stat } from 'node:fs/promises'
import { extractAudio, ffprobeJson } from './media'
import { runTool } from './ffmpeg'
import { CHUNK_TARGET_BYTES, parseSilences, planChunks, stitchSegments, stitchWords, type TimeRange } from './chunking'
import { transcribeAudioFile, type TranscribeOptions, type WhisperResult } from './whisper'
import { fingerprintOf, saveProject } from './project'
import type { Project, TranscribeProgress, Transcript } from '../shared/types'

export interface TranscribeDeps {
  cacheDir: string
  apiKey: string
  onProgress: (p: TranscribeProgress) => void
  whisperOptions?: TranscribeOptions
}

/** Full pipeline: extract audio → chunk if needed → Whisper per chunk → stitched transcript → saved project. */
export async function transcribeVideo(videoPath: string, deps: TranscribeDeps): Promise<Project> {
  const { cacheDir, apiKey, onProgress, whisperOptions } = deps

  onProgress({ stage: 'extracting', message: 'Extracting audio…', fraction: 0.02 })
  const { audioPath, sizeBytes } = await extractAudio(videoPath, cacheDir)

  const audioProbe = await ffprobeJson(audioPath)
  const durationSec = Number(audioProbe.format?.duration ?? 0)
  if (durationSec <= 0) throw new Error(`Could not read audio duration of ${audioPath}`)

  let silences: TimeRange[] = []
  if (sizeBytes > CHUNK_TARGET_BYTES) {
    onProgress({ stage: 'analyzing', message: 'Finding silence points for chunking…', fraction: 0.1 })
    const { stderr } = await runTool('ffmpeg', ['-i', audioPath, '-af', 'silencedetect=noise=-35dB:d=0.4', '-f', 'null', '-'])
    silences = parseSilences(stderr)
  }
  const chunks = planChunks(durationSec, sizeBytes, silences)

  const results: WhisperResult[] = []
  for (let i = 0; i < chunks.length; i++) {
    const label = chunks.length > 1 ? ` (part ${i + 1}/${chunks.length})` : ''
    onProgress({
      stage: 'transcribing',
      message: `Transcribing with Whisper${label}…`,
      fraction: 0.15 + 0.8 * (i / chunks.length)
    })
    const chunkPath = chunks.length === 1 ? audioPath : await cutChunk(audioPath, chunks[i], i)
    results.push(await transcribeAudioFile(chunkPath, apiKey, whisperOptions))
  }

  onProgress({ stage: 'saving', message: 'Saving project…', fraction: 0.97 })
  const transcript: Transcript = {
    language: results[0]?.language ?? 'unknown',
    durationSec,
    model: 'whisper-1',
    createdAt: new Date().toISOString(),
    words: stitchWords(results.map((r, i) => ({ offset: chunks[i].start, words: r.words }))),
    segments: stitchSegments(results.map((r, i) => ({ offset: chunks[i].start, segments: r.segments })))
  }

  const project: Project = {
    version: 1,
    videoPath,
    fingerprint: await fingerprintOf(videoPath),
    transcript,
    updatedAt: new Date().toISOString()
  }
  await saveProject(project)

  onProgress({ stage: 'done', message: `Transcribed ${transcript.words.length} words`, fraction: 1 })
  return project
}

/** Stream-copy a chunk out of the master m4a (packet-boundary precision, ~20 ms — fine for chunk seams in silence). */
async function cutChunk(audioPath: string, range: TimeRange, index: number): Promise<string> {
  const chunkPath = `${audioPath}.chunk${index}.m4a`
  await runTool('ffmpeg', [
    '-y',
    '-ss', String(range.start),
    '-t', String(range.end - range.start),
    '-i', audioPath,
    '-c', 'copy',
    chunkPath
  ])
  const s = await stat(chunkPath)
  if (s.size === 0) throw new Error(`Chunk ${index} came out empty (${chunkPath})`)
  return chunkPath
}
