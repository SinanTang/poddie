import { joinTokens } from '../shared/cjk'
import type { LlmConfig } from './config'
import { log } from './logger'
import type { ChapterAnalysis, LocalLlmStatus, TranscriptSegment, TranscriptWord } from '../shared/types'
import { normalizeChapters } from '../shared/chapters'

export async function probeLocalLlm(cfg: LlmConfig): Promise<LocalLlmStatus> {
  try {
    const res = await fetch(`${cfg.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) {
      return { available: false, hint: `Ollama server responded with HTTP ${res.status} — is it running?`, modelPresent: false }
    }
    const data = (await res.json()) as { models?: { name: string }[] }
    const models = data.models ?? []
    const present = models.some((m) => m.name === cfg.model || m.name.startsWith(`${cfg.model}:`))
    return {
      available: true,
      hint: present ? null : `Run "ollama pull ${cfg.model}" to download the model`,
      modelPresent: present
    }
  } catch {
    return { available: false, hint: 'Install Ollama (https://ollama.com) and run "ollama serve"', modelPresent: false }
  }
}

interface ChatResult {
  content: string
  wallSec: number
}

async function chat(cfg: LlmConfig, system: string, user: string, schema: object): Promise<ChatResult> {
  const t0 = Date.now()
  const res = await fetch(`${cfg.ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(600_000),
    body: JSON.stringify({
      model: cfg.model,
      stream: false,
      think: false,
      format: schema,
      options: { temperature: 0, num_ctx: 32768 },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    })
  })
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as { message?: { content?: string } }
  return { content: data.message?.content ?? '', wallSec: (Date.now() - t0) / 1000 }
}

// ---------------------------------------------------------------------------
// Chapter analysis
// ---------------------------------------------------------------------------

function chapterSystemPrompt(durationSec: number): string {
  return `You are a podcast editor. Given a verbatim transcript with timestamps, identify the narrative structure as a story arc.

The full episode is ${Math.round(durationSec)} seconds long. Your chapters MUST span the entire episode from 0 to ${Math.round(durationSec)} seconds — do not stop early.

Break the episode into 3-6 main chapters that follow the natural storyline (e.g. "How it started", "The turning point", "What I learned"). Each main chapter contains 2-5 subchapters — the concrete topics discussed within that arc.

For every subchapter, write:
- "title": a short, natural title (how a human would name it in show notes)
- "summary": one sentence saying what's discussed
- "editorialVerdict": concise editorial verdict (under 12 words) that helps the editor decide whether to KEEP or CUT this subchapter. Compare against the other subchapters — what makes this one essential, redundant, or weak? Focus on unique value, audience impact, or structural role. Examples: "Core origin story — can't cut without losing the thread", "Same validation point as ch1 sub3, keep the stronger one", "Interesting but tangential — safe to cut for time", "The emotional climax, strongest moment in the episode", "Generic advice, nothing the audience hasn't heard".
- "startTime" / "endTime": timestamps in seconds, matching the transcript timestamps

Return JSON matching the schema. Use the transcript's language for titles and summaries. Do not translate or rewrite the transcript.`
}

const CHAPTER_SCHEMA = {
  type: 'object',
  properties: {
    chapters: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          startTime: { type: 'number' },
          endTime: { type: 'number' },
          summary: { type: 'string' },
          subchapters: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                startTime: { type: 'number' },
                endTime: { type: 'number' },
                summary: { type: 'string' },
                editorialVerdict: { type: 'string' }
              },
              required: ['title', 'startTime', 'endTime', 'summary', 'editorialVerdict']
            }
          }
        },
        required: ['title', 'startTime', 'endTime', 'summary', 'subchapters']
      }
    }
  },
  required: ['chapters']
} as const

function buildTranscriptText(words: TranscriptWord[], segments: TranscriptSegment[]): string {
  const segWords: string[][] = segments.map(() => [])
  let seg = 0
  for (const w of words) {
    while (seg + 1 < segments.length && w.start >= segments[seg + 1].start) seg++
    segWords[seg].push(w.text)
  }
  return segments
    .map((s, i) => {
      const text = joinTokens(segWords[i])
      return text ? `[${Math.round(s.start)}s] ${text}` : ''
    })
    .filter(Boolean)
    .join('\n')
}

export async function analyzeChapters(
  cfg: LlmConfig,
  words: TranscriptWord[],
  segments: TranscriptSegment[],
  durationSec: number
): Promise<ChapterAnalysis> {
  const transcript = buildTranscriptText(words, segments)
  log('info', 'llm', `chapter analysis (${cfg.model}): ${words.length} words, ${segments.length} segments, ${transcript.length} chars, ${Math.round(durationSec)}s`)

  const { content, wallSec } = await chat(cfg, chapterSystemPrompt(durationSec), transcript, CHAPTER_SCHEMA)
  log('info', 'llm', `chapter analysis complete in ${wallSec.toFixed(1)}s`)

  const parsed = JSON.parse(content) as { chapters: ChapterAnalysis['chapters'] }
  if (!Array.isArray(parsed.chapters) || parsed.chapters.length === 0) {
    throw new Error('LLM returned no chapters')
  }

  for (const ch of parsed.chapters) {
    for (const sub of ch.subchapters) {
      sub.kept = true
    }
  }

  // The model is told to span the whole episode and does not reliably obey,
  // so the timeline is rebuilt from start times rather than trusted.
  const chapters = normalizeChapters(parsed.chapters, durationSec)
  if (chapters.length === 0) throw new Error('LLM returned no usable chapter timings')
  const covered = chapters.reduce((acc, ch) => acc + (ch.endTime - ch.startTime), 0)
  log('info', 'llm', `chapters normalized: ${chapters.length} covering ${Math.round(covered)}s of ${Math.round(durationSec)}s`)

  return { chapters, model: cfg.model, createdAt: new Date().toISOString() }
}
