import { afterEach, beforeAll, describe, expect, test } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnvFile } from '../src/main/config'

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
