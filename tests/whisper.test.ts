import { beforeAll, describe, expect, test } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transcribeAudioFile, type FetchLike } from '../src/main/whisper'

const tmp = fileURLToPath(new URL('.tmp-whisper', import.meta.url))
const audioPath = join(tmp, 'audio.m4a')

const VERBOSE_JSON = {
  text: 'Hello world',
  language: 'english',
  duration: 1.4,
  words: [
    { word: 'Hello', start: 0.5, end: 0.9 },
    { word: 'world', start: 1.0, end: 1.4 }
  ],
  segments: [{ text: ' Hello world ', start: 0.5, end: 1.4 }]
}

function fakeFetch(responses: Array<{ status: number; body: unknown }>): { fetch: FetchLike; calls: number[] } {
  const calls: number[] = []
  const fetch: FetchLike = async () => {
    const next = responses[Math.min(calls.length, responses.length - 1)]
    calls.push(next.status)
    return new Response(JSON.stringify(next.body), { status: next.status })
  }
  return { fetch, calls }
}

beforeAll(async () => {
  await rm(tmp, { recursive: true, force: true })
  await mkdir(tmp, { recursive: true })
  await writeFile(audioPath, 'fake audio bytes')
})

describe('transcribeAudioFile', () => {
  test('maps verbose_json into words and trimmed segments', async () => {
    const { fetch } = fakeFetch([{ status: 200, body: VERBOSE_JSON }])
    const result = await transcribeAudioFile(audioPath, 'sk-test', { fetchImpl: fetch })
    expect(result.language).toBe('english')
    expect(result.words).toHaveLength(2)
    expect(result.words[0]).toEqual({ word: 'Hello', start: 0.5, end: 0.9 })
    expect(result.segments[0].text).toBe('Hello world')
  })

  test('retries on 429 then succeeds', async () => {
    const { fetch, calls } = fakeFetch([
      { status: 429, body: { error: 'rate limited' } },
      { status: 200, body: VERBOSE_JSON }
    ])
    const result = await transcribeAudioFile(audioPath, 'sk-test', { fetchImpl: fetch, retryDelaysMs: [0, 0] })
    expect(calls).toEqual([429, 200])
    expect(result.text).toBe('Hello world')
  })

  test('fails immediately on a non-retryable status like 401', async () => {
    const { fetch, calls } = fakeFetch([{ status: 401, body: { error: 'bad key' } }])
    await expect(
      transcribeAudioFile(audioPath, 'sk-bad', { fetchImpl: fetch, retryDelaysMs: [0, 0] })
    ).rejects.toThrow(/401/)
    expect(calls).toEqual([401])
  })

  test('gives up after exhausting retries on 5xx', async () => {
    const { fetch, calls } = fakeFetch([{ status: 503, body: { error: 'down' } }])
    await expect(
      transcribeAudioFile(audioPath, 'sk-test', { fetchImpl: fetch, retryDelaysMs: [0, 0] })
    ).rejects.toThrow(/503/)
    expect(calls).toEqual([503, 503, 503])
  })
})
