import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MAX_LOG_BYTES = 5 * 1024 * 1024

let logFile = ''

type Level = 'info' | 'warn' | 'error'

/**
 * Dead-simple session logger: human-readable lines to console AND a file the
 * user (or Claude) can read when something misbehaves. Rotates once at startup.
 */
export function initLogger(logDir: string): string {
  mkdirSync(logDir, { recursive: true })
  logFile = join(logDir, 'poddie.log')
  try {
    if (statSync(logFile).size > MAX_LOG_BYTES) renameSync(logFile, `${logFile}.1`)
  } catch {
    // no previous log — fine
  }
  log('info', 'app', `--- session start pid=${process.pid} ---`)
  return logFile
}

export function getLogPath(): string {
  return logFile
}

export function log(level: Level, scope: string, message: string): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`
  console[level === 'info' ? 'log' : level](line)
  if (logFile) {
    try {
      appendFileSync(logFile, line + '\n')
    } catch {
      // never let logging take the app down
    }
  }
}

export function logError(scope: string, err: unknown): void {
  log('error', scope, err instanceof Error ? (err.stack ?? err.message) : String(err))
}
