import { spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, readFile, rename, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { isCjk } from '../shared/cjk'
import type { LocalWhisperStatus } from '../shared/types'
import type { TimeRange } from './chunking'
import { resolveTool } from './ffmpeg'
import { log } from './logger'
import type { WhisperResult, WhisperSegment, WhisperWord } from './whisper'

export const LOCAL_MODEL_FILE = 'ggml-large-v3-turbo.bin'
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${LOCAL_MODEL_FILE}`
// A truncated download or an HTML error page is far below this; the real model is ~1.6 GB.
const MODEL_MIN_BYTES = 1_000_000_000

/** Words this close (or overlapping) are contiguous speech, not a gap. */
const MIN_GAP_SEC = 0.05
const MIN_WORD_SEC = 0.02

// ---------------------------------------------------------------------------
// whisper-cli JSON (-ojf) → WhisperResult, all pure and unit-tested
// ---------------------------------------------------------------------------

interface CppToken {
  text: string
  offsets: { from: number; to: number }
  /** DTW-refined token time in CENTIseconds; -1 when DTW was disabled. */
  t_dtw?: number
}

interface CppSegment {
  text: string
  offsets: { from: number; to: number }
  tokens?: CppToken[]
}

export interface CppJson {
  result?: { language?: string }
  transcription?: CppSegment[]
}

/** Timestamp markers like [_TT_422] / [_BEG_] — not speech. */
const SPECIAL_TOKEN = /^\[_.*\]$/
/** No letter, digit, or ideograph — punctuation attaches to the previous word. */
const NO_WORD_CHAR = /^[^\p{L}\p{N}]*$/u

function tokenStartSec(tok: CppToken): number {
  const dtw = tok.t_dtw ?? -1
  return dtw >= 0 ? dtw / 100 : tok.offsets.from / 1000
}

/**
 * Rebuild words from BPE tokens. Whisper marks Latin word boundaries with a
 * leading space; CJK has no spaces, so any CJK boundary splits too (matching
 * the one-token-per-char shape the whisper-1 API produces). '�' byte fragments
 * and bare punctuation always attach to the previous word.
 */
function wordsFromTokens(segments: CppSegment[]): WhisperWord[] {
  const words: WhisperWord[] = []
  for (const seg of segments) {
    for (const tok of seg.tokens ?? []) {
      const text = tok.text
      if (SPECIAL_TOKEN.test(text)) continue
      const attach =
        text.includes('�') ||
        NO_WORD_CHAR.test(text) ||
        (words.length > 0 &&
          !text.startsWith(' ') &&
          !isCjk(text.trimStart().slice(0, 1)) &&
          !isCjk(words[words.length - 1].word.slice(-1)))
      if (attach && words.length > 0) {
        const prev = words[words.length - 1]
        prev.word += text.trimEnd()
        prev.end = Math.max(prev.end, tok.offsets.to / 1000)
      } else {
        words.push({ word: text.trim(), start: tokenStartSec(tok), end: tok.offsets.to / 1000 })
      }
    }
  }
  return words.filter((w) => w.word !== '')
}

/**
 * Token end offsets are coarse and often truncate a word early, leaving fake
 * inter-word "gaps" in the middle of continuous speech — auto-trim would cut
 * audible words there. Real silences (ffmpeg silencedetect on the same audio)
 * arbitrate: a gap with no detected silence inside is bridged away, and a real
 * gap is snapped to the measured silence bounds. Validated on real footage:
 * fake ≥0.75 s gaps went from 11 per 3 min to ~0 (see findings.md).
 */
function snapToSilences(words: WhisperWord[], silences: TimeRange[]): WhisperWord[] {
  for (let i = 0; i + 1 < words.length; i++) {
    const a = words[i]
    const b = words[i + 1]
    if (b.start - a.end < MIN_GAP_SEC) continue
    const inside = silences.filter((s) => Math.min(s.end, b.start) - Math.max(s.start, a.end) > 0)
    if (inside.length === 0) {
      a.end = b.start
      continue
    }
    a.end = Math.max(a.start + MIN_WORD_SEC, Math.min(...inside.map((s) => s.start)))
    b.start = Math.min(b.end - MIN_WORD_SEC, Math.max(a.end, ...inside.map((s) => s.end)))
  }
  return words
}

export function parseWhisperCppJson(json: CppJson, silences: TimeRange[]): WhisperResult {
  const segments: WhisperSegment[] = (json.transcription ?? [])
    .map((s) => ({ text: s.text.trim(), start: s.offsets.from / 1000, end: s.offsets.to / 1000 }))
    .filter((s) => s.text !== '')

  const words = wordsFromTokens(json.transcription ?? [])
  // a word never overlaps its successor, and always keeps a positive span
  for (let i = 0; i + 1 < words.length; i++) {
    words[i].end = Math.max(words[i].start + MIN_WORD_SEC, Math.min(words[i].end, words[i + 1].start))
  }
  snapToSilences(words, silences)

  const last = segments[segments.length - 1]
  return {
    text: segments.map((s) => s.text).join(' '),
    language: json.result?.language ?? 'unknown',
    duration: last ? last.end : 0,
    words,
    segments
  }
}

/** ggml model filename → whisper.cpp DTW preset; null (no refined timestamps) for unknown models. */
export function dtwPresetFor(modelPath: string): string | null {
  const m = basename(modelPath).match(/^ggml-(tiny|base|small|medium|large-v[123](?:-turbo)?)(\.en)?(?:[.-]|$)/)
  if (!m) return null
  return m[1].replace(/-/g, '.') + (m[2] ?? '')
}

// ---------------------------------------------------------------------------
// side effects: probe, model download, whisper-cli spawn
// ---------------------------------------------------------------------------

export function modelPathIn(modelsDir: string): string {
  return process.env.PODDIE_WHISPER_MODEL ?? join(modelsDir, LOCAL_MODEL_FILE)
}

export async function probeLocalWhisper(modelsDir: string): Promise<LocalWhisperStatus> {
  try {
    await resolveTool('whisper-cli')
  } catch {
    return { available: false, hint: 'Install whisper.cpp first: brew install whisper-cpp', modelPresent: false }
  }
  return { available: true, hint: null, modelPresent: existsSync(modelPathIn(modelsDir)) }
}

/** Download the model on first use (.part + rename, like every other artifact we write). */
export async function ensureModel(modelsDir: string, onProgress: (fraction: number) => void): Promise<string> {
  const modelPath = modelPathIn(modelsDir)
  if (existsSync(modelPath)) return modelPath

  await mkdir(modelsDir, { recursive: true })
  log('info', 'whisper-local', `downloading ${MODEL_URL} → ${modelPath}`)
  const res = await fetch(MODEL_URL)
  if (!res.ok || !res.body) {
    throw new Error(`Model download failed (HTTP ${res.status}): ${MODEL_URL}`)
  }
  const total = Number(res.headers.get('content-length') ?? 0)
  let received = 0
  const partPath = `${modelPath}.part`
  try {
    const progress = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength
        if (total > 0) onProgress(received / total)
        controller.enqueue(chunk)
      }
    })
    const body = res.body.pipeThrough(progress) as unknown as import('node:stream/web').ReadableStream
    await pipeline(Readable.fromWeb(body), createWriteStream(partPath))
    if (received < MODEL_MIN_BYTES) {
      throw new Error(`Model download came out too small (${received} bytes) — not a ggml model`)
    }
    await rename(partPath, modelPath)
  } catch (err) {
    await unlink(partPath).catch(() => {})
    throw err
  }
  return modelPath
}

// `-pp` progress lines land on stderr, which is unbuffered — stdout segment
// lines arrive in multi-minute block-buffered bursts when piped (looked hung).
const STDERR_PROGRESS = /whisper_print_progress_callback: progress\s*=\s*(\d+)%/g

/**
 * Run whisper-cli over a wav and return its raw JSON. `-nfa` is mandatory:
 * flash attention (default on) silently disables DTW word timestamps, and the
 * coarse fallback drifts past our cut padding (measured — see findings.md).
 */
export async function transcribeLocalFile(
  wavPath: string,
  modelPath: string,
  onProgress: (fraction: number) => void
): Promise<CppJson> {
  const bin = await resolveTool('whisper-cli')
  const outBase = `${wavPath}.transcript`
  const args = ['-m', modelPath, '-f', wavPath, '-l', 'auto', '-ojf', '-of', outBase, '-nfa', '-pp']
  const dtw = dtwPresetFor(modelPath)
  if (dtw) {
    args.push('--dtw', dtw)
  } else {
    log('warn', 'whisper-local', `no DTW preset for ${basename(modelPath)} — word timing will be coarse`)
  }

  log('info', 'whisper-local', `${bin} ${args.join(' ')}`)
  await new Promise<void>((resolve, reject) => {
    // stdout is discarded (segments come from the JSON file); leaving it piped
    // but unread would fill the 64 KB pipe buffer and deadlock the child.
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderrTail = ''
    child.stderr.on('data', (d: Buffer) => {
      const chunk = d.toString()
      stderrTail = (stderrTail + chunk).slice(-2000)
      for (const m of chunk.matchAll(STDERR_PROGRESS)) {
        onProgress(Number(m[1]) / 100)
      }
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`whisper-cli exited with code ${code}:\n${stderrTail}`))
    })
  })

  const raw = await readFile(`${outBase}.json`, 'utf8')
  await unlink(`${outBase}.json`).catch(() => {})
  return JSON.parse(raw) as CppJson
}
