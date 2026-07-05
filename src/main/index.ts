import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { basename, dirname, join } from 'node:path'
import { exportMedia, type ExportFormat } from './export'
import type { TimeRange } from '../shared/edit'
import { computePeaks, ensurePreviewProxy, extractAudio, ffprobeJson, probeVideo } from './media'
import { startMediaServer, type MediaServer } from './media-server'
import { getApiKey, getApiKeyStatus, loadEnvFile, setApiKey } from './config'
import { loadProject, saveProject } from './project'
import type { EditState } from '../shared/edit'
import { transcribeVideo } from './transcribe'
import { getLogPath, initLogger, log, logError } from './logger'
import { fmtDuration, whisperCostUsd } from '../shared/format'
import { IPC, type TranscribeProgress } from '../shared/types'

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

  mediaServer = await startMediaServer()
  const cacheDir = join(app.getPath('userData'), 'cache')

  handleIpc(IPC.appInfo, async () => ({ logPath: getLogPath(), mediaBaseUrl: mediaServer!.baseUrl }))

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

  handleIpc(IPC.projectLoad, async (_event, videoPath: string) => loadProject(videoPath))

  handleIpc(IPC.projectSaveEdit, async (_event, videoPath: string, edit: EditState) => {
    const project = await loadProject(videoPath)
    if (!project) throw new Error(`No project file to save edits into (${videoPath}.poddie.json missing)`)
    project.edit = edit
    await saveProject(project)
    log('info', 'edit', `saved: ${edit.items.filter((i) => i.removed).length} of ${edit.items.length} items removed`)
  })

  handleIpc(IPC.transcribeStart, async (event, videoPath: string) => {
    const { key } = await getApiKey(app.getPath('userData'))
    if (!key) throw new Error('No OpenAI API key configured — set OPENAI_API_KEY or save a key in the app')

    // Cost gate at the API boundary: nothing reaches OpenAI without an explicit OK.
    const durationSec = Number((await ffprobeJson(videoPath)).format?.duration ?? 0)
    const existing = await loadProject(videoPath)
    const win = BrowserWindow.fromWebContents(event.sender)
    const { response } = await dialog.showMessageBox(win!, {
      type: 'question',
      buttons: ['Cancel', 'Transcribe'],
      defaultId: 1,
      cancelId: 0,
      message: `Send ${fmtDuration(durationSec)} of audio to OpenAI Whisper?`,
      detail:
        `Estimated cost: $${whisperCostUsd(durationSec).toFixed(2)} ($0.006/min).` +
        (existing?.transcript ? '\n\nThis will REPLACE the existing transcript and reset any edits.' : '')
    })
    if (response !== 1) return null

    log('info', 'transcribe', `start ${videoPath}`)
    return transcribeVideo(videoPath, {
      cacheDir,
      apiKey: key,
      onProgress: (p: TranscribeProgress) => {
        log('info', 'transcribe', `${p.stage} ${Math.round(p.fraction * 100)}% ${p.message}`)
        if (!event.sender.isDestroyed()) event.sender.send(IPC.transcribeProgress, p)
      }
    })
  })

  handleIpc(IPC.exportStart, async (event, videoPath: string, ranges: TimeRange[], kind: 'video' | 'audio') => {
    if (exportAbort) throw new Error('An export is already running')
    if (!Array.isArray(ranges) || ranges.length === 0) throw new Error('Nothing to export: every range was cut')

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

    exportAbort = new AbortController()
    exportFraction = 0
    log('info', 'export', `start: ${videoPath} → ${outPath} (${format}, ${ranges.length} ranges)`)
    try {
      await exportMedia(videoPath, ranges, outPath, format, {
        signal: exportAbort.signal,
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

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  mediaServer?.close()
  if (process.platform !== 'darwin') app.quit()
})
