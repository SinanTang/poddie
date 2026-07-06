import { afterEach, beforeAll, describe, expect, test } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clearApiKey, getApiKeyStatus, loadEnvFile, setApiKey } from '../src/main/config'

const tmp = fileURLToPath(new URL('.tmp-config', import.meta.url))

beforeAll(async () => {
  await rm(tmp, { recursive: true, force: true })
  await mkdir(tmp, { recursive: true })
})

afterEach(() => {
  delete process.env.PODDIE_TEST_A
  delete process.env.PODDIE_TEST_B
})

describe('loadEnvFile', () => {
  test('sets variables, strips quotes, skips comments, never overrides', async () => {
    const envPath = join(tmp, '.env')
    await writeFile(
      envPath,
      ['# comment', 'PODDIE_TEST_A="quoted value"', 'export PODDIE_TEST_B=plain', ''].join('\n')
    )
    process.env.PODDIE_TEST_B = 'preexisting'

    loadEnvFile(envPath)
    expect(process.env.PODDIE_TEST_A).toBe('quoted value')
    expect(process.env.PODDIE_TEST_B).toBe('preexisting')
  })

  test('missing file is a no-op', () => {
    expect(() => loadEnvFile(join(tmp, 'nope.env'))).not.toThrow()
  })
})

describe('api key store', () => {
  // env var wins over the stored key everywhere, so keep it unset in this suite
  afterEach(() => delete process.env.OPENAI_API_KEY)

  test('rejects anything that is not sk-shaped', async () => {
    const dir = join(tmp, 'keys-reject')
    await expect(setApiKey(dir, 'not-a-key')).rejects.toThrow(/OpenAI API key/)
    expect((await getApiKeyStatus(dir)).present).toBe(false)
  })

  test('save then clear round-trips (recover from a bad key)', async () => {
    const dir = join(tmp, 'keys-roundtrip')
    const saved = await setApiKey(dir, '  sk-abcdef0123456789  ') // trims whitespace
    expect(saved).toEqual({ present: true, source: 'config' })

    const cleared = await clearApiKey(dir)
    expect(cleared).toEqual({ present: false, source: null })
  })

  test('env key wins over a stored key and cannot be cleared from disk', async () => {
    const dir = join(tmp, 'keys-env')
    await setApiKey(dir, 'sk-storedkey0123456789')
    process.env.OPENAI_API_KEY = 'sk-envkey0123456789'
    expect(await getApiKeyStatus(dir)).toEqual({ present: true, source: 'env' })
    // clearApiKey only removes the stored key; env still wins
    expect((await clearApiKey(dir)).source).toBe('env')
  })
})
