import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import icon from '../../resources/icon.png?asset'
import { exportMedia, type ExportFormat } from './export'
import { hasFilter } from './ffmpeg'
import type { TimeRange } from '../shared/edit'
import { computePeaks, ensurePreviewProxy, extractAudio, ffprobeJson, probeVideo } from './media'
import { startMediaServer, type MediaServer } from './media-server'
import { clearApiKey, getApiKey, getApiKeyStatus, loadEnvFile, setApiKey } from './config'
import { loadProject, projectPathFor, saveProject } from './project'
import type { EditState } from '../shared/edit'
import { transcribeVideo } from './transcribe'
import { modelPathIn, probeLocalWhisper } from './whisper-local'
import { getLogPath, initLogger, log, logError } from './logger'
import { fmtDuration, whisperCostUsd } from '../shared/format'
import { IPC, type TranscribeEngine, type TranscribeProgress } from '../shared/types'

// In dev, app path is the project root — picks up the user's .env (OPENAI_API_KEY)
loadEnvFile(join(app.getAppPath(), '.env'))

let mediaServer: MediaServer | null = null
let exportAbort: AbortController | null = null
// Latest export completion [0,1], polled by the renderer via invoke (robust to
// renderer reloads, unlike a captured event.sender.send).
let exportFraction = 0

/** ipcMain.handle wrapper: every handler failure lands in the log with its channel. */
function handleIpc(channel: string, fn: (event: IpcMainInvokeEvent, ...args: never[]) => Promise<unknown>): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await fn(event, ...(args as never[]))
    } catch (err) {
      logError(`ipc:${channel}`, err)
      throw err
    }
  })
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Poddie',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  initLogger(join(app.getPath('userData'), 'logs'))
  process.on('uncaughtException', (err) => logError('uncaught', err))
  process.on('unhandledRejection', (reason) => logError('unhandled-rejection', reason))

  // Packaged builds get their icon from the bundle's icon.icns; only the dev
  // dock needs setting explicitly (BrowserWindow's `icon` option is ignored on
  // macOS). Cosmetic — must never abort startup: a missing icon file once left
  // the packaged app running but windowless (see task_plan errors table).
  if (!app.isPackaged) {
    try {
      app.dock?.setIcon(icon)
    } catch (err) {
      logError('dock-icon', err)
    }
  }

  mediaServer = await startMediaServer()
  const cacheDir = join(app.getPath('userData'), 'cache')
  const modelsDir = join(app.getPath('userData'), 'models')
  // homebrew's current ffmpeg bottle lacks libass — probe instead of assuming
  const canBurnCaptions = await hasFilter('subtitles').catch(() => false)
  if (!canBurnCaptions) log('info', 'captions', 'ffmpeg lacks the subtitles filter (libass) — burn-in disabled')
  const localWhisper = await probeLocalWhisper(modelsDir)
  if (!localWhisper.available) log('info', 'whisper-local', `local transcription disabled: ${localWhisper.hint}`)

  // engine comes over IPC — normalize instead of trusting the wire
  const asEngine = (engine: unknown): TranscribeEngine => (engine === 'local' ? 'local' : 'api')

  handleIpc(IPC.appInfo, async () => ({
    logPath: getLogPath(),
    mediaBaseUrl: mediaServer!.baseUrl,
    canBurnCaptions,
    // modelPresent flips after the first in-app download — re-probe per call
    localWhisper: localWhisper.available ? await probeLocalWhisper(modelsDir) : localWhisper
  }))

  handleIpc(IPC.selectVideo, async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Videos', extensions: ['mov', 'mp4', 'm4v'] }]
    })
    if (canceled || filePaths.length === 0) return null
    log('info', 'video', `open ${filePaths[0]}`)
    return probeVideo(filePaths[0])
  })

  handleIpc(IPC.extractAudio, async (_event, videoPath: string) => extractAudio(videoPath, cacheDir))

  handleIpc(IPC.proxyEnsure, async (event, videoPath: string) => {
    return ensurePreviewProxy(videoPath, cacheDir, (fraction) => {
      if (!event.sender.isDestroyed()) event.sender.send(IPC.proxyProgress, fraction)
    })
  })

  handleIpc(IPC.audioPeaks, async (_event, videoPath: string) => {
    const { audioPath } = await extractAudio(videoPath, cacheDir)
    return computePeaks(audioPath)
  })

  handleIpc(IPC.apiKeyStatus, async () => getApiKeyStatus(app.getPath('userData')))

  handleIpc(IPC.apiKeySet, async (_event, key: string) => setApiKey(app.getPath('userData'), key))

  handleIpc(IPC.apiKeyClear, async () => clearApiKey(app.getPath('userData')))

  handleIpc(IPC.projectLoad, async (_event, videoPath: string, engine?: TranscribeEngine) =>
    loadProject(videoPath, asEngine(engine))
  )

  handleIpc(IPC.projectSaveEdit, async (_event, videoPath: string, edit: EditState, engine?: TranscribeEngine) => {
    const project = await loadProject(videoPath, asEngine(engine))
    if (!project) throw new Error(`No project file to save edits into (${projectPathFor(videoPath, asEngine(engine))} missing)`)
    project.edit = edit
    await saveProject(project, asEngine(engine))
    log('info', 'edit', `saved: ${edit.items.filter((i) => i.removed).length} of ${edit.items.length} items removed`)
  })

  handleIpc(IPC.transcribeStart, async (event, videoPath: string, engineArg?: TranscribeEngine) => {
    const engine = asEngine(engineArg)
    const key = engine === 'api' ? (await getApiKey(app.getPath('userData'))).key : null
    if (engine === 'api' && !key) {
      throw new Error('No OpenAI API key configured — set OPENAI_API_KEY or save a key in the app')
    }

    // Confirmation gate: cost for the API (nothing reaches OpenAI without an
    // explicit OK), time + model download for local — and either way, a
    // REPLACE warning when that engine's transcript already exists.
    const durationSec = Number((await ffprobeJson(videoPath)).format?.duration ?? 0)
    const existing = await loadProject(videoPath, engine)
    const replaceNote = existing?.transcript ? '\n\nThis will REPLACE the existing transcript and reset any edits.' : ''
    const win = BrowserWindow.fromWebContents(event.sender)
    const { response } = await dialog.showMessageBox(win!, {
      type: 'question',
      buttons: ['Cancel', 'Transcribe'],
      defaultId: 1,
      cancelId: 0,
      message:
        engine === 'local'
          ? `Transcribe ${fmtDuration(durationSec)} locally with whisper.cpp?`
          : `Send ${fmtDuration(durationSec)} of audio to OpenAI Whisper?`,
      detail:
        engine === 'local'
          ? `Free, runs on this Mac (roughly ${fmtDuration(durationSec / 4)}) — audio never leaves your computer.` +
            (existsSync(modelPathIn(modelsDir)) ? '' : '\n\nFirst run downloads the Whisper model (~1.6 GB).') +
            replaceNote
          : `Estimated cost: $${whisperCostUsd(durationSec).toFixed(2)} ($0.006/min).` + replaceNote
    })
    if (response !== 1) return null

    log('info', 'transcribe', `start ${videoPath} (${engine})`)
    return transcribeVideo(videoPath, {
      cacheDir,
      modelsDir,
      engine,
      apiKey: key,
      onProgress: (p: TranscribeProgress) => {
        log('info', 'transcribe', `${p.stage} ${Math.round(p.fraction * 100)}% ${p.message}`)
        if (!event.sender.isDestroyed()) event.sender.send(IPC.transcribeProgress, p)
      }
    })
  })

  handleIpc(IPC.exportStart, async (event, videoPath: string, ranges: TimeRange[], kind: 'video' | 'audio', burnInSrt?: string) => {
    if (exportAbort) throw new Error('An export is already running')
    if (!Array.isArray(ranges) || ranges.length === 0) throw new Error('Nothing to export: every range was cut')
    if (burnInSrt && !canBurnCaptions) {
      throw new Error('Caption burn-in needs an ffmpeg build with libass (the subtitles filter)')
    }

    const win = BrowserWindow.fromWebContents(event.sender)
    const stem = basename(videoPath).replace(/\.[^.]+$/, '')
    const audio = kind === 'audio'
    const { canceled, filePath: outPath } = await dialog.showSaveDialog(win!, {
      defaultPath: join(dirname(videoPath), `${stem}-edited.${audio ? 'm4a' : 'mp4'}`),
      // for audio, the dialog's format dropdown picks the container
      filters: audio
        ? [
            { name: 'M4A Audio (AAC)', extensions: ['m4a'] },
            { name: 'MP3 Audio', extensions: ['mp3'] }
          ]
        : [{ name: 'MP4 Video', extensions: ['mp4'] }]
    })
    if (canceled || !outPath) return null
    const format: ExportFormat = audio ? (outPath.toLowerCase().endsWith('.mp3') ? 'mp3' : 'm4a') : 'mp4'

    let subtitlesPath: string | undefined
    if (burnInSrt && kind === 'video') {
      subtitlesPath = join(cacheDir, 'burn-in.srt')
      await mkdir(cacheDir, { recursive: true })
      await writeFile(subtitlesPath, burnInSrt, 'utf8')
    }

    exportAbort = new AbortController()
    exportFraction = 0
    log('info', 'export', `start: ${videoPath} → ${outPath} (${format}${subtitlesPath ? ' +captions' : ''}, ${ranges.length} ranges)`)
    try {
      await exportMedia(videoPath, ranges, outPath, format, {
        signal: exportAbort.signal,
        subtitlesPath,
        onProgress: (fraction) => {
          exportFraction = fraction
        }
      })
      return { outPath }
    } catch (err) {
      if (exportAbort.signal.aborted) return null
      throw err
    } finally {
      exportAbort = null
    }
  })

  handleIpc(IPC.exportPoll, async () => exportFraction)

  handleIpc(IPC.exportCancel, async () => {
    exportAbort?.abort()
  })

  handleIpc(IPC.exportReveal, async (_event, path: string) => {
    shell.showItemInFolder(path)
  })

  handleIpc(IPC.captionsExport, async (event, videoPath: string, srt: string) => {
    if (!srt) throw new Error('No captions to export: every word is cut or blank')
    const win = BrowserWindow.fromWebContents(event.sender)
    const stem = basename(videoPath).replace(/\.[^.]+$/, '')
    const { canceled, filePath: outPath } = await dialog.showSaveDialog(win!, {
      defaultPath: join(dirname(videoPath), `${stem}-edited.srt`),
      filters: [{ name: 'SubRip Captions', extensions: ['srt'] }]
    })
    if (canceled || !outPath) return null
    await writeFile(outPath, srt, 'utf8')
    log('info', 'captions', `SRT written: ${outPath} (${srt.length} bytes)`)
    return { outPath }
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// The media server's lifetime matches the APP, not the window: on macOS the
// app outlives its last window, and `activate` recreates windows whose <video>
// still points at the server. Closing it here once left every post-reactivate
// window with a dead player (see task_plan errors table). Teardown is in
// will-quit, which the non-darwin app.quit() path reaches too.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  mediaServer?.close()
})
