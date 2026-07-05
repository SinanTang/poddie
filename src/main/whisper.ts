import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

export interface WhisperWord {
  word: string
  start: number
  end: number
}

export interface WhisperSegment {
  text: string
  start: number
  end: number
}

export interface WhisperResult {
  text: string
  language: string
  duration: number
  words: WhisperWord[]
  segments: WhisperSegment[]
}

interface WhisperVerboseJson {
  text?: string
  language?: string
  duration?: number
  words?: Array<{ word?: string; start?: number; end?: number }>
  segments?: Array<{ text?: string; start?: number; end?: number }>
}

export type FetchLike = typeof fetch

export interface TranscribeOptions {
  fetchImpl?: FetchLike
  /** Backoff before each retry; length = max retries. Injectable for tests. */
  retryDelaysMs?: number[]
  timeoutMs?: number
}

const API_URL = 'https://api.openai.com/v1/audio/transcriptions'
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

/**
 * Transcribe one audio file (< 25 MB) with word-level timestamps.
 * Only whisper-1 supports word granularity — the gpt-4o transcribe
 * models don't return word timestamps.
 */
export async function transcribeAudioFile(
  audioPath: string,
  apiKey: string,
  options: TranscribeOptions = {}
): Promise<WhisperResult> {
  const { fetchImpl = fetch, retryDelaysMs = [2_000, 8_000], timeoutMs = 600_000 } = options
  const data = await readFile(audioPath)

  let lastError = new Error('transcription not attempted')
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    if (attempt > 0) await sleep(retryDelaysMs[attempt - 1])

    // FormData bodies are consumed on send — rebuild per attempt
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(data)], { type: 'audio/mp4' }), basename(audioPath))
    form.append('model', 'whisper-1')
    form.append('response_format', 'verbose_json')
    form.append('timestamp_granularities[]', 'word')
    form.append('timestamp_granularities[]', 'segment')

    let res: Response
    try {
      res = await fetchImpl(API_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch (err) {
      lastError = new Error(`Whisper API network error: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }

    if (res.ok) {
      return mapResult((await res.json()) as WhisperVerboseJson)
    }

    const body = (await res.text()).slice(0, 500)
    lastError = new Error(`Whisper API error ${res.status}: ${body}`)
    if (!RETRYABLE_STATUS.has(res.status)) throw lastError
  }
  throw lastError
}

function mapResult(json: WhisperVerboseJson): WhisperResult {
  return {
    text: json.text ?? '',
    language: json.language ?? 'unknown',
    duration: Number(json.duration ?? 0),
    words: (json.words ?? []).map((w) => ({
      word: String(w.word ?? ''),
      start: Number(w.start ?? 0),
      end: Number(w.end ?? 0)
    })),
    segments: (json.segments ?? []).map((s) => ({
      text: String(s.text ?? '').trim(),
      start: Number(s.start ?? 0),
      end: Number(s.end ?? 0)
    }))
  }
}
