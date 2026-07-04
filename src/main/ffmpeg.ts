import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

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
    throw new Error(`${tool} failed (args: ${args.join(' ')}):\n${detail}`)
  }
}
