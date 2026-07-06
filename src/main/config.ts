import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ApiKeyStatus } from '../shared/types'

/**
 * Minimal .env loader (KEY=VALUE lines, optional quotes/`export`, # comments).
 * Existing process.env entries always win. Missing file is not an error.
 */
export function loadEnvFile(path: string): void {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return
  }
  for (const line of raw.split('\n')) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!(match[1] in process.env)) process.env[match[1]] = value
  }
}

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

/**
 * Remove the stored key (recover from a typo'd/revoked key, or wipe it off a
 * shared machine). Only touches the config file — a key coming from the
 * OPENAI_API_KEY env var still wins and cannot be cleared from the app.
 */
export async function clearApiKey(configDir: string): Promise<ApiKeyStatus> {
  const config = await readConfig(configDir)
  delete config.openaiApiKey
  await mkdir(configDir, { recursive: true })
  await writeFile(configPath(configDir), JSON.stringify(config, null, 2), { mode: 0o600 })
  return getApiKeyStatus(configDir)
}
