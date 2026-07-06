import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { extractAudio, ffprobeJson } from './media'
import { runTool } from './ffmpeg'
import { CHUNK_TARGET_BYTES, parseSilences, planChunks, stitchSegments, stitchWords, type TimeRange } from './chunking'
import { transcribeAudioFile, type TranscribeOptions, type WhisperResult } from './whisper'
import { ensureModel, parseWhisperCppJson, transcribeLocalFile } from './whisper-local'
import { fingerprintOf, saveProject } from './project'
import { whisperCostUsd } from '../shared/format'
import type { Project, TranscribeEngine, TranscribeProgress, Transcript } from '../shared/types'

export interface TranscribeDeps {
  cacheDir: string
  /** Where local whisper.cpp models live (downloaded on first use). */
  modelsDir: string
  engine: TranscribeEngine
  /** Required for the 'api' engine; unused for 'local'. */
  apiKey: string | null
  onProgress: (p: TranscribeProgress) => void
  whisperOptions?: TranscribeOptions
}

/** Full pipeline: extract audio → transcribe (API or local whisper.cpp) → saved project. */
export async function transcribeVideo(videoPath: string, deps: TranscribeDeps): Promise<Project> {
  const { engine, onProgress } = deps

  onProgress({ stage: 'extracting', message: 'Extracting audio…', fraction: 0.02 })
  const { audioPath, sizeBytes } = await extractAudio(videoPath, deps.cacheDir, engine === 'local' ? 'wav' : 'm4a')

  const audioProbe = await ffprobeJson(audioPath)
  const durationSec = Number(audioProbe.format?.duration ?? 0)
  if (durationSec <= 0) throw new Error(`Could not read audio duration of ${audioPath}`)

  const partial =
    engine === 'local'
      ? await localTranscript(audioPath, durationSec, deps)
      : await apiTranscript(audioPath, sizeBytes, durationSec, deps)

  onProgress({ stage: 'saving', message: 'Saving project…', fraction: 0.97 })
  const transcript: Transcript = { durationSec, createdAt: new Date().toISOString(), ...partial }

  const project: Project = {
    version: 1,
    videoPath,
    fingerprint: await fingerprintOf(videoPath),
    transcript,
    edit: null,
    updatedAt: new Date().toISOString()
  }
  await saveProject(project, engine)

  onProgress({ stage: 'done', message: `Transcribed ${transcript.words.length} words`, fraction: 1 })
  return project
}

type TranscriptBody = Omit<Transcript, 'durationSec' | 'createdAt'>

/** whisper-1 API path: chunk under the 25 MB upload limit, stitch results. */
async function apiTranscript(
  audioPath: string,
  sizeBytes: number,
  durationSec: number,
  deps: TranscribeDeps
): Promise<TranscriptBody> {
  const { apiKey, onProgress, whisperOptions } = deps
  if (!apiKey) throw new Error('No OpenAI API key configured — set OPENAI_API_KEY or save a key in the app')

  let silences: TimeRange[] = []
  if (sizeBytes > CHUNK_TARGET_BYTES) {
    onProgress({ stage: 'analyzing', message: 'Finding silence points for chunking…', fraction: 0.1 })
    silences = await detectSilences(audioPath, 0.4)
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

  return {
    language: results[0]?.language ?? 'unknown',
    model: 'whisper-1',
    costUsd: whisperCostUsd(durationSec),
    words: stitchWords(results.map((r, i) => ({ offset: chunks[i].start, words: r.words }))),
    segments: stitchSegments(results.map((r, i) => ({ offset: chunks[i].start, segments: r.segments })))
  }
}

/**
 * Local whisper.cpp path: no upload limit, so no chunking — one pass over the
 * whole wav. Detected silences also repair the coarse token end timestamps
 * (see whisper-local.ts snapToSilences).
 */
async function localTranscript(audioPath: string, durationSec: number, deps: TranscribeDeps): Promise<TranscriptBody> {
  const { modelsDir, onProgress } = deps

  const modelPath = await ensureModel(modelsDir, (fraction) =>
    onProgress({
      stage: 'extracting',
      message: `Downloading Whisper model (${Math.round(fraction * 100)}%)…`,
      fraction: 0.04 + 0.1 * fraction
    })
  )

  onProgress({ stage: 'analyzing', message: 'Measuring silences…', fraction: 0.16 })
  const silences = await detectSilences(audioPath, 0.25)

  onProgress({ stage: 'transcribing', message: 'Transcribing with whisper.cpp…', fraction: 0.18 })
  const json = await transcribeLocalFile(audioPath, modelPath, (sec) =>
    onProgress({
      stage: 'transcribing',
      message: `Transcribing with whisper.cpp (${Math.round((sec / durationSec) * 100)}%)…`,
      fraction: 0.18 + 0.77 * Math.min(1, sec / durationSec)
    })
  )

  const result = parseWhisperCppJson(json, silences)
  return {
    language: result.language,
    model: `whisper.cpp ${basename(modelPath).replace(/^ggml-|\.bin$/g, '')}`,
    words: result.words.map((w) => ({ text: w.word, start: w.start, end: w.end })),
    segments: result.segments
  }
}

async function detectSilences(audioPath: string, minSec: number): Promise<TimeRange[]> {
  const { stderr } = await runTool('ffmpeg', [
    '-i', audioPath,
    '-af', `silencedetect=noise=-35dB:d=${minSec}`,
    '-f', 'null', '-'
  ])
  return parseSilences(stderr)
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
