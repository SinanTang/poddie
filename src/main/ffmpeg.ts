import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { log } from './logger'

const execFileAsync = promisify(execFile)

type Tool = 'ffmpeg' | 'ffprobe' | 'whisper-cli'

const VERSION_ARG: Record<Tool, string> = { ffmpeg: '-version', ffprobe: '-version', 'whisper-cli': '--version' }
const INSTALL_HINT: Record<Tool, string> = {
  ffmpeg: 'brew install ffmpeg',
  ffprobe: 'brew install ffmpeg',
  'whisper-cli': 'brew install whisper-cpp'
}

const resolved = new Map<Tool, string>()

/**
 * Locate a working binary. GUI-launched Electron apps don't inherit the
 * shell PATH on macOS, so we probe the common homebrew locations explicitly.
 * ffmpeg-full (keg-only, never in /opt/homebrew/bin) is preferred when
 * installed: same codecs plus libass, which caption burn-in needs and the
 * regular bottle lacks. Override with PODDIE_FFMPEG / PODDIE_FFPROBE /
 * PODDIE_WHISPER_CLI. Every candidate gets a version health check — a binary
 * that exists but can't launch (broken dylib) must not win.
 */
export async function resolveTool(tool: Tool): Promise<string> {
  const cached = resolved.get(tool)
  if (cached) return cached

  const override = process.env[`PODDIE_${tool.toUpperCase().replace(/-/g, '_')}`]
  const candidates = [
    override,
    `/opt/homebrew/opt/ffmpeg-full/bin/${tool}`,
    `/opt/homebrew/bin/${tool}`,
    `/usr/local/bin/${tool}`,
    tool
  ].filter((c): c is string => Boolean(c))
  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, [VERSION_ARG[tool]])
      resolved.set(tool, candidate)
      return candidate
    } catch {
      // try the next candidate
    }
  }
  throw new Error(`${tool} not found (tried: ${candidates.join(', ')}). Install with: ${INSTALL_HINT[tool]}`)
}

let filterNames: Set<string> | null = null

/**
 * Whether this ffmpeg build has a filter (e.g. `subtitles` needs libass,
 * which homebrew's current bottle omits). Probed once, cached.
 */
export async function hasFilter(name: string): Promise<boolean> {
  if (!filterNames) {
    const { stdout } = await runTool('ffmpeg', ['-hide_banner', '-filters'])
    // filter table lines look like " T.C subtitles VV->V  Render text subtitles…"
    filterNames = new Set(
      stdout
        .split('\n')
        .map((line) => line.trim().split(/\s+/)[1])
        .filter(Boolean)
    )
  }
  return filterNames.has(name)
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
 * `durationSec`. For long re-encodes (preview proxy, export). An aborted
 * signal kills the child and rejects with an AbortError.
 */
export async function runToolProgress(
  tool: Tool,
  args: string[],
  durationSec: number,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal
): Promise<void> {
  const bin = await resolveTool(tool)
  log('info', tool, `long run: ${tool} ${args.join(' ')}`)
  return new Promise((resolve, reject) => {
    // -progress/-nostats are global options, so prepending is safe
    const child = spawn(bin, ['-progress', 'pipe:1', '-nostats', ...args], { signal })
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
