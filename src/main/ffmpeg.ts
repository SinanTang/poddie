import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { log } from './logger'

const execFileAsync = promisify(execFile)

type Tool = 'ffmpeg' | 'ffprobe'

const resolved = new Map<Tool, string>()

/**
 * Locate a working binary. GUI-launched Electron apps don't inherit the
 * shell PATH on macOS, so we probe the common homebrew locations explicitly.
 * Override with PODDIE_FFMPEG / PODDIE_FFPROBE if needed.
 */
export async function resolveTool(tool: Tool): Promise<string> {
  const cached = resolved.get(tool)
  if (cached) return cached

  const override = process.env[`PODDIE_${tool.toUpperCase()}`]
  const candidates = [override, `/opt/homebrew/bin/${tool}`, `/usr/local/bin/${tool}`, tool].filter(
    (c): c is string => Boolean(c)
  )
  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, ['-version'])
      resolved.set(tool, candidate)
      return candidate
    } catch {
      // try the next candidate
    }
  }
  throw new Error(`${tool} not found (tried: ${candidates.join(', ')}). Install with: brew install ffmpeg`)
}

export async function runTool(tool: Tool, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const bin = await resolveTool(tool)
  try {
    return await execFileAsync(bin, args, { maxBuffer: 64 * 1024 * 1024 })
  } catch (err) {
    const e = err as Error & { stderr?: string }
    const detail = (e.stderr ?? e.message).slice(-2000)
    log('error', tool, `failed: ${tool} ${args.join(' ')}\n${detail}`)
    throw new Error(`${tool} failed (args: ${args.join(' ')}):\n${detail}`)
  }
}

/** Like runTool but returns raw stdout bytes (e.g. PCM decode for peaks). */
export async function runToolBuffer(tool: Tool, args: string[]): Promise<Buffer> {
  const bin = await resolveTool(tool)
  try {
    const { stdout } = await execFileAsync(bin, args, { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 })
    return stdout
  } catch (err) {
    const e = err as Error & { stderr?: Buffer }
    const detail = (e.stderr?.toString() ?? e.message).slice(-2000)
    throw new Error(`${tool} failed (args: ${args.join(' ')}):\n${detail}`)
  }
}

/**
 * Run ffmpeg with `-progress` streaming, reporting completion as a fraction of
 * `durationSec`. For long re-encodes (preview proxy, export).
 */
export async function runToolProgress(
  tool: Tool,
  args: string[],
  durationSec: number,
  onProgress: (fraction: number) => void
): Promise<void> {
  const bin = await resolveTool(tool)
  log('info', tool, `long run: ${tool} ${args.join(' ')}`)
  return new Promise((resolve, reject) => {
    // -progress/-nostats are global options, so prepending is safe
    const child = spawn(bin, ['-progress', 'pipe:1', '-nostats', ...args])
    let stderrTail = ''
    child.stderr.on('data', (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-2000)
    })
    child.stdout.on('data', (d: Buffer) => {
      for (const line of d.toString().split('\n')) {
        const m = line.match(/^out_time_us=(\d+)/)
        if (m && durationSec > 0) onProgress(Math.min(1, Number(m[1]) / 1e6 / durationSec))
      }
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        log('error', tool, `exited ${code}: ${tool} ${args.join(' ')}\n${stderrTail}`)
        reject(new Error(`${tool} exited with code ${code}:\n${stderrTail}`))
      }
    })
  })
}
