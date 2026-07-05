import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ApiKeyStatus } from '../shared/types'

interface AppConfig {
  openaiApiKey?: string
}

function configPath(configDir: string): string {
  return join(configDir, 'config.json')
}

async function readConfig(configDir: string): Promise<AppConfig> {
  try {
    return JSON.parse(await readFile(configPath(configDir), 'utf8')) as AppConfig
  } catch {
    return {}
  }
}

/** Env var wins over the stored key so the config file can never shadow it. */
export async function getApiKey(configDir: string): Promise<{ key: string | null; source: ApiKeyStatus['source'] }> {
  const envKey = process.env.OPENAI_API_KEY
  if (envKey) return { key: envKey, source: 'env' }
  const stored = (await readConfig(configDir)).openaiApiKey
  if (stored) return { key: stored, source: 'config' }
  return { key: null, source: null }
}

export async function getApiKeyStatus(configDir: string): Promise<ApiKeyStatus> {
  const { key, source } = await getApiKey(configDir)
  return { present: key !== null, source }
}

export async function setApiKey(configDir: string, key: string): Promise<ApiKeyStatus> {
  const trimmed = key.trim()
  if (!/^sk-[\w-]{10,}$/.test(trimmed)) {
    throw new Error('That does not look like an OpenAI API key (expected sk-…)')
  }
  await mkdir(configDir, { recursive: true })
  const config = await readConfig(configDir)
  config.openaiApiKey = trimmed
  await writeFile(configPath(configDir), JSON.stringify(config, null, 2), { mode: 0o600 })
  return getApiKeyStatus(configDir)
}
